import io
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch
import clone_voice as cv


def fixture(seconds):
    out = io.BytesIO()
    with wave.open(out, 'wb') as w:
        w.setparams((1, 2, cv.RATE, 0, 'NONE', ''))
        w.writeframes(b'\x00\x08\x00\xf8'*(cv.RATE*seconds//2))
    return out.getvalue()


class CloneTests(unittest.TestCase):
    def test_scope_wav_validation_and_remove(self):
        with tempfile.TemporaryDirectory() as td, patch.object(cv, 'ROOT', Path(td)), patch.object(cv,'MODEL',Path(td)/'no-model'):
            cv.save('a'*64,fixture(6))
            self.assertTrue(cv.status('a'*64)['sample'])
            self.assertFalse(cv.status('b'*64)['sample'])
            with self.assertRaises(ValueError): cv.save('a'*64,fixture(2))
            with self.assertRaises(ValueError): cv.save('a'*64,fixture(6)[:-48])
            with self.assertRaisesRegex(RuntimeError,'XTTS-v2'): cv.synthesize('a'*64,'Тест')
            self.assertEqual(cv.reference('a'*64).read_bytes(),fixture(6))
            cv.delete('a'*64);self.assertFalse(cv.status('a'*64)['sample'])
