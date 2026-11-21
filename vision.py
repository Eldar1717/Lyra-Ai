"""One JPEG to a selected local vision model. No history, proxy or redirects."""
import base64
import json
import urllib.error
import urllib.request

MODEL = 'gemma3:4b'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): return None

def describe(data):
    if not isinstance(data,dict): raise ValueError('Нужен кадр и вопрос.')
    model = data.get('model', MODEL)
    if model not in ('lfm3-omni', MODEL): raise ValueError('Выберите поддерживаемую локальную модель зрения.')
    question, image = data.get('question'), data.get('image')
    if not isinstance(question,str) or not 0<len(question.strip())<=2000: raise ValueError('Введите короткий вопрос.')
    if not isinstance(image,str) or not 0<len(image)<=950000: raise ValueError('Некорректный размер кадра.')
    try: raw=base64.b64decode(image,validate=True)
    except ValueError: raise ValueError('Некорректный кадр.') from None
    if not raw.startswith(b'\xff\xd8\xff') or not raw.endswith(b'\xff\xd9'): raise ValueError('Ожидался кадр JPEG.')
    body={'model':model,'stream':False,'messages':[{'role':'system','content':'Кратко ответь по-русски на вопрос по изображению. Описывай только видимое; если не различаешь, так и скажи. Не устанавливай личность людей.'},{'role':'user','content':question.strip(),'images':[image]}]}
    if model == 'lfm3-omni': body['options'] = {'temperature':0}
    req=urllib.request.Request('http://127.0.0.1:11434/api/chat',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    client=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    try:
        with client.open(req,timeout=120) as r: result=json.loads(r.read(1024*1024))['message']['content']
        if not isinstance(result,str) or not result.strip(): raise ValueError()
        return {'answer':result.strip()[:5000]}
    except urllib.error.HTTPError as e:
        if e.code==404: raise RuntimeError(f'Модель зрения не найдена. Выполните ollama pull {model} на компьютере с Лирой.') from None
        raise RuntimeError(f'Ollama не обработала кадр. Проверьте версию Ollama, модель {model} и свободную память.') from None
    except (OSError,ValueError,KeyError,TypeError): raise RuntimeError(f'Нет ответа от локальной Ollama. Проверьте, что она запущена и модель {model} установлена.') from None
