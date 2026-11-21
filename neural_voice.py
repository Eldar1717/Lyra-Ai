"""CPU synthesis in Russian. Only load the pinned, verified Silero model package."""
import hashlib
import io
import os
import re
import threading
import urllib.request
import wave
from pathlib import Path

SPEAKERS = ('xenia', 'kseniya', 'baya', 'aidar', 'eugene')
SAMPLE = 'Привет! Слышишь, как по-разному звучит одна и та же фраза? Выбери голос, с которым тебе приятно разговаривать.'
ROOT = Path(__file__).resolve().parent
URL = 'https://models.silero.ai/models/tts/ru/v4_ru.pt'
DIGEST = '896ab96347d5bd781ab97959d4fd6885620e5aab52405d3445626eb7c1414b00'
lock = threading.Lock()
_model = None


def built_in(text, speaker):
    ident = hashlib.sha256(text.encode()).hexdigest()[:20]
    return ROOT / 'assets' / 'speech' / (speaker + '-' + ident + '.ogg')


def engine():
    global _model
    if _model is not None: return _model
    try:
        import torch
    except (ImportError, OSError) as error:
        raise RuntimeError('Для новых реплик установите CPU-версию PyTorch по инструкции в README. Готовые примеры работают без неё.') from error
    folder = Path.home() / '.cache' / 'lyra' / 'tts'
    folder.mkdir(exist_ok=True, parents=True)
    path = folder / 'v4_ru.pt'
    if not path.exists():
        try:
            with urllib.request.urlopen(URL, timeout=45) as r:
                data = r.read(64 * 1024 * 1024)
        except OSError as error:
            raise RuntimeError('Не удалось скачать Silero. Для первого запуска новых реплик нужен интернет.') from error
        if hashlib.sha256(data).hexdigest() != DIGEST:
            raise RuntimeError('Контрольная сумма модели не совпала. Синтез остановлен.')
        tmp = path.with_suffix('.part'); tmp.write_bytes(data); tmp.replace(path)
    if hashlib.sha256(path.read_bytes()).hexdigest() != DIGEST:
        raise RuntimeError('Файл v4_ru.pt в кэше повреждён. Удалите его и повторите попытку.')
    torch.set_num_threads(min(os.cpu_count() or 1, 3))
    _model = torch.package.PackageImporter(str(path)).load_pickle('tts_models', 'model')
    _model.to(torch.device('cpu'))
    return _model


def synthesize(text, speaker):
    if speaker not in SPEAKERS or not isinstance(text,str) or not 0 < len(text.strip()) <= 700: raise ValueError('Некорректная голосовая реплика.')
    cached = built_in(text, speaker)
    if cached.is_file(): return 'audio/ogg', cached.read_bytes()
    with lock:
        model = engine()
        import torch
        cleaned = re.sub(r'[*_`#]', '', text).strip()
        with torch.inference_mode():
            samples = model.apply_tts(text=cleaned, speaker=speaker, sample_rate=24000, put_accent=True, put_yo=True)
        pcm = samples.clamp(-1, 1).mul(32767).to(torch.int16).cpu().numpy().astype('<i2',copy=False)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setparams((1, 2, 24000, 0, 'NONE', 'not compressed')); w.writeframes(pcm.tobytes())
    return 'audio/wav', buf.getvalue()
