"""Реестр жителей и журнал проходов модуля «ИИ-вахтёр».

Распознавание выполняет браузер (face-api.js, он уже лежит в assets/face):
на сервер приходит только числовой шаблон лица из 128 значений. Фотографии
не передаются и не сохраняются. Сопоставление с реестром делает сервер, чтобы
браузер не получал биометрию всех жителей дома.

Файлы (по умолчанию в data/):
  vakhta.json          — жильцы, гости и нежелательные посетители;
  vakhta-visits.jsonl  — журнал проходов, по одной записи в строке;
  vakhta-photos/<id>.jpg — необязательные миниатюры для редактора жильцов.

Переменные окружения:
  VAKHTA_PIN      — если задан, добавление и удаление жителей требуют этот PIN;
  VAKHTA_WEBHOOK  — необязательный URL, куда сервер шлёт событие открытия двери.
"""
import base64
import binascii
import hmac
import json
import math
import os
import re
import secrets
import threading
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DIM = 128                      # длина шаблона face-api.js
ROLES = ('resident', 'guest', 'denied')
THRESHOLD = 0.52               # порог Евклидова расстояния, как в camera.js Лиры
MIN_THRESHOLD, MAX_THRESHOLD = 0.30, 0.70
MARGIN = 0.06                  # насколько «свой» должен быть ближе второго кандидата
MAX_RESIDENTS = 500
MAX_SAMPLES = 5
MAX_VISITS = 2000
MAX_PHOTO = 90000              # байт на миниатюру: этого хватает на 240×240 JPEG


def photo_bytes(value):
    """Проверяет data URL с JPEG и возвращает байты."""
    if not isinstance(value, str) or not value.startswith('data:image/jpeg;base64,'):
        raise ValueError('Фото должно быть JPEG в виде data URL.')
    raw = value.split(',', 1)[1]
    if not 0 < len(raw) <= MAX_PHOTO * 4 // 3 + 8:
        raise ValueError('Фото слишком большое, уменьшите до 240×240.')
    try:
        data = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError('Фото повреждено.') from None
    if not 0 < len(data) <= MAX_PHOTO:
        raise ValueError('Фото слишком большое, уменьшите до 240×240.')
    if not data.startswith(b'\xff\xd8\xff'):
        raise ValueError('Ожидался JPEG.')
    return data


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def face_vector(value):
    """Проверяет шаблон лица и возвращает список float."""
    if not isinstance(value, (list, tuple)) or len(value) != DIM:
        raise ValueError('Шаблон лица должен состоять из %d чисел.' % DIM)
    out = []
    for v in value:
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or abs(v) > 2:
            raise ValueError('Шаблон лица содержит недопустимое значение.')
        out.append(float(v))
    if not any(out):
        raise ValueError('Пустой шаблон лица.')
    return out


