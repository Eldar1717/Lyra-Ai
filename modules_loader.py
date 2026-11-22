"""Подключение модулей из папки modules/.

Модуль — это папка с файлом module.json:

    modules/<id>/module.json     паспорт модуля (название, описание, входной файл)
    modules/<id>/index.html      страница модуля, открывается по /modules/<id>/
    modules/<id>/backend.py      необязательно: функция handle(action, data) для /api/<id>

Сервер находит модули сам при первом обращении: достаточно положить папку — модуль
появится в списке. Включение и выключение хранится в data/modules.json.

Модули — это обычный локальный код с теми же правами, что и сервер Лиры. Ставьте
только те модули, которым доверяете: изоляции и песочницы здесь нет.
"""
import importlib.util
import json
import os
import re
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODULES_DIR = ROOT / 'modules'
STATE_PATH = ROOT / 'data' / 'modules.json'
BACKEND = 'backend.py'
ID_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{0,31}$')
MAX_MODULES = 64


class Modules:
    def __init__(self, directory=None, state_path=None):
        self.dir = Path(directory or MODULES_DIR)
        self.state_path = Path(state_path or STATE_PATH)
        self.lock = threading.Lock()
        self._backends = {}

    # ---------- состояние ----------
    def _state(self):
        try:
            raw = json.loads(self.state_path.read_text('utf-8'))
            return raw if isinstance(raw, dict) else {}
        except (FileNotFoundError, ValueError, OSError):
            return {}

    def _enabled_map(self, state):
        rows = state.get('modules')
        return rows if isinstance(rows, dict) else {}

    def _save(self, state):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix('.tmp')
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), 'utf-8')
        os.replace(tmp, self.state_path)

    # ---------- обнаружение ----------
    def directory(self, mid):
        if not isinstance(mid, str) or not ID_RE.match(mid):
            raise ValueError('Некорректный идентификатор модуля.')
        folder = (self.dir / mid).resolve()
        if folder.parent != self.dir.resolve():
            raise ValueError('Модуль вне папки modules.')
        return folder

    def manifest(self, mid):
        folder = self.directory(mid)
        try:
            data = json.loads((folder / 'module.json').read_text('utf-8'))
        except FileNotFoundError:
            raise ValueError('В папке модуля нет module.json.') from None
        except (ValueError, OSError):
            raise ValueError('module.json модуля «%s» повреждён.' % mid) from None
        if not isinstance(data, dict):
            raise ValueError('module.json должен быть объектом.')
        if data.get('id') != mid:
            raise ValueError('В module.json указан другой id: %r.' % data.get('id'))
        entry = data.get('entry') or 'index.html'
        if not isinstance(entry, str) or not entry or '/' in entry or '\\' in entry:
            raise ValueError('Некорректный entry в module.json.')
        if not (folder / entry).is_file():
            raise ValueError('Нет входного файла %s.' % entry)
        manifest = {
            'id': mid,
            'name': str(data.get('name') or mid)[:80],
            'short': str(data.get('short') or data.get('name') or mid)[:24],
            'version': str(data.get('version') or '')[:24],
            'description': str(data.get('description') or '')[:600],
            'details': str(data.get('details') or '')[:600],
            'tags': [str(t)[:24] for t in (data.get('tags') or [])][:8] if isinstance(data.get('tags'), list) else [],
            'icon': str(data.get('icon') or 'module')[:24],
            'api': data.get('api') is True,
            'requires': [str(t)[:40] for t in (data.get('requires') or [])][:6]
            if isinstance(data.get('requires'), list)
            else [],
            'enabledByDefault': data.get('enabledByDefault') is not False,
            'entry': entry,
        }
        has_backend = (folder / BACKEND).is_file()
        manifest['backend'] = has_backend
        manifest['api'] = manifest['api'] and has_backend
        manifest['url'] = '/modules/%s/' % mid
        return manifest

    def discover(self):
        if not self.dir.is_dir():
            return []
        found = []
        for folder in sorted(self.dir.iterdir()):
            if not folder.is_dir() or not ID_RE.match(folder.name):
                continue
            if not (folder / 'module.json').is_file():
                continue
            try:
                found.append(self.manifest(folder.name))
            except ValueError:
                continue
            if len(found) >= MAX_MODULES:
                break
        return found

    def is_enabled(self, mid):
        try:
            manifest = self.manifest(mid)
        except ValueError:
            return False
        state = self._state()
        current = self._enabled_map(state).get(mid)
        return manifest['enabledByDefault'] if current is None else bool(current)

    def set_enabled(self, mid, on):
        manifest = self.manifest(mid)  # проверяет id и наличие файлов
        with self.lock:
            state = self._state()
            rows = self._enabled_map(state)
            rows[mid] = bool(on)
            state['modules'] = rows
            self._save(state)
        return self.info(manifest)

    def info(self, manifest):
        return {**manifest, 'enabled': self.is_enabled(manifest['id'])}

    def list(self):
        return {'modules': [self.info(m) for m in self.discover()]}

    # ---------- серверная часть модуля ----------
    def backend(self, mid):
        manifest = self.manifest(mid)
        if not manifest['backend']:
            raise ValueError('У модуля нет серверной части.')
        cached = self._backends.get(mid)
        if cached:
            return cached
        path = self.directory(mid) / BACKEND
        spec = importlib.util.spec_from_file_location('lyra_module_%s' % mid, path)
        if spec is None or spec.loader is None:
            raise ValueError('Не удалось загрузить backend.py модуля «%s».' % mid)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if not callable(getattr(module, 'handle', None)):
            raise ValueError('В backend.py модуля «%s» нет функции handle(action, data).' % mid)
        self._backends[mid] = module
        return module

    def handle_api(self, mid, data):
        if not self.is_enabled(mid):
            raise PermissionError('Модуль «%s» выключен.' % mid)
        if not isinstance(data, dict):
            raise ValueError('Некорректный запрос модуля.')
        return self.backend(mid).handle(data.get('action'), data)

    # ---------- маршрут /api/modules ----------
    def handle(self, data):
        action = data.get('action') if isinstance(data, dict) else None
        if action in (None, 'list'):
            return self.list()
        if action in ('enable', 'disable'):
            mid = data.get('id')
            if not isinstance(mid, str):
                raise ValueError('Укажите id модуля.')
            result = self.set_enabled(mid, action == 'enable')
            return {'module': result}
        raise ValueError('Нет такого действия.')


def serve_file(mid, rest, modules):
    """Проверяет, можно ли отдать статичный файл модуля. Возвращает True, если отдаём."""
    if not modules.is_enabled(mid):
        return False
    if rest.endswith('.py') or rest.endswith('.tmp') or '/.' in '/%s' % rest:
        return False  # исходники серверной части и служебные файлы наружу не отдаём
    folder = modules.directory(mid)
    target = (folder / rest.lstrip('/')).resolve() if rest else folder
    try:
        target.relative_to(folder)
    except ValueError:
        return False
    return True
