import unittest
from weather import lookup
class WeatherTest(unittest.TestCase):
    def test_weather(self):
        def fake(url,q):
            if 'geocoding' in url: return {'results':[dict(name='Казань',latitude=55.8,longitude=49.1,country='Россия')]}
            return {'current':dict(weather_code=0,temperature_2m=5,apparent_temperature=3,time='2026-11-21T10:00'),'daily':dict(weather_code=[0,63],temperature_2m_min=[1,2],temperature_2m_max=[8,9],time=['2026-11-21','2026-11-22'])}
        self.assertIn('5 °C',lookup('Казань',fetch=fake)['answer']);self.assertIn('2026-11-22: дождь',lookup('Казань',True,fake)['answer'])
        with self.assertRaises(LookupError):lookup('Несуществующий',fetch=lambda *_:{})
