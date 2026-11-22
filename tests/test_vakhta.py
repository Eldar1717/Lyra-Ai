import json
import random
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from modules_loader import Modules

# backend.py модуля «ИИ-вахтёр» подключается так же, как его подключает сервер Лиры
vakhta = Modules().backend('vakhta')


def vector(seed, noise=0.0, n=128):
    """Стабильный «шаблон лица»: тот же seed — та же основа, noise добавляет сдвиг."""
    base, jitter = random.Random(seed), random.Random(seed + 10_000)
    return [round(base.uniform(-0.3, 0.3) + jitter.gauss(0, noise), 6) for _ in range(n)]


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.path = Path(self.td.name) / 'data' / 'vakhta.json'
        self.store = vakhta.Vakhta(self.path)

    def enroll(self, name, samples, role='resident', flat='42', **kw):
        return self.store.handle('enroll', {'name': name, 'samples': samples, 'role': role, 'flat': flat, **kw})


    def test_enroll_and_identify_resident(self):
        face = vector(1)
        person = self.enroll('Иван Петров', [face, vector(1, 0.004)])['person']
        self.assertEqual(person['samples'], 2)
        self.assertEqual(person['created'][:2], '20')
        found = self.store.handle('identify', {'descriptor': vector(1, 0.006)})
        self.assertEqual(found['status'], 'resident')
        self.assertEqual(found['match']['name'], 'Иван Петров')
        self.assertEqual(found['match']['flat'], '42')
        self.assertLess(found['distance'], 0.30)

    def test_stranger_is_not_matched(self):
        self.enroll('Иван Петров', [vector(1)])
        found = self.store.handle('identify', {'descriptor': vector(99)})
        self.assertEqual(found['status'], 'unknown')
        self.assertIsNone(found['match'])
        self.assertGreater(found['distance'], found['threshold'])

    def test_empty_registry_says_unknown(self):
        found = self.store.handle('identify', {'descriptor': vector(5)})
        self.assertEqual(found, {'status': 'unknown', 'match': None, 'distance': None,
                                 'threshold': vakhta.THRESHOLD, 'registry': 0})

    def test_threshold_is_clamped_and_respected(self):
        face = vector(2)
        self.enroll('Анна', [face])
        stranger = vector(2, 0.05)
        strict = self.store.handle('identify', {'descriptor': stranger, 'threshold': 0.01})
        loose = self.store.handle('identify', {'descriptor': stranger, 'threshold': 5})
        self.assertEqual(strict['threshold'], vakhta.MIN_THRESHOLD)
        self.assertEqual(loose['threshold'], vakhta.MAX_THRESHOLD)
        self.assertEqual(loose['status'], 'resident')

    def test_two_similar_people_are_ambiguous(self):
        self.enroll('Анна', [vector(7)])
        self.enroll('Алла', [vector(7, 0.001)])
        found = self.store.handle('identify', {'descriptor': vector(7, 0.001)})
        self.assertEqual(found['status'], 'ambiguous')
        self.assertIsNone(found['match'])
        self.assertIsNotNone(found['candidate'])

    def test_roles_guest_and_denied(self):
        self.enroll('Анна Смирнова', [vector(11)], role='guest', flat='8')
        self.enroll('Пётр', [vector(12)], role='denied', flat='')
        self.assertEqual(self.store.handle('identify', {'descriptor': vector(11, 0.005)})['status'], 'guest')
        self.assertEqual(self.store.handle('identify', {'descriptor': vector(12, 0.005)})['status'], 'denied')
        with self.assertRaises(ValueError):
            self.enroll('Кто-то', [vector(3)], role='admin')

    def test_bad_descriptors_are_rejected(self):
        for bad in ([1.0] * 127, ['a'] * 128, [0.0] * 128, [float('nan')] + [0.0] * 127, [9.0] * 128, 'x'):
            with self.assertRaises(ValueError):
                self.store.handle('identify', {'descriptor': bad})
        with self.assertRaises(ValueError):
            self.enroll('', [vector(1)])
        with self.assertRaises(ValueError):
            self.enroll('Имя', [])
        with self.assertRaises(ValueError):
            self.enroll('Имя', [vector(1)] * 6)
        with self.assertRaises(ValueError):
            self.enroll('Имя', [vector(1)], flat='квартира "42"')

    def test_update_delete_and_forget(self):
        pid = self.enroll('Иван', [vector(1)])['person']['id']
        self.store.handle('update', {'id': pid, 'name': 'Иван Петров', 'flat': '43'})
        listed = self.store.handle('list', {})['residents']
        self.assertEqual((listed[0]['name'], listed[0]['flat']), ('Иван Петров', '43'))
        self.store.handle('delete', {'id': pid})
        self.assertEqual(self.store.handle('list', {})['residents'], [])
        self.enroll('Анна', [vector(2)])
        self.store.handle('forgetAll', {})
        self.assertEqual(self.store.handle('list', {})['residents'], [])
        with self.assertRaises(ValueError):
            self.store.handle('delete', {'id': 'nope'})

    def test_registry_survives_restart_and_keeps_no_photos(self):
        self.enroll('Иван', [vector(1)])
        raw = self.path.read_text('utf-8')
        again = vakhta.Vakhta(self.path)
        self.assertEqual(len(again.handle('list', {})['residents']), 1)
        self.assertEqual(self.store.handle('identify', {'descriptor': vector(1, 0.004)})['status'], 'resident')
        self.assertTrue(self.path.with_name('vakhta-visits.jsonl').exists() is False)
        self.assertNotIn('data:image', raw)
        self.assertLess(len(raw), 20000)

    def test_pin_protects_writes_only(self):
        with patch.dict(vakhta.os.environ, {'VAKHTA_PIN': '4321'}):
            store = vakhta.Vakhta(self.path)
            with self.assertRaises(ValueError):
                store.handle('enroll', {'name': 'Иван', 'samples': [vector(1)]})
            with self.assertRaises(ValueError):
                store.handle('enroll', {'name': 'Иван', 'samples': [vector(1)], 'pin': '0000'})
            store.handle('enroll', {'name': 'Иван', 'samples': [vector(1)], 'pin': '4321'})
            self.assertEqual(store.handle('identify', {'descriptor': vector(1, 0.004)})['status'], 'resident')

    def photo(self, seed=5, size=64):
        import base64
        import io
        # крошечный валидный JPEG: сервер проверяет только сигнатуру и размер
        data = b'\xff\xd8\xff\xe0' + b'\x00' * size + b'\xff\xd9'
        return 'data:image/jpeg;base64,' + base64.b64encode(data).decode()

    def test_photo_is_stored_and_removed(self):
        pid = self.enroll('Иван', [vector(1)], photo=self.photo())['person']['id']
        self.assertTrue(self.store.handle('list', {})['residents'][0]['hasPhoto'])
        out = self.store.handle('photo', {'id': pid})
        self.assertTrue(out['photo'].startswith('data:image/jpeg;base64,'))
        self.assertTrue((Path(self.td.name) / 'data' / 'vakhta-photos' / (pid + '.jpg')).is_file())
        self.store.handle('delete', {'id': pid})
        self.assertFalse((Path(self.td.name) / 'data' / 'vakhta-photos' / (pid + '.jpg')).exists())
        with self.assertRaises(ValueError):
            self.store.handle('photo', {'id': ''})

    def test_bad_photo_is_rejected(self):
        for bad in ('data:image/png;base64,AAAA', 'data:image/jpeg;base64,not-base64!!',
                    'data:image/jpeg;base64,' + 'A' * 400000, 42):
            with self.assertRaises(ValueError):
                self.store.handle('enroll', {'name': 'Иван', 'samples': [vector(1)], 'photo': bad})

    def test_edit_person_adds_samples_and_changes_photo(self):
        pid = self.enroll('Иван', [vector(1)])['person']['id']
        self.store.handle('update', {'id': pid, 'name': 'Иван Петров', 'flat': '9',
                                     'appendSamples': [vector(1, 0.02)], 'photo': self.photo()})
        person = self.store.handle('list', {})['residents'][0]
        self.assertEqual((person['name'], person['flat'], person['samples'], person['hasPhoto']),
                         ('Иван Петров', '9', 2, True))
        # новый кадр действительно попадает в сравнение
        self.assertEqual(self.store.handle('identify', {'descriptor': vector(1, 0.03)})['status'], 'resident')
        self.store.handle('update', {'id': pid, 'photo': None})
        self.assertFalse(self.store.handle('list', {})['residents'][0]['hasPhoto'])
        self.store.handle('forgetAll', {})
        self.assertEqual(self.store.handle('list', {})['residents'], [])
        self.assertEqual(list((Path(self.td.name) / 'data' / 'vakhta-photos').glob('*.jpg')), [])

    def test_visits_log_and_stats(self):
        self.store.handle('visit', {'kind': 'stranger', 'decision': 'refused', 'note': 'молчал'})
        opened = self.store.handle('unlock', {'kind': 'resident', 'name': 'Иван', 'flat': '42', 'decision': 'open'})
        self.assertEqual(opened['webhook'], 'не настроен')
        rows = self.store.handle('visits', {'limit': 10})['visits']
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['kind'], 'unlock')
        self.assertEqual(rows[0]['decision'], 'open')
        stats = self.store.handle('stats', {})
        self.assertEqual(stats['residents'], 0)
        with self.assertRaises(ValueError):
            self.store.handle('nope', {})


