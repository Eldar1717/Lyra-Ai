// Чистая логика вахтёра: без DOM, камеры и сети — поэтому её легко проверить тестами.
// Вход: что видит камера, кого узнал реестр и что ответил гость.
// Выход: список действий (сказать фразу, открыть дверь, записать в журнал, позвать жильца).
const VakhtaLogic = (() => {
  const DEFAULTS = {
    debounce: 3, // сколько кадров подряд нужно видеть лицо, чтобы начать
    cooldownMs: 45000, // не здороваться с тем же человеком повторно
    denyCooldownMs: 300000, // пауза после отказа
    loseMs: 2500, // лицо пропало из кадра → сброс сценария
    answerMs: 20000, // сколько ждём ответ на «зачем пришли»
    retries: 2, // сколько раз переспросить, прежде чем отказать
    passGuests: false, // пускать гостя, назвавшего квартиру, без подтверждения жильца
    passDelivery: true, // курьера с номером квартиры пускать сразу: он всё равно идёт в одну квартиру
  };

  const PHRASES = {
    resident: 'Здравствуйте, {name}! Проходите, пожалуйста.',
    residentNoName: 'Здравствуйте! Проходите, пожалуйста.',
    guest: 'Здравствуйте, {name}. Вас ждут в квартире {flat}. Проходите, пожалуйста.',
    guestNoFlat: 'Здравствуйте, {name}. Проходите, пожалуйста.',
    denied: 'Вы в списке нежелательных посетителей. Уходите, пожалуйста.',
    unknown: 'Здравствуйте! Вы не из нашего дома. Зачем пришли?',
    unclear: 'Извините, не узнаю вас. Назовите, пожалуйста, номер квартиры, к кому вы пришли.',
    retry: 'Не расслышал. Повторите, пожалуйста: к кому вы пришли и в какую квартиру?',
    askFlat: 'В какую квартиру? Назовите, пожалуйста, номер.',
    deliveryNoFlat: 'Курьер, здравствуйте! В какую квартиру доставка?',
    toFlat: 'Понятно, вы в квартиру {flat}. Секунду, сообщаю жильцам. Подождите у двери, пожалуйста.',
    toPerson: 'Понятно, вы к нашим жильцам. Сообщаю им, подождите у двери, пожалуйста.',
    passFlat: 'Понятно, вы в квартиру {flat}. Проходите, пожалуйста.',
    passDelivery: 'Курьер в квартиру {flat}. Проходите, пожалуйста.',
    passPerson: 'Понятно. Проходите, пожалуйста.',
    refused: 'Я не могу вас пропустить без подтверждения жильца. Позвоните в квартиру или уходите, пожалуйста.',
    timeout: 'Вы не ответили, поэтому я вас не пропускаю. Уходите, пожалуйста.',
  };

  const REFUSAL =
    /(?:уходи|уйди|отвали|не тво[её]|не ваше|открой|открывай|открыть|пропусти|полици|имею право|я тут живу|да ты кто|пош[её]л|надоел)/iu;
  const DELIVERY = /(?:курьер|доставк|авито|озон|ozon|wildberries|яндекс|сбермаркет|самокат|посылк)/iu;

  const UNITS = {
    ноль: 0, один: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
    шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12,
    тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17,
    восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40,
    пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
    сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600,
    семьсот: 700, восемьсот: 800, девятьсот: 900,
  };

  // Порядковые числительные: Vosk часто пишет «в двенадцатую», «сорок второй»,
  // «сто восемнадцатая». Храним основы, чтобы отбросить любое окончание.
  const ORDINAL_STEMS = [
    ['одиннадцат', 11], ['двенадцат', 12], ['тринадцат', 13], ['четырнадцат', 14],
    ['пятнадцат', 15], ['шестнадцат', 16], ['семнадцат', 17], ['восемнадцат', 18],
    ['девятнадцат', 19], ['четверт', 4], ['седьм', 7], ['восьм', 8], ['девят', 9],
    ['десят', 10], ['двадцат', 20], ['тридцат', 30], ['сороков', 40], ['пятидесят', 50],
    ['шестидесят', 60], ['семидесят', 70], ['восьмидесят', 80], ['девяност', 90],
    ['двухсот', 200], ['трехсот', 300], ['четырехсот', 400], ['пятисот', 500],
    ['шестисот', 600], ['семисот', 700], ['восьмисот', 800], ['девятисот', 900],
    ['перв', 1], ['втор', 2], ['трет', 3], ['пят', 5], ['шест', 6], ['сот', 100],
  ];

  // Буква корпуса: «118б», «118 б», «сто восемнадцать бэ».
  const LETTERS = { б: 'б', бэ: 'б', в: 'в', вэ: 'в', г: 'г', гэ: 'г', д: 'д', дэ: 'д',
    е: 'е', ж: 'ж', жэ: 'ж', з: 'з', зэ: 'з', к: 'к', л: 'л', м: 'м', н: 'н' };
  // «в», «к», «а», «и» — предлоги и союзы, поэтому буквой считаем их только в конце фразы.
  const AMBIGUOUS = new Set(['в', 'к', 'а', 'и', 'с', 'у', 'о']);
  const TAIL = /^[\s,.!?;:)\]]*$/u;

  const ORDINAL_ENDING = /(?:ый|ий|ой|ая|яя|ое|ее|ые|ие|ую|юю|ого|его|ому|ему|ым|им|ом|ем)$/u;

  function ordinalValue(word) {
    // окончание отсекает «сотрудник», «пятак» и прочие слова с теми же буквами
    if (!ORDINAL_ENDING.test(word)) return undefined;
    for (const [stem, value] of ORDINAL_STEMS) {
      if (word.startsWith(stem) && word.length > stem.length) return value;
    }
    return undefined;
  }

  // «сорок два», «сто восемнадцать б», «двести тридцать четвертая» → 42, «118б», 234.
  function wordsToFlat(text) {
    const src = String(text || '')
      .toLowerCase()
      .replace(/ё/g, 'е');
    const tokens = [...src.matchAll(/[а-я]+/gu)].map((m) => ({ word: m[0], end: m.index + m[0].length }));
    let best = '',
      sum = 0,
      letter = '',
      open = false;
    const close = () => {
      if (open && sum > 0 && sum < 10000) best = String(sum) + letter;
      open = false;
      sum = 0;
      letter = '';
    };
    for (const { word, end } of tokens) {
      const cardinal = UNITS[word];
      if (cardinal !== undefined) {
        sum += cardinal;
        open = true;
        continue;
      }
      const ordinal = ordinalValue(word);
      if (ordinal !== undefined) {
        sum += ordinal;
        open = true;
        continue;
      }
      if (open && !letter && LETTERS[word]) {
        // «в», «к», «а», «и» — обычно предлоги, буквой считаем их только в конце фразы.
        const endsPhrase = /^[\s,.!?;:)\]]*$/u.test(src.slice(end));
        if (word.length > 1 || endsPhrase || !AMBIGUOUS.has(word)) {
          letter = LETTERS[word];
          continue;
        }
      }
      close();
    }
    close();
    return best;
  }

  function wordsToNumber(text) {
    const flat = wordsToFlat(text);
    const digits = String(flat).replace(/[^0-9]/g, '');
    const value = digits ? Number(digits) : null;
    return value && value > 0 && value < 10000 ? value : null;
  }

  const FLAT_PATTERNS = [
    /квартир[а-я]*\s*(?:номер\s*)?№?\s*(\d{1,4})\s*([а-яa-z])?/iu,
    /(\d{1,4})\s*(?:-?(?:я|ой|ая))?\s*квартир[а-я]*/iu,
    /(?:^|\s)(?:в|на|к)\s+(?:кв\.?\s*)?№?\s*(\d{1,4})(?=$|\s|[,.!?])/iu,
    /кв\.?\s*№?\s*(\d{1,4})/iu,
    /(?:^|\s)(\d{1,4})(?=$|\s|[,.!?])/u,
  ];
  const TO_NAME = /(?:^|\s)(?:к|у|для)\s+([А-ЯЁA-Z][а-яёa-z\-]{2,})/u;
  const FLAT_LETTER = /^[\s,.!?;:)\]]*([абвгдежзиклмн])(?![а-я])([\s\S]*)$/u;

  // «42», «кв. 118б», «в квартиру сто двадцать три» → номер квартиры.
  function digitsFlat(clean) {
    for (const pattern of FLAT_PATTERNS) {
      const m = clean.match(pattern);
      if (!m) continue;
      let letter = (m[2] || '').toLowerCase();
      if (!letter) {
        const after = clean.slice(m.index + m[0].length).match(FLAT_LETTER);
        if (after) {
          const endsPhrase = /^[\s,.!?;:)\]]*$/u.test(after[2] || '');
          if (!AMBIGUOUS.has(after[1]) || endsPhrase) letter = after[1];
        }
      }
      return m[1] + letter;
    }
    return '';
  }

  function fill(template, vars = {}) {
    return template
      .replace(/\{(\w+)\}/g, (m, key) => (vars[key] === undefined || vars[key] === '' ? '' : String(vars[key])))
      .replace(/\s+([,.!?])/g, '$1')
      .replace(/,\s*([.!?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // «Иван Петрович Сидоров» → «Иван Петрович»: вахтёр обращается по имени-отчеству.
  function shortName(full) {
    const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).join(' ');
  }

  // «к Ивановым», «к Смирновой» → жилец из реестра. Сравниваем по началу слова,
  // чтобы не разбирать падежи: иванов / ивановым / ивановой → «иван».
  function matchPerson(word, people = []) {
    const key = String(word || '').toLowerCase().replace(/ё/g, 'е').slice(0, 4);
    if (key.length < 3) return null;
    for (const person of people) {
      const parts = String(person.name || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/);
      if (parts.some((part) => part.length > 2 && part.slice(0, 4) === key)) return person;
    }
    return null;
  }

  function parseAnswer(text, people = []) {
    const raw = String(text || '').trim();
    if (!raw) return { empty: true };
    const clean = raw.toLowerCase().replace(/ё/g, 'е');
    const out = { text: raw, delivery: DELIVERY.test(clean), refusal: false, flat: '', name: '', person: null };
    out.flat = digitsFlat(clean) || wordsToFlat(clean);
    const named = raw.match(TO_NAME);
    if (named) {
      out.name = named[1];
      out.person = matchPerson(out.name, people);
      if (out.person) {
        out.name = out.person.name;
        if (!out.flat && out.person.flat) out.flat = String(out.person.flat);
      }
    }
    // «Мне к Смирнову в 42» — не отказ, даже если прозвучало «открой».
    if (REFUSAL.test(clean) && !out.flat && !out.name) out.refusal = true;
    return out;
  }

  function statusOf(ident) {
    if (!ident || typeof ident !== 'object') return 'unknown';
    const s = ident.status;
    if (s === 'resident' || s === 'guest' || s === 'denied' || s === 'ambiguous') return s;
    return 'unknown';
  }

  function create(options = {}) {
    const cfg = { ...DEFAULTS, ...(options.config || {}) };
    const ph = { ...PHRASES, ...(options.phrases || {}) };
    let people = Array.isArray(options.people) ? options.people : [];
    const log = [];
    let queue = [];
    let state = 'idle',
      frames = 0,
      seenAt = -Infinity,
      lastSeenAt = -Infinity,
      until = 0,
      attempts = 0,
      deadline = 0,
      person = null,
      lastKind = '';

    function say(text) {
      if (text) queue.push({ type: 'say', text });
    }
    function flush() {
      const out = queue;
      queue = [];
      for (const a of out) log.push({ ...a, at: lastSeenAt });
      return out;
    }
    function cool(ms, now) {
      state = 'cooldown';
      until = now + ms;
      deadline = 0;
      frames = 0;
    }
    function ask(now) {
      state = 'intern';
      deadline = now + cfg.answerMs;
    }
    function reset(reason) {
      state = 'idle';
      frames = 0;
      attempts = 0;
      deadline = 0;
      until = 0;
      person = null;
      lastKind = '';
      if (reason && reason !== 'quiet') queue.push({ type: 'reset', reason });
    }

    function greet(ident, now) {
      const status = statusOf(ident);
      const who = ident.match || {};
      person = { status, name: who.name || '', flat: who.flat || '', distance: ident.distance ?? null };
      frames = 0;
      if (status === 'resident') {
        const name = shortName(who.name);
        lastKind = 'resident';
        say(fill(name ? ph.resident : ph.residentNoName, { name }));
        queue.push({ type: 'unlock', ms: 5000, why: 'resident', name: who.name || '', flat: who.flat || '' });
        queue.push({
          type: 'log', kind: 'resident', name: who.name || '', flat: who.flat || '',
          decision: 'passed', distance: person.distance,
        });
        cool(cfg.cooldownMs, now);
      } else if (status === 'guest') {
        const name = shortName(who.name);
        lastKind = 'guest';
        say(fill(who.flat ? ph.guest : ph.guestNoFlat, { name, flat: who.flat }));
        queue.push({
          type: 'log', kind: 'guest', name: who.name || '', flat: who.flat || '',
          decision: 'passed', distance: person.distance,
        });
        cool(cfg.cooldownMs, now);
      } else if (status === 'denied') {
        lastKind = 'denied';
        say(ph.denied);
        queue.push({ type: 'alert', why: 'denied', name: who.name || '' });
        queue.push({
          type: 'log', kind: 'denied', name: who.name || '', flat: who.flat || '',
          decision: 'refused', distance: person.distance,
        });
        cool(cfg.denyCooldownMs, now);
      } else {
        // «ambiguous» — человек похож на двух жильцов: уточняем, а не пускаем наугад.
        lastKind = 'ask';
        say(status === 'ambiguous' ? ph.unclear : ph.unknown);
        queue.push({
          type: 'log', kind: status === 'ambiguous' ? 'ambiguous' : 'stranger',
          decision: 'asked', distance: person.distance,
        });
        attempts = 0;
        ask(now);
      }
    }

    function deny(now, reason, phrase) {
      say(phrase);
      queue.push({ type: 'alert', why: reason });
      queue.push({
        type: 'log', kind: 'stranger', name: person?.name || '', flat: person?.flat || '',
        decision: 'refused', note: reason, distance: person?.distance ?? null,
      });
      cool(cfg.denyCooldownMs, now);
    }

    function repeat(now, phrase) {
      attempts++;
      say(phrase || ph.retry);
      deadline = now + cfg.answerMs;
    }

    // obs: { now, faces, ident } — faces это число лиц в кадре, ident — ответ /api/vakhta identify.
    function tick(obs = {}) {
      const now = Number(obs.now ?? Date.now());
      const faces = Number(obs.faces || 0);
      if (faces > 0) {
        frames++;
        seenAt = now;
        lastSeenAt = now;
      } else {
        frames = 0;
      }
      if (faces === 0) {
        if (state !== 'idle' && now - seenAt >= cfg.loseMs) reset('left');
        return flush();
      }
      if (state === 'idle') {
        if (frames >= cfg.debounce) greet(obs.ident, now);
      } else if (state === 'intern') {
        if (deadline && now >= deadline) {
          if (attempts < cfg.retries) repeat(now);
          else deny(now, 'no-answer', ph.timeout);
        }
      } else if (state === 'pending') {
        // Гость назвал квартиру: ждём жильца, дверь сами не открываем.
        if (now - lastSeenAt >= cfg.loseMs) reset('left');
      } else if (state === 'cooldown') {
        if (now >= until) {
          state = 'idle';
          frames = 0;
          person = null;
          lastKind = '';
        }
      }
      return flush();
    }

    // Ответ гостя: речь распознана или введена с клавиатуры.
    function answer(text, now = Date.now()) {
      if (state !== 'intern') return flush();
      const parsed = parseAnswer(text, people);
      if (parsed.empty) {
        if (attempts < cfg.retries) repeat(now);
        else deny(now, 'no-answer', ph.timeout);
        return flush();
      }
      if (parsed.flat) {
        // Квартира важнее фамилии: она всегда называет адрес без падежей.
        const name = parsed.person?.name || parsed.name || '';
        const pass = parsed.delivery ? cfg.passDelivery === true : cfg.passGuests === true;
        say(fill(parsed.delivery ? (pass ? ph.passDelivery : ph.toFlat) : pass ? ph.passFlat : ph.toFlat, {
          flat: parsed.flat,
        }));
        queue.push({
          type: 'notify', flat: parsed.flat, name, text: parsed.text,
          kind: parsed.delivery ? 'delivery' : 'visitor', passed: pass,
        });
        if (pass) queue.push({ type: 'unlock', ms: 5000, why: 'guest', name, flat: parsed.flat });
        queue.push({
          type: 'log', kind: parsed.delivery ? 'delivery' : 'visitor',
          name, flat: parsed.flat, decision: pass ? 'passed' : 'pending',
          note: parsed.text.slice(0, 120),
        });
        if (pass) cool(cfg.cooldownMs, now);
        else {
          state = 'pending';
          deadline = 0;
        }
        return flush();
      }
      if (parsed.person) {
        // Фамилия нашлась в реестре, но квартиры у записи нет.
        const pass = parsed.delivery ? cfg.passDelivery === true : cfg.passGuests === true;
        say(pass ? ph.passPerson : ph.toPerson);
        queue.push(pass ? { type: 'unlock', ms: 5000, why: 'guest', name: parsed.person.name } : {
          type: 'notify', flat: '', name: parsed.person.name, text: parsed.text,
        });
        queue.push({
          type: 'log', kind: 'visitor', name: parsed.person.name, flat: '',
          decision: pass ? 'passed' : 'pending', note: parsed.text.slice(0, 120),
        });
        if (pass) cool(cfg.cooldownMs, now);
        else {
          state = 'pending';
          deadline = 0;
        }
        return flush();
      }
      if (parsed.refusal) {
        deny(now, 'refused', ph.refused);
        return flush();
      }
      if (parsed.delivery) {
        // Курьер без квартиры: спрашиваем именно квартиру, а не «повторите».
        repeat(now, ph.deliveryNoFlat);
        return flush();
      }
      if (attempts < cfg.retries) repeat(now);
      else deny(now, 'unclear', ph.refused);
      return flush();
    }

    function snapshot() {
      return {
        state,
        frames,
        attempts,
        lastKind,
        person: person ? { ...person } : null,
        until,
        deadline,
        people: people.length,
        config: { ...cfg },
        phrases: { ...ph },
        log: log.slice(-50),
      };
    }

    return {
      tick,
      answer,
      reset,
      snapshot,
      setConfig: (patch) => Object.assign(cfg, patch || {}),
      setPhrases: (patch) => Object.assign(ph, patch || {}),
      setPeople: (list) => {
        people = Array.isArray(list) ? list : [];
      },
    };
  }

  return {
    DEFAULTS,
    PHRASES,
    create,
    parseAnswer,
    shortName,
    fill,
    statusOf,
    matchPerson,
    wordsToNumber,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VakhtaLogic;
else if (typeof window !== 'undefined') window.VakhtaLogic = VakhtaLogic;
