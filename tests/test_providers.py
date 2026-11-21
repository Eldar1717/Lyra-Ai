"""Provider contract tests: real HTTP to a local stub, no live model or keys."""
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from server import upstream


class Stub(BaseHTTPRequestHandler):
    def reply(self, payload):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def do_GET(self):
        if self.path == '/api/tags': self.reply({'models': [{'name': 'local-test'}]})
        elif self.path == '/v1/models': self.reply({'data': [{'id': 'api-test'}]})
        else: self.send_error(404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if body['stream'] is not False or not body['messages']: return self.send_error(400)
        if self.path == '/api/chat' and body['model'] == 'local-test':
            self.reply({'message': {'content': 'ollama ok'}})
        elif self.path == '/v1/chat/completions' and self.headers.get('Authorization') == 'Bearer unit-test' and body['model'] == 'api-test':
            self.reply({'choices': [{'message': {'content': 'compatible ok'}}]})
        else: self.send_error(400)

    def log_message(self, *args): pass


class AdapterTests(unittest.TestCase):
    def test_both_dialects(self):
        with ThreadingHTTPServer(('127.0.0.1', 0), Stub) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = 'http://127.0.0.1:' + str(server.server_port)
            try:
                with patch.dict(os.environ, OLLAMA_URL=url, LLM_BASE_URL=url+'/v1', LLM_API_KEY='unit-test'):
                    for provider, model in [('ollama', 'local-test'), ('compatible', 'api-test')]:
                        self.assertEqual(upstream(provider, listing=True)['models'], [model])
                        answer = upstream(provider, body={'model': model, 'messages':[{'role':'user','content':'Тест'}], 'stream':False})
                        self.assertEqual(answer['answer'], provider+' ok')
            finally:
                server.shutdown(); thread.join()
