"""Локальный сервер Лиры. Ключ и адрес модели задаются только на сервере."""
import json, os, urllib.request, urllib.error
from pathlib import Path
from neural_voice import synthesize
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
os.chdir(Path(__file__).resolve().parent)

def upstream(engine, listing=False, body=None):
    if engine=='ollama':
        base=os.getenv('OLLAMA_URL','http://127.0.0.1:11434'); path='/api/tags' if listing else '/api/chat'; key=''
    elif engine=='compatible':
        base=os.getenv('LLM_BASE_URL','http://127.0.0.1:1234/v1'); path='/models' if listing else '/chat/completions'; key=os.getenv('LLM_API_KEY','')
    else: raise ValueError('Провайдер не поддерживается.')
    headers={'Content-Type':'application/json'}
    if key: headers['Authorization']='Bearer '+key
    req=urllib.request.Request(base.rstrip('/')+path,data=None if listing else json.dumps(body).encode(),headers=headers)
    with urllib.request.urlopen(req,timeout=6 if listing else 90) as r: data=json.load(r)
    if listing: return {'models':[m['name'] for m in data['models']] if engine=='ollama' else [m['id'] for m in data['data']]}
    answer=(data['message'] if engine=='ollama' else data['choices'][0]['message'])['content']
    if not isinstance(answer,str) or not answer.strip(): raise ValueError('Сервер не вернул текст ответа.')
    return {'answer':answer}

class App(SimpleHTTPRequestHandler):
    def result(self,status,data):
        out=json.dumps(data,ensure_ascii=False).encode();self.send_response(status); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Cache-Control','no-store'); self.send_header('Content-Length',str(len(out))); self.end_headers()
        try:self.wfile.write(out)
        except (BrokenPipeError,ConnectionResetError):pass
    def proxy(self,engine,listing=False,body=None):
        try:self.result(200,upstream(engine,listing,body))
        except urllib.error.HTTPError as e:self.result(502,{'error':f'Сервер моделей вернул {e.code}. Проверьте модель, адрес и ключ API.'})
        except (OSError,ValueError,IndexError,KeyError,TypeError):self.result(503,{'error':'Сервер моделей недоступен или вернул неожиданный ответ. Проверьте подключение.'})
    def do_GET(self):
        url=urlsplit(self.path)
        if url.path=='/api/models':self.proxy(parse_qs(url.query).get('engine',[''])[0],True)
        elif url.path in ('/','/index.html','/app.js','/avatar.js','/photo.js','/voice.js','/style.css','/local-asr.js','/matte.js','/speech.js','/background.js') or url.path in {'/assets/'+x for x in ['night.jpg','lyra.webp','eyes.png','lips.png','forest.jpg','loft.jpg','asr/vosk.js','asr/ru-small.tar.gz']}:super().do_GET()
        else:self.send_error(404)
    def do_POST(self):
        if self.headers.get('Origin') and urlsplit(self.headers['Origin']).netloc!=self.headers.get('Host'):return self.send_error(403)
        if self.path=='/api/speech':
            try:
                n=int(self.headers.get('Content-Length',0))
                if not 0<n<=10000: raise ValueError()
                data=json.loads(self.rfile.read(n)); typ,audio=synthesize(data['text'],data['speaker'])
            except (ValueError,TypeError,KeyError): return self.result(400,{'error':'Некорректный запрос на озвучку.'})
            except RuntimeError as e: return self.result(503,{'error':str(e)[:280]})
            except Exception: return self.result(503,{'error':'Не удалось синтезировать голос. Проверьте установку PyTorch и модель Silero.'})
            self.send_response(200);self.send_header('Content-Type',typ);self.send_header('Content-Length',str(len(audio)));self.send_header('Cache-Control','no-store');self.end_headers()
            try:self.wfile.write(audio)
            except (BrokenPipeError,ConnectionResetError):pass
            return
        if self.path!='/api/chat':return self.send_error(404)
        try:
            size=int(self.headers.get('Content-Length',0))
            if not 0<size<=150000:raise ValueError()
            data=json.loads(self.rfile.read(size)); model=data['model'];engine=data.get('engine','ollama')
            if not isinstance(model,str) or not 0<len(model)<=256 or engine not in ('ollama','compatible'):raise ValueError()
            msgs=[{'role':m['role'],'content':m['content'][:5000]} for m in data['messages'][-20:] if m['role'] in ('user','assistant') and isinstance(m['content'],str)]
            if not msgs:raise ValueError()
        except (ValueError,TypeError,KeyError):return self.result(400,{'error':'Некорректный запрос.'})
        self.proxy(engine,body={'model':model,'stream':False,'messages':[{'role':'system','content':'Ты Лира, виртуальный собеседник. Отвечай на русском, тепло, естественно и кратко.'}]+msgs})
if __name__=='__main__':ThreadingHTTPServer((os.getenv('HOST','127.0.0.1'),int(os.getenv('PORT',8000))),App).serve_forever()
