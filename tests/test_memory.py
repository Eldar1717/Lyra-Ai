import tempfile
import unittest
from pathlib import Path
from fact_store import Facts,scope
class FactTests(unittest.TestCase):
    def test_facts(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'data/memory.db';db=Facts(path);a=scope('1'*64);b=scope('2'*64)
            say=lambda s:db.handle(a,'observe',{'text':s})
            self.assertTrue(say('Я работаю в библиотеке')['captured']);self.assertTrue(say('Запомни: у Антона кот Барсик')['added']);self.assertFalse(say('Я работаю в библиотеке?')['captured']);self.assertFalse(say('Привет')['captured']);self.assertFalse(say('Запомни: у Антона кот Барсик')['added']);db=Facts(path)
            allrows=db.handle(a,'list',{})['facts'];self.assertEqual(len(allrows),2);self.assertEqual(db.handle(b,'list',{})['facts'],[]);self.assertIn('Барсик',db.handle(a,'context',{'text':'Как зовут кота Антона?'})['facts'][0]);i=allrows[0]['id']
            with self.assertRaises(ValueError):db.handle(b,'delete',{'id':i})
            db.handle(a,'edit',{'id':i,'text':'У Антона кошка Соня'});self.assertNotIn('Барсик',str(db.handle(a,'context',{'text':'Антон'})));db.handle(a,'delete',{'id':i});self.assertEqual(db.handle(a,'import',{'facts':['A','Б','A']})['added'],2);db.handle(a,'clear',{});self.assertEqual(db.handle(a,'list',{})['facts'],[])
    def test_scope(self):
        with self.assertRaises(ValueError):scope('')

class ChatContextTests(unittest.TestCase):
    def test_ollama_memory_requires_request_and_matches_profile(self):
        import json
        import threading
        import urllib.request
        from http.server import ThreadingHTTPServer
        from unittest.mock import patch
        import server
        with tempfile.TemporaryDirectory() as td, patch.object(server, 'facts', Facts(Path(td)/'test.db')), patch.object(server, 'upstream', return_value={'answer':'ok'}) as upstream, ThreadingHTTPServer(('127.0.0.1',0), server.App) as http:
            worker=threading.Thread(target=http.serve_forever,daemon=True);worker.start()
            def post(path, data, token):
                req=urllib.request.Request('http://127.0.0.1:%s/api/'%http.server_port+path, data=json.dumps(data).encode(), headers={'Content-Type':'application/json','X-Lyra-Profile':token})
                with urllib.request.urlopen(req) as r:return json.load(r)
            try:
                a,b='a'*64,'b'*64
                post('facts',{'action':'add','text':'У Антона кот Барсик'},a)
                for token,use,expect in [(a,True,True),(a,False,False),(b,True,False)]:
                    post('chat',{'engine':'ollama','model':'llama3.1:8b','messages':[{'role':'user','content':'Как зовут кота Антона?'}],'useFacts':use},token)
                    self.assertEqual('Барсик' in upstream.call_args.args[2]['messages'][0]['content'],expect)
            finally:http.shutdown();worker.join()
