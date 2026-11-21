"""Conversation facts; parameterized SQLite, isolated per random browser profile."""
import hashlib
import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path

DB = Path(__file__).resolve().parent / 'data' / 'memory.db'
LIMIT = 2000
EXPLICIT = re.compile(r'^(?:лира[,!:\s]+)?(?:пожалуйста[,\s]+)?(?:запомни(?:те)?|не забывай)[\s,:—-]+(?:что\s+)?(.+)$', re.I | re.S)
PERSONAL = re.compile(r'^(?:меня зовут|мо[её] имя|я (?:живу|работаю|учусь|люблю|предпочитаю|не люблю)|мне (?:нравится|нравятся)|у меня (?:есть|нет)|мой (?:друг|город|кот|пёс|брат)|моя (?:подруга|семья|кошка|собака|сестра)|мо(?:его друга|ю подругу) зовут|у моего друга|у моей подруги)\b',re.I)
RECALL=re.compile(r'^(?:лира[,\s]+)?(?:что (?:ты )?(?:обо мне помнишь|помнишь обо мне|запомнила)|что у тебя в памяти|покажи (?:мои заметки|память))\s*[?!.]*$',re.I)
STOP=set('какой какая как какие где когда что кто меня мой моя мои моего моей зовут у в и а где ли ты нам про мне помнишь есть'.split())

def scope(token):
    if not isinstance(token,str) or not re.fullmatch(r'[0-9a-f]{64}',token): raise ValueError('Нет ключа профиля памяти. Обновите страницу.')
    return hashlib.sha256(token.encode()).hexdigest()

def clean(s):
    if not isinstance(s,str) or not 0<len(s.strip())<=800: raise ValueError('Факт должен содержать от 1 до 800 знаков.')
    return ' '.join(s.split())

def candidates(text):
    m=EXPLICIT.match(text.strip());
    if m:return [clean(m[1])]
    if len(text)<=800 and '?' not in text and PERSONAL.match(text.strip()) and not re.search(r'\b(?:например|возможно|наверное|пароль|пин-код|токен)\b',text,re.I):return [clean(text)]
    return []

def tokens(s):
    s=s.casefold().replace('ё','е')
    terms={w[:4] for w in re.findall(r'[а-яa-z0-9]+',s) if len(w)>2 and w not in STOP}
    if re.search(r'меня зовут|зовут меня|мое имя',s):terms.add('@selfname')
    if re.search(r'живу|проживаю|мой город',s):terms.add('@city')
    if re.search(r'день рождения|родил[ась]',s):terms.add('@birthday')
    return terms

class Facts:
    def __init__(self,path=DB): self.path=Path(path)
    def connect(self):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        con=sqlite3.connect(self.path,timeout=8);con.row_factory=sqlite3.Row
        con.execute('CREATE TABLE IF NOT EXISTS facts(id INTEGER PRIMARY KEY, profile TEXT NOT NULL, content TEXT NOT NULL, norm TEXT NOT NULL, ts INTEGER NOT NULL, UNIQUE(profile,norm))');return con
    def handle(self,who,action,d):
        with closing(self.connect()) as c, c:
            def items():return [dict(r) for r in c.execute('SELECT id, content, ts FROM facts WHERE profile=? ORDER BY ts DESC,id DESC',(who,))]
            def add(text):
                s=clean(text);n=s.casefold().strip(' .!');
                if c.execute('SELECT 1 FROM facts WHERE profile=? AND norm=?',(who,n)).fetchone():return 0
                if c.execute('SELECT COUNT(*) FROM facts WHERE profile=?',(who,)).fetchone()[0]>=LIMIT:raise ValueError('Память заполнена. Удалите ненужные записи.')
                return c.execute('INSERT OR IGNORE INTO facts(profile,content,norm,ts) VALUES(?,?,?,?)',(who,s,n,int(time.time()))).rowcount
            if action=='list':return {'facts':items()}
            if action=='observe':
                s=d.get('text');
                if not isinstance(s,str) or len(s)>2000:raise ValueError('Некорректная реплика.')
                rows=candidates(s);added=sum(add(x) for x in rows);return {'captured':bool(rows),'added':added,'explicit':bool(EXPLICIT.match(s.strip()))}
            if action=='add':return {'added':add(d.get('text'))}
            if action=='import':
                rows=d.get('facts');
                if not isinstance(rows,list) or len(rows)>1200:raise ValueError('Некорректный список для переноса.')
                return {'added':sum(add(s) for s in rows)}
            if action in ('delete','edit'):
                i=d.get('id');
                if type(i) is not int:raise ValueError('Не указана запись.')
                if action=='delete':cur=c.execute('DELETE FROM facts WHERE profile=? AND id=?',(who,i))
                else:
                    s=clean(d.get('text'))
                    try:cur=c.execute('UPDATE facts SET content=?,norm=?,ts=? WHERE profile=? AND id=?',(s,s.casefold().strip(' .!'),int(time.time()),who,i))
                    except sqlite3.IntegrityError:raise ValueError('Такая запись уже есть.') from None
                if not cur.rowcount:raise ValueError('Запись не найдена. Обновите список.')
                return {'ok':True}
            if action=='clear':c.execute('DELETE FROM facts WHERE profile=?',(who,));return {'ok':True}
            if action in ('recall','context'):
                q=d.get('text','');
                if not isinstance(q,str):raise ValueError('Некорректный вопрос.')
                words=tokens(q);ranked=sorted(((len(words & tokens(r['content'])),r) for r in items()),key=lambda t:(t[0],t[1]['ts'],t[1]['id']),reverse=True)
                out=[];size=0
                for score,r in ranked:
                    if action=='recall' and not score and not RECALL.match(q.strip()):continue
                    if len(out)>=20 or size+len(r['content'])>4800:continue
                    out.append(r['content']);size+=len(out[-1])
                return {'facts':out}
            raise ValueError('Неизвестное действие памяти.')
