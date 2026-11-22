import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import server
from modules_loader import Modules, serve_file

MANIFEST = {
    'id': 'demo',
    'name': 'Демонстрационный модуль',
    'version': '0.1',
    'description': 'Проверка загрузчика модулей.',
    'entry': 'index.html',
    'api': True,
    'enabledByDefault': False,
}


def make_module(root, mid='demo', manifest=None, entry='<h1>ok</h1>', backend=None):
    folder = Path(root) / mid
    folder.mkdir(parents=True, exist_ok=True)
    if manifest is not None:
        (folder / 'module.json').write_text(json.dumps(manifest, ensure_ascii=False), 'utf-8')
    if entry is not None:
        (folder / 'index.html').write_text(entry, 'utf-8')
    if backend is not None:
        (folder / 'backend.py').write_text(backend, 'utf-8')
    return folder


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.dir = Path(self.td.name) / 'modules'
        self.dir.mkdir()
        self.state = Path(self.td.name) / 'data' / 'modules.json'

    def modules(self):
        return Modules(directory=self.dir, state_path=self.state)

    def test_finds_folders_and_skips_garbage(self):
        make_module(self.dir, 'demo', MANIFEST)
        make_module(self.dir, 'nomanifest', None)
        (self.dir / 'README.md').write_text('файл, не папка', 'utf-8')
        found = self.modules().list()['modules']
        self.assertEqual([m['id'] for m in found], ['demo'])
        self.assertFalse(found[0]['enabled'])  # enabledByDefault: false
        self.assertEqual(found[0]['url'], '/modules/demo/')
        self.assertEqual(found[0]['entry'], 'index.html')

    def test_broken_manifests_are_ignored(self):
        make_module(self.dir, 'wrongid', {**MANIFEST, 'id': 'other'})
        make_module(self.dir, 'noentry', {**MANIFEST, 'id': 'noentry'}, entry=None)
        (self.dir / 'badjson').mkdir()
        (self.dir / 'badjson' / 'module.json').write_text('{oops', 'utf-8')
        make_module(self.dir, 'escape', {**MANIFEST, 'id': 'escape', 'entry': '../secret.html'})
        self.assertEqual(self.modules().list()['modules'], [])

    def test_real_vakhta_module_is_visible(self):
        found = Modules().list()['modules']
        vakhta = [m for m in found if m['id'] == 'vakhta']
        self.assertEqual(len(vakhta), 1)
        self.assertTrue(vakhta[0]['api'])
        self.assertTrue(vakhta[0]['enabled'])
        self.assertIn('вахтёр', vakhta[0]['name'].lower())

    def test_enable_disable_persists(self):
        make_module(self.dir, 'demo', MANIFEST)
        modules = self.modules()
        self.assertFalse(modules.is_enabled('demo'))
        modules.set_enabled('demo', True)
        self.assertTrue(self.modules().is_enabled('demo'))  # переживает перезапуск
        self.assertEqual(json.loads(self.state.read_text('utf-8'))['modules'], {'demo': True})
        modules.handle({'action': 'disable', 'id': 'demo'})
        self.assertFalse(self.modules().is_enabled('demo'))

    def test_unknown_and_bad_ids(self):
        modules = self.modules()
        for bad in ('../etc', 'UPPER', 'нет', '', 'a' * 40, None):
            with self.assertRaises(ValueError):
                modules.directory(bad)
        with self.assertRaises(ValueError):
            modules.set_enabled('missing', True)
        with self.assertRaises(ValueError):
            modules.handle({'action': 'nope'})
        self.assertFalse(modules.is_enabled('missing'))

    def test_static_files_and_traversal(self):
        make_module(self.dir, 'demo', MANIFEST, entry='<h1>ok</h1>',
                    backend='def handle(action, data):\n    return {"action": action}\n')
        modules = self.modules()
        self.assertFalse(serve_file('demo', '', modules))  # выключен — не отдаём
        modules.set_enabled('demo', True)
        self.assertTrue(serve_file('demo', '', modules))
        self.assertTrue(serve_file('demo', 'index.html', modules))
        self.assertFalse(serve_file('demo', 'backend.py', modules))  # исходники наружу нельзя
        self.assertFalse(serve_file('demo', '../vakhta/index.html', modules))
        self.assertFalse(serve_file('demo', '../../etc/passwd', modules))
        self.assertFalse(serve_file('nope', 'index.html', modules))

    def test_backend_api_respects_switch(self):
        backend = (
            'calls = []\n'
            'def handle(action, data):\n'
            '    if action == "boom":\n'
            '        raise ValueError("сломалось")\n'
            '    return {"echo": action, "value": data.get("value")}\n'
        )
        make_module(self.dir, 'demo', MANIFEST, backend=backend)
        modules = self.modules()
        with self.assertRaises(PermissionError):
            modules.handle_api('demo', {'action': 'ping'})
        modules.set_enabled('demo', True)
        self.assertEqual(modules.handle_api('demo', {'action': 'ping'}), {'echo': 'ping', 'value': None})
        with self.assertRaises(ValueError):
            modules.handle_api('demo', {'action': 'boom'})
        with self.assertRaises(ValueError):
            modules.handle_api('demo', ['не объект'])

    def test_module_without_backend_has_no_api(self):
        make_module(self.dir, 'demo', MANIFEST)  # api: true, но backend.py нет
        modules = self.modules()
        modules.set_enabled('demo', True)
        self.assertFalse(modules.manifest('demo')['api'])
        with self.assertRaises(ValueError):
            modules.handle_api('demo', {'action': 'ping'})