def distance(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def text_value(value, label, limit, required=True):
    if value is None:
        value = ''
    if not isinstance(value, str):
        raise ValueError('%s должен быть строкой.' % label)
    clean = ' '.join(value.split())
    if required and not clean:
        raise ValueError('Укажите %s.' % label)
    if len(clean) > limit:
        raise ValueError('%s длиннее %d символов.' % (label, limit))
    return clean


def flat_value(value):
    clean = text_value(value, 'квартиру', 12, required=False)
    if clean and not re.fullmatch(r'[0-9A-Za-zА-Яа-яЁё][0-9A-Za-zА-Яа-яЁё\-/ ]{0,11}', clean):
        raise ValueError('Номер квартиры может содержать только буквы, цифры, дефис и дробь.')
    return clean


class Vakhta:
    def __init__(self, path=None, log_path=None, photo_dir=None):
        self.path = Path(path or Path('data') / 'vakhta.json')
        self.log_path = Path(log_path or self.path.with_name('vakhta-visits.jsonl'))
        self.photo_dir = Path(photo_dir or self.path.with_name('vakhta-photos'))
        self.lock = threading.Lock()
        self.pin = os.getenv('VAKHTA_PIN', '')
        self.webhook = os.getenv('VAKHTA_WEBHOOK', '')

    # ---------- хранилище ----------
    def _load(self):
        try:
            raw = json.loads(self.path.read_text('utf-8'))
        except FileNotFoundError:
            return {'version': 1, 'residents': []}
        except (OSError, ValueError):
            raise OSError('Файл реестра повреждён. Проверьте %s.' % self.path)
        if not isinstance(raw, dict) or not isinstance(raw.get('residents'), list):
            raise OSError('Файл реестра повреждён. Проверьте %s.' % self.path)
        return raw

    def _save(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix('.tmp')
        tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), 'utf-8')
        os.replace(tmp, self.path)

    def _admin(self, data):
        """Запись в реестр разрешена, если PIN не задан или совпал."""
        if not self.pin:
            return
        given = data.get('pin')
        if not isinstance(given, str) or not hmac.compare_digest(given, self.pin):
            raise ValueError('Неверный PIN администратора вахты.')

    # ---------- чтение ----------
    def _photo_path(self, pid):
        return self.photo_dir / (pid + '.jpg')

    def _public(self, person):
        return {
            'id': person['id'],
            'name': person['name'],
            'flat': person.get('flat', ''),
            'role': person['role'],
            'note': person.get('note', ''),
            'samples': len(person.get('samples', [])),
            'created': person.get('created', ''),
            'hasPhoto': self._photo_path(person['id']).is_file(),
        }

    def _write_photo(self, pid, data):
        self.photo_dir.mkdir(parents=True, exist_ok=True)
        tmp = self._photo_path(pid).with_suffix('.tmp')
        tmp.write_bytes(data)
        os.replace(tmp, self._photo_path(pid))

    def _save_photo(self, pid, photo):
        self._write_photo(pid, photo_bytes(photo))

    def _drop_photo(self, pid):
        try:
            self._photo_path(pid).unlink()
        except FileNotFoundError:
            pass

    def list(self):
        with self.lock:
            return {'residents': [self._public(p) for p in self._load()['residents']]}

    def stats(self):
        rows = self.visits(50)['visits']
        with self.lock:
            people = self._load()['residents']
        return {
            'residents': sum(p['role'] == 'resident' for p in people),
            'guests': sum(p['role'] == 'guest' for p in people),
            'denied': sum(p['role'] == 'denied' for p in people),
            'recent': rows,
        }

    def visits(self, limit=50):
        try:
            lines = self.log_path.read_text('utf-8').splitlines()[-min(int(limit or 50), 500):]
        except FileNotFoundError:
            return {'visits': []}
        except OSError:
            raise OSError('Журнал проходов недоступен. Проверьте папку data.')
        out = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        out.reverse()
        return {'visits': out}

    # ---------- запись ----------
    def enroll(self, data):
        self._admin(data)
        name = text_value(data.get('name'), 'имя', 64)
        flat = flat_value(data.get('flat'))
        role = data.get('role', 'resident')
        if role not in ROLES:
            raise ValueError('Неизвестная роль. Допустимо: resident, guest, denied.')
        note = text_value(data.get('note'), 'примечание', 200, required=False)
        samples = data.get('samples')
        if not isinstance(samples, list) or not 1 <= len(samples) <= MAX_SAMPLES:
            raise ValueError('Нужно от 1 до %d шаблонов лица.' % MAX_SAMPLES)
        vectors = [face_vector(s) for s in samples]
        image = photo_bytes(data['photo']) if data.get('photo') else None
        with self.lock:
            store = self._load()
            if len(store['residents']) >= MAX_RESIDENTS:
                raise ValueError('Реестр заполнен: максимум %d человек.' % MAX_RESIDENTS)
            person = {
                'id': 'p-' + secrets.token_hex(6),
                'name': name,
                'flat': flat,
                'role': role,
                'note': note,
                'created': now_iso(),
                'samples': vectors,
            }
            store['residents'].append(person)
            self._save(store)
            if image:
                self._write_photo(person['id'], image)
        return {'person': self._public(person)}

    def update(self, data):
        self._admin(data)
        pid = text_value(data.get('id'), 'id записи', 40)
        image = photo_bytes(data['photo']) if data.get('photo') else None
        extra = data.get('appendSamples')
        if extra is not None:
            if not isinstance(extra, list) or not 1 <= len(extra) <= MAX_SAMPLES:
                raise ValueError('Нужно от 1 до %d новых шаблонов.' % MAX_SAMPLES)
            extra = [face_vector(s) for s in extra]
        with self.lock:
            store = self._load()
            for person in store['residents']:
                if person['id'] != pid:
                    continue
                if extra:
                    person['samples'] = (person.get('samples') or [])[:MAX_SAMPLES - len(extra)] + extra
                if data.get('samples') is not None:
                    samples = data['samples']
                    if not isinstance(samples, list) or not 1 <= len(samples) <= MAX_SAMPLES:
                        raise ValueError('Нужно от 1 до %d шаблонов лица.' % MAX_SAMPLES)
                    person['samples'] = [face_vector(s) for s in samples]
                if 'name' in data:
                    person['name'] = text_value(data['name'], 'имя', 64)
                if 'flat' in data:
                    person['flat'] = flat_value(data['flat'])
                if 'note' in data:
                    person['note'] = text_value(data['note'], 'примечание', 200, required=False)
                if 'role' in data:
                    if data['role'] not in ROLES:
                        raise ValueError('Неизвестная роль.')
                    person['role'] = data['role']
                self._save(store)
                if image:
                    self._write_photo(pid, image)
                elif data.get('photo') is None and 'photo' in data:
                    self._drop_photo(pid)
                return {'person': self._public(person)}
        raise ValueError('Запись не найдена.')

    def delete(self, data):
        self._admin(data)
        pid = text_value(data.get('id'), 'id записи', 40)
        with self.lock:
            store = self._load()
            left = [p for p in store['residents'] if p['id'] != pid]
            if len(left) == len(store['residents']):
                raise ValueError('Запись не найдена.')
            store['residents'] = left
            self._save(store)
            self._drop_photo(pid)
        return {'deleted': pid}

    def forget_all(self, data):
        """Полное удаление биометрии дома: право жильцов на отзыв данных."""
        self._admin(data)
        with self.lock:
            self._save({'version': 1, 'residents': []})
            for path in self.photo_dir.glob('*.jpg') if self.photo_dir.is_dir() else []:
                try:
                    path.unlink()
                except OSError:
                    pass
        return {'ok': True}

    def photo(self, data):
        """Миниатюра лица для редактора жильцов (только чтение)."""
        pid = text_value(data.get('id'), 'id записи', 40)
        path = self._photo_path(pid)
        try:
            data_bytes = path.read_bytes()
        except FileNotFoundError:
            return {'photo': None}
        except OSError:
            raise OSError('Не удалось прочитать фото из папки data.')
        return {'photo': 'data:image/jpeg;base64,' + base64.b64encode(data_bytes).decode()}

    # ---------- распознавание ----------
    def identify(self, data):
        vector = face_vector(data.get('descriptor'))
        threshold = data.get('threshold', THRESHOLD)
        if isinstance(threshold, bool) or not isinstance(threshold, (int, float)):
            raise ValueError('Порог должен быть числом.')
        threshold = min(max(float(threshold), MIN_THRESHOLD), MAX_THRESHOLD)
        with self.lock:
            people = self._load()['residents']
        scored = []
        for person in people:
            samples = person.get('samples') or []
            if not samples:
                continue
            best = min(distance(vector, s) for s in samples)
            scored.append((best, person))
        scored.sort(key=lambda item: item[0])
        if not scored:
            return {'status': 'unknown', 'match': None, 'distance': None,
                    'threshold': threshold, 'registry': 0}
        best_distance, best_person = scored[0]
        runner_up = scored[1][0] if len(scored) > 1 else None
        ambiguous = (
            runner_up is not None
            and best_distance <= threshold
            and runner_up - best_distance < MARGIN
        )
        if best_distance > threshold:
            status = 'unknown'
        elif ambiguous:
            status = 'ambiguous'
        else:
            status = best_person['role']
        return {
            'status': status,
            'match': None if status in ('unknown', 'ambiguous') else self._public(best_person),
            'candidate': self._public(best_person) if status == 'ambiguous' else None,
            'distance': round(best_distance, 4),
            'runnerUp': None if runner_up is None else round(runner_up, 4),
            'threshold': threshold,
            'registry': len(people),
        }

    # ---------- журнал и дверь ----------
    def visit(self, data):
        kind = text_value(data.get('kind'), 'тип записи', 40)
        record = {
            'at': now_iso(),
            'kind': kind,
            'name': text_value(data.get('name'), 'имя', 64, required=False),
            'flat': flat_value(data.get('flat')),
            'decision': text_value(data.get('decision'), 'решение', 40, required=False),
            'distance': data.get('distance') if isinstance(data.get('distance'), (int, float)) else None,
            'note': text_value(data.get('note'), 'примечание', 200, required=False),
        }
        with self.lock:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                if self.log_path.exists() and self.log_path.stat().st_size > 2 * 1024 * 1024:
                    lines = self.log_path.read_text('utf-8').splitlines()[-MAX_VISITS:]
                    self.log_path.write_text('\n'.join(lines) + '\n', 'utf-8')
            except OSError:
                raise OSError('Журнал проходов недоступен. Проверьте папку data.')
            with self.log_path.open('a', encoding='utf-8') as f:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
        return {'record': record}

    def unlock(self, data):
        """Событие открытия двери: журнал + необязательный вебхук (реле, умный дом)."""
        record = self.visit({**data, 'kind': 'unlock', 'decision': data.get('decision', 'open')})
        if self.webhook:
            body = json.dumps(record['record'], ensure_ascii=False).encode()
            req = urllib.request.Request(self.webhook, data=body, headers={'Content-Type': 'application/json'})
            try:
                urllib.request.urlopen(req, timeout=3).close()
            except OSError:
                return {**record, 'webhook': 'недоступен'}
        return {**record, 'webhook': 'отправлен' if self.webhook else 'не настроен'}

    # ---------- маршрутизация ----------
    def handle(self, action, data):
        if not isinstance(data, dict):
            raise ValueError('Некорректный запрос вахты.')
        routes = {
            'identify': lambda: self.identify(data),
            'list': self.list,
            'stats': self.stats,
            'visits': lambda: self.visits(data.get('limit', 50)),
            'enroll': lambda: self.enroll(data),
            'update': lambda: self.update(data),
            'photo': lambda: self.photo(data),
            'delete': lambda: self.delete(data),
            'forgetAll': lambda: self.forget_all(data),
            'visit': lambda: self.visit(data),
            'unlock': lambda: self.unlock(data),
        }
        if action not in routes:
            raise ValueError('Нет такого действия вахты.')
        return routes[action]()


# ---------- точка входа для сервера Лиры ----------
_store = None


def vault():
    """Один реестр на процесс: данные в data/vakhta.json, журнал в data/vakhta-visits.jsonl."""
    global _store
    if _store is None:
        _store = Vakhta()
    return _store


def handle(action, data):
    """Вызывается сервером для POST /api/vakhta из модуля вахты."""
    return vault().handle(action, data)
