"""Forecast lookup. Only a city name and its public coordinates leave this server."""
import json
import re
import urllib.request
from urllib.parse import urlencode


def fetch_json(base, params):
    url = base + '?' + urlencode(params)
    with urllib.request.urlopen(url, timeout=8) as r:
        return json.load(r)


def lookup(city, tomorrow=False, fetch=fetch_json):
    if not isinstance(city, str) or not re.fullmatch(r"[^\W\d_][\w .’'-]{0,79}", city, re.UNICODE):
        raise ValueError('Введите название города, например «Казань».')
    places = fetch('https://geocoding-api.open-meteo.com/v1/search', {'name': city, 'count': 1, 'language': 'ru'}).get('results')
    if not places: raise LookupError('Не нашла такой город. Попробуйте название в именительном падеже: «погода Казань».')
    p = places[0]; d = fetch('https://api.open-meteo.com/v1/forecast', {'latitude':p['latitude'],'longitude':p['longitude'],'timezone':'auto','forecast_days':2,'current':'temperature_2m,apparent_temperature,weather_code','daily':'temperature_2m_min,temperature_2m_max,weather_code'})
    day = 1 if tomorrow else 0; daily=d['daily']; cur=d['current']; place=', '.join(dict.fromkeys(str(p[k]) for k in ('name','admin1','country') if p.get(k)))
    code=int(daily['weather_code'][day] if tomorrow else cur['weather_code']); desc={0:'ясно',1:'преимущественно ясно',2:'переменная облачность',3:'пасмурно',45:'туман',48:'изморозевый туман',51:'слабая морось',53:'морось',55:'сильная морось',56:'ледяная морось',57:'ледяная морось',61:'небольшой дождь',63:'дождь',65:'сильный дождь',66:'ледяной дождь',67:'ледяной дождь',71:'небольшой снег',73:'снег',75:'сильный снег',77:'снежные зёрна',80:'кратковременный дождь',81:'ливни',82:'сильные ливни',85:'снежные заряды',86:'сильные снежные заряды',95:'гроза',96:'гроза с градом',99:'гроза с градом'}.get(code,'прогноз температуры')
    lo=round(daily['temperature_2m_min'][day]);hi=round(daily['temperature_2m_max'][day]); span=f'от {lo} до {hi} °C'
    if tomorrow: return {'answer':f"{place}. Завтра, {daily['time'][day]}: {desc}, {span}. Источник: Open-Meteo."}
    return {'answer':f"{place}. По данным на {cur['time'].replace('T',' ')} (местное время): {desc}, {round(cur['temperature_2m'])} °C, ощущается как {round(cur['apparent_temperature'])} °C. За день {span}. Источник: Open-Meteo."}