class HttpTests(unittest.TestCase):
    def test_module_pages_and_api_over_http(self):
        with tempfile.TemporaryDirectory() as td, \
                patch.object(server, 'modules', Modules(state_path=Path(td) / 'modules.json')), \
                __import__('http.server').server.ThreadingHTTPServer(('127.0.0.1', 0), server.App) as http:
            worker = threading.Thread(target=http.serve_forever, daemon=True)
            worker.start()
            base = 'http://127.0.0.1:%s' % http.server_port

            def get(path):
                with urllib.request.urlopen(base + path) as r:
                    return r.status, r.read().decode('utf-8', 'replace')

            def post(path, data):
                req = urllib.request.Request(base + path, data=json.dumps(data).encode(),
                                            headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(req) as r:
                    return r.status, json.load(r)

            def fails(fn, code):
                with self.assertRaises(urllib.error.HTTPError) as err:
                    fn()
                self.assertEqual(err.exception.code, code)

            try:
                code, body = get('/api/modules')
                ids = [m['id'] for m in json.loads(body)['modules']]
                self.assertEqual((code, ids), (200, ['vakhta']))
                # включён по умолчанию: страница, файл модуля и API отвечают
                self.assertEqual(get('/modules/vakhta/')[0], 200)
                self.assertIn('ИИ-ВАХТЁР', get('/modules/vakhta/')[1].upper())
                self.assertEqual(get('/modules/vakhta/module.js')[0], 200)
                code, out = post('/api/vakhta', {'action': 'list'})
                # реестр может быть не пуст: тест не должен зависеть от данных пользователя
                self.assertEqual(code, 200)
                self.assertIsInstance(out.get('residents'), list)
                fails(lambda: get('/modules/vakhta/backend.py'), 404)
                fails(lambda: get('/modules/nope/'), 404)
                fails(lambda: get('/modules/../server.py'), 404)
                # выключение закрывает и страницу, и API
                post('/api/modules', {'action': 'disable', 'id': 'vakhta'})
                self.assertFalse(json.loads(get('/api/modules')[1])['modules'][0]['enabled'])
                fails(lambda: get('/modules/vakhta/'), 404)
                fails(lambda: post('/api/vakhta', {'action': 'list'}), 403)
                post('/api/modules', {'action': 'enable', 'id': 'vakhta'})
                self.assertEqual(post('/api/vakhta', {'action': 'list'})[0], 200)
                fails(lambda: post('/api/modules', {'action': 'enable', 'id': '../..'}), 400)
                fails(lambda: post('/api/modules', {'action': 'what'}), 400)
            finally:
                http.shutdown()
                worker.join()


if __name__ == '__main__':
    unittest.main()