def api_modules(tmp):
    """Реальный загрузчик модулей с временным реестром внутри модуля вахты."""
    modules = Modules(state_path=Path(tmp) / 'modules.json')
    store = vakhta.Vakhta(Path(tmp) / 'vakhta.json')
    modules._backends['vakhta'] = type('Fake', (), {'handle': staticmethod(
        lambda action, data: store.handle(action, data))})
    return modules


class ApiTests(unittest.TestCase):
    def test_http_endpoint(self):
        import threading
        import urllib.error
        import urllib.request
        from http.server import ThreadingHTTPServer

        import server

        with tempfile.TemporaryDirectory() as td, \
                patch.object(server, 'modules', api_modules(Path(td))), \
                ThreadingHTTPServer(('127.0.0.1', 0), server.App) as http:
            worker = threading.Thread(target=http.serve_forever, daemon=True)
            worker.start()

            def post(path, data, headers=None):
                req = urllib.request.Request(
                    'http://127.0.0.1:%s%s' % (http.server_port, path),
                    data=json.dumps(data).encode(),
                    headers={'Content-Type': 'application/json', **(headers or {})})
                with urllib.request.urlopen(req) as r:
                    return r.status, json.load(r)

            try:
                code, out = post('/api/vakhta', {'action': 'enroll', 'name': 'Иван', 'flat': '42',
                                                 'samples': [vector(1)]})
                self.assertEqual(code, 200)
                code, out = post('/api/vakhta', {'action': 'identify', 'descriptor': vector(1, 0.004)})
                self.assertEqual((code, out['status']), (200, 'resident'))
                with self.assertRaises(urllib.error.HTTPError) as err:
                    post('/api/vakhta', {'action': 'identify', 'descriptor': [1.0]})
                self.assertEqual(err.exception.code, 400)
                with self.assertRaises(urllib.error.HTTPError) as err:
                    post('/api/vakhta', {'action': 'nope'})
                self.assertEqual(err.exception.code, 400)
                with self.assertRaises(urllib.error.HTTPError) as err:
                    post('/api/vakhta', {'action': 'identify', 'descriptor': vector(1, 0.004)},
                         {'Origin': 'http://evil.example'})
                self.assertEqual(err.exception.code, 403)
            finally:
                http.shutdown()
                worker.join()


if __name__ == '__main__':
    unittest.main()
