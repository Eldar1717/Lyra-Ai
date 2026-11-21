"""Optional local XTTS-v2 backend. No model downloads during requests."""
import io
import re
import textwrap
import wave
import tempfile
import threading
import os
from array import array
from pathlib import Path
from importlib.util import find_spec
from contextlib import suppress

ROOT = Path(__file__).resolve().parent / 'data'
MODEL = ROOT / 'xtts-v2'
FILES = ('config.json', 'vocab.json', 'model.pth')
RATE = 24000
MAX_BYTES = RATE * 2 * 30 + 4096
lock = threading.Lock()
_model = None


def reference(profile):
    # Caller supplies only the SHA-256 of a validated profile token.
    return ROOT / 'voices' / (profile + '.wav')


def status(profile):
    return {'sample': reference(profile).is_file(), 'model': all((MODEL/f).is_file() for f in FILES), 'package': find_spec('TTS') is not None}


def save(profile, data):
    try:
        with wave.open(io.BytesIO(data), 'rb') as w:
            n = w.getnframes()
            if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, RATE) or not 6*RATE <= n <= 30*RATE:
                raise ValueError('Нужен фрагмент 6–30 секунд, моно PCM 24 кГц.')
            pcm = w.readframes(n)
            if len(pcm) != n * 2: raise ValueError('Обрезанный WAV.')
            import sys
            samples = array('h', pcm)
            if sys.byteorder != 'little': samples.byteswap()
            if max(map(abs, samples)) < 100: raise ValueError('В записи почти полная тишина.')
    except (wave.Error, EOFError) as e: raise ValueError('Не удалось прочитать WAV.') from e
    path = reference(profile)
    with lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as out, wave.open(out, 'wb') as w:
                w.setparams((1, 2, RATE, 0, 'NONE', '')); w.writeframes(pcm)
            os.replace(name, path)
        finally:
            with suppress(FileNotFoundError): os.unlink(name)


def delete(profile):
    with lock, suppress(FileNotFoundError): reference(profile).unlink()


def synthesize(profile, text):
    global _model
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 700: raise ValueError('Некорректный текст.')
    path = reference(profile)
    with lock:
        info = status(profile)
        if not info['sample']: raise ValueError('Сначала сохраните образец в настройках голоса.')
        if not info['model'] or not info['package']: raise RuntimeError('XTTS-v2 не установлен. См. XTTS.md в папке Лиры.')
        try:
            import torch
            import numpy as np
            if _model is None:
                from TTS.tts.configs.xtts_config import XttsConfig
                from TTS.tts.models.xtts import Xtts
                cfg = XttsConfig(); cfg.load_json(str(MODEL/'config.json'))
                model = Xtts.init_from_config(cfg); model.load_checkpoint(cfg, checkpoint_dir=str(MODEL), eval=True)
                _model = model.to('cuda' if torch.cuda.is_available() else 'cpu')
            with torch.inference_mode():
                latent, embedding = _model.get_conditioning_latents(str(path), gpt_cond_len=12)
                parts = [part for sentence in re.split(r'(?<=[.!?…;])\s+', text.strip()) for part in textwrap.wrap(sentence, width=140)]
                sound = np.concatenate([_model.inference(part, 'ru', latent, embedding)['wav'] for part in parts])
            pcm = (np.clip(sound, -1, 1) * 32767).astype('<i2').tobytes()
            out = io.BytesIO()
            with wave.open(out, 'wb') as w:
                w.setparams((1, 2, RATE, 0, 'NONE', '')); w.writeframes(pcm)
            return out.getvalue()
        except Exception as e:
            # Avoid logging private text, audio, or profile filenames.
            print('XTTS:', type(e).__name__, flush=True)
            raise RuntimeError('Не удалось запустить синтез XTTS. Проверьте зависимости, файлы модели и свободную память (XTTS.md).') from None
