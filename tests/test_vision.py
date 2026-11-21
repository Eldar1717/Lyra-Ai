import io
import json
import base64
import unittest
from unittest.mock import patch
import vision

class VisionTests(unittest.TestCase):
    def test_one_frame_local_only(self):
        image=base64.b64encode(b'\xff\xd8\xff\x01\xff\xd9').decode()
        with patch('vision.urllib.request.build_opener') as factory:
            factory.return_value.open.return_value=io.BytesIO(b'{"message":{"content":"ok"}}')
            self.assertEqual(vision.describe({'question':'Что в кадре?', 'image':image}),{'answer':'ok'})
            req=factory.return_value.open.call_args.args[0]
            self.assertEqual(req.full_url,'http://127.0.0.1:11434/api/chat');d=json.loads(req.data)
            self.assertEqual(d['model'],'gemma3:4b');self.assertEqual(d['messages'][-1]['images'],[image]);self.assertEqual(len(d['messages']),2)
    def test_omni_image(self):
        image=base64.b64encode(b'\xff\xd8\xff\x01\xff\xd9').decode()
        with patch('vision.urllib.request.build_opener') as factory:
            factory.return_value.open.return_value=io.BytesIO(b'{"message":{"content":"ok"}}')
            vision.describe({'model':'lfm3-omni','image':image,'question':'Что здесь?'})
            body=json.loads(factory.return_value.open.call_args.args[0].data)
            self.assertEqual(body['model'],'lfm3-omni');self.assertEqual(body['messages'][-1]['images'],[image]);self.assertEqual(body['options']['temperature'],0)
    def test_reject_bad_frame_without_model(self):
        with self.assertRaises(ValueError):vision.describe({'question':'Тест','image':'bad'})
