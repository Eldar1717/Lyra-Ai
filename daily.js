// Local notebook. Store absolute reminder instants, but interpret speech in device local time.
const Daily = (() => {
  const key = "lyra:notebook:1",
    clock = (d) =>
      d.toLocaleString("ru-RU", {
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
  const digits = {
    один: 1,
    одну: 1,
    два: 2,
    две: 2,
    три: 3,
    четыре: 4,
    пять: 5,
    шесть: 6,
    семь: 7,
    восемь: 8,
    девять: 9,
    десять: 10,
    одиннадцать: 11,
    двенадцать: 12,
    тринадцать: 13,
    четырнадцать: 14,
    пятнадцать: 15,
    шестнадцать: 16,
    семнадцать: 17,
    восемнадцать: 18,
    девятнадцать: 19,
    двадцать: 20,
    "двадцать один": 21,
    "двадцать два": 22,
    "двадцать три": 23,
  };
  function timeOf(text, now) {
    const t = text.toLowerCase();
    if (
      /ежедневно|кажд(?:ый|ую|ое)|по (?:понедельникам|будням|выходным)/u.test(t)
    )
      return {
        error:
          "Повторяющиеся напоминания пока не поддерживаются. Назовите один день и время.",
      };
    let rel = t.match(/через\s+(\d+)\s+(минут[уы]?|час(?:а|ов)?)(?![а-яё])/u);
    if (rel) {
      const n = Number(rel[1]);
      if (n < 1 || n > 999)
        return { error: "Укажите интервал от 1 до 999 минут или часов." };
      return {
        at: +now + n * (rel[2].startsWith("час") ? 3600000 : 60000),
        parts: [rel[0]],
      };
    }
    let re = new RegExp(
        "(?:^|\\s)(?:в|к)\\s+(\\d{1,2}|" +
          Object.keys(digits)
            .sort((a, b) => b.length - a.length)
            .join("|") +
          "|час)(?::(\\d{2}))?(?:\\s+час(?:а|ов)?)?(?:\\s+(утра|дня|вечера|ночи))?(?![\\p{L}\\d:])",
        "u",
      ),
      m = t.match(re);
    if (!m) return null;
    let h = m[1] === "час" ? 1 : (digits[m[1]] ?? Number(m[1])),
      min = +(m[2] || 0);
    if (h > 23 || min > 59 || (m[3] && (h > 12 || h === 0)))
      return {
        error:
          "Время некорректно. Например: «Напомни завтра в 21:30 попить воды».",
      };
    if (m[3]) {
      h %= 12;
      if (m[3] === "дня" || m[3] === "вечера") h += 12;
    }
    let d = new Date(now);
    let day = t.match(/послезавтра|завтра|сегодня/u);
    let date = t.match(/(?:^|\s)(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/u);
    if (date) {
      d.setFullYear(+date[3], +date[2] - 1, +date[1]);
      if (d.getDate() !== +date[1] || d.getMonth() !== +date[2] - 1)
        return { error: "Такой даты нет в календаре." };
    } else if (
      /понедельник|вторник|сред[уы]|четверг|пятниц|суббот|воскресень|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|недел[юи]|\d[./]\d/u.test(
        t,
      )
    )
      return {
        error:
          "Укажите дату в формате ДД.ММ.ГГГГ, «сегодня» или «завтра», а также время.",
      };
    else
      d.setDate(
        d.getDate() +
          (day?.[0] === "послезавтра" ? 2 : day?.[0] === "завтра" ? 1 : 0),
      );
    d.setHours(h, min, 0, 0);
    if (+d <= +now)
      return {
        error:
          "Это время уже прошло. Укажите новый срок, например «напомни завтра в 21:00 попить воды».",
      };
    return { at: +d, parts: [m[0], day?.[0], date?.[0]].filter(Boolean) };
  }
  function cityName(s) {
    s = s.trim().replace(/[?.!,]+$/u, "");
    const forms = {
      москве: "Москва",
      москву: "Москва",
      питере: "Санкт-Петербург",
      "санкт-петербурге": "Санкт-Петербург",
      петербурге: "Санкт-Петербург",
      казани: "Казань",
      новосибирске: "Новосибирск",
      екатеринбурге: "Екатеринбург",
      минске: "Минск",
      сочи: "Сочи",
    };
    return forms[s.toLowerCase()] || s;
  }
  function create(storage, now = () => new Date()) {
    let blank = () => ({ city: "", work: "", rows: [] });
    let data = blank();
    function reload() {
      try {
        let x = JSON.parse(storage.getItem(key));
        if (x && Array.isArray(x.rows))
          data = {
            city: String(x.city || "").slice(0, 80),
            work: String(x.work || "").slice(0, 160),
            rows: x.rows
              .filter(
                (r) =>
                  r &&
                  typeof r.text === "string" &&
                  typeof r.id === "string" &&
                  (r.at === null || Number.isFinite(r.at)),
              )
              .slice(-300),
          };
        else data = blank();
      } catch {}
    }
    reload();
    function save() {
      try {
        storage.setItem(key, JSON.stringify(data));
        return true;
      } catch {
        return false;
      }
    }
    const view = () => JSON.parse(JSON.stringify(data));
    function stored(msg) {
      return (
        msg +
        (save()
          ? ""
          : " Сохранено только в этой вкладке: хранилище недоступно.")
      );
    }
    function handle(raw, enabled = true, remindersOnly = false) {
      let text = raw
        .trim()
        .replace(/^лира[,\s]+/iu, "")
        .replace(/[!?.,\s]+$/u, "");
      let d = now();
      if (
        /^(?:(?:скажи|подскажи)[,\s]+)?(?:который час|сколько (?:сейчас )?времени|какое (?:сейчас )?время|какой (?:сегодня|сейчас) (?:день(?: недели)?|месяц|год)|какая сегодня дата|какое сегодня число|сегодня какое число)$/iu.test(
          text,
        )
      )
        return (
          "По часам устройства: " +
          d.toLocaleString("ru-RU", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }) +
          "."
        );
      if (!enabled) return null;
      if (
        remindersOnly &&
        !/напоминания|^напомни[,\s]|^запомни[,\s:]/iu.test(text)
      )
        return null;
      if (
        remindersOnly &&
        /^запомни[,\s:]/iu.test(text) &&
        (!/(?:сегодня|завтра|через \d+|нужно|надо|\d{2}\.\d{2}\.\d{4})/iu.test(
          text,
        ) ||
          !timeOf(text, d))
      )
        return null;
      if (
        /^(?:где я (?:живу|работаю)|(?:какой|назови) мой город|какое мо[её] место работы)$/iu.test(
          text,
        )
      ) {
        let work = /работ/iu.test(text);
        return data[work ? "work" : "city"]
          ? `${work ? "Место работы" : "Город"}: ${data[work ? "work" : "city"]}.`
          : "Пока не записано. Начните со слова «запомни».";
      }
      if (
        /^(?:мои |покажи (?:мои )?|какие у меня )(заметки|напоминания)$/iu.test(
          text,
        )
      ) {
        let rem = /напоминания/iu.test(text);
        let items = data.rows.filter((r) => (rem ? r.at && !r.done : !r.at));
        return items.length
          ? items
              .map(
                (r, i) =>
                  `${i + 1}. ${r.text}${r.at ? " — " + clock(new Date(r.at)) : ""}`,
              )
              .join("\n")
          : "Список пуст.";
      }
      let c = text.match(
        /^(запомни|напомни)(?:\s+мне)?[,\s:]+(?:что\s+)?(.+)$/iu,
      );
      if (!c) return null;
      let body = c[2].trim();
      if (!remindersOnly && c[1].toLowerCase() === "запомни") {
        let p = body.match(/^(?:мой город\s*[:—–-]?\s*|я живу в\s+)(.+)$/iu);
        if (p) {
          let v = cityName(p[1]);
          if (v.length > 80 || !v) return "Введите короткое название города.";
          data.city = v;
          return stored("Запомнила город: " + v + ".");
        }
        p = body.match(
          /^(?:мо[её] место работы\s*[:—–-]?\s*|я работаю\s+)(.+)$/iu,
        );
        if (p) {
          const v = p[1].trim();
          if (v.length > 160 || !v)
            return "Укажите короткое название места работы.";
          data.work = v;
          return stored("Запомнила место работы: " + v + ".");
        }
      }
      let due = timeOf(body, d);
      if (due?.error) return due.error;
      if (c[1].toLowerCase() === "напомни" && !due)
        return "Не поняла срок. Например: «Напомни завтра в 21:00 попить воды» или «Напомни через 15 минут проверить чай».";
      let subject = body;
      if (due) {
        for (const part of due.parts)
          subject = subject.replace(
            new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"),
            " ",
          );
        subject = subject
          .replace(/\s+/gu, " ")
          .trim()
          .replace(/^(?:нужно|надо)\s+/iu, "")
          .replace(/^[,;:\s]+|[,;:\s]+$/gu, "");
        if (!subject)
          return "О чём нужно напомнить? Повторите команду со временем и делом.";
      }
      if (subject.length > 500) return "Сократите запись до 500 знаков.";
      if (data.rows.filter((r) => (remindersOnly ? r.at : true)).length >= 100)
        return "Блокнот заполнен (100 записей). Удалите ненужные записи в настройках.";
      data.rows.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        text: subject,
        at: due?.at ?? null,
        done: false,
      });
      return stored(
        due
          ? "Напомню " +
              clock(new Date(due.at)) +
              ": " +
              subject +
              ". Напоминание появится в открытой Лире."
          : "Записала заметку: " + subject + ".",
      );
    }
    return {
      handle,
      view,
      reload,
      profile(city, work) {
        data.city = city.trim().slice(0, 80);
        data.work = work.trim().slice(0, 160);
        return save();
      },
      remove(id) {
        data.rows = data.rows.filter((r) => r.id !== id);
        return save();
      },
      due() {
        return data.rows
          .filter((r) => !r.done && r.at !== null && r.at <= +now())
          .map((r) => ({ ...r }));
      },
      ack(id) {
        let r = data.rows.find((r) => r.id === id);
        if (r) r.done = true;
        return save();
      },
    };
  }
  return { key, create, clock, cityName, timeOf };
})();
if (typeof module !== "undefined" && module.exports) module.exports = Daily;
if (typeof document !== "undefined") {
  let store = null;
  try {
    store = localStorage;
  } catch {}
  window.book = Daily.create(store);
  let askCity = null;
  function list() {
    let rows = book
      .view()
      .rows.filter((r) => r.at)
      .reverse();
    $("bookRows").replaceChildren();
    if (!rows.length) $("bookRows").textContent = "Пока нет записей.";
    for (const r of rows) {
      let row = document.createElement("div"),
        label = document.createElement("span"),
        btn = document.createElement("button");
      row.className = "bookRow";
      label.textContent =
        (r.at
          ? (r.done ? "✓ " : "◷ ") + Daily.clock(new Date(r.at)) + " · "
          : "") + r.text;
      btn.className = "textBtn";
      btn.textContent = "Удалить";
      btn.onclick = () => {
        let ok = book.remove(r.id);
        list();
        tick();
        $("memStatus").textContent = ok
          ? "Запись удалена."
          : "Запись удалена только в этой вкладке.";
      };
      row.append(label);
      row.append(btn);
      $("bookRows").append(row);
    }
  }
  $("openMemory").addEventListener("click", () => {
    const p = book.view();
    $("bookCity").value = p.city;

    list();
  });
  function tick() {
    let rs = book.due();
    const box = $("dueBox");
    box.hidden = !rs.length;
    box.replaceChildren();
    for (const r of rs) {
      const text = document.createElement("span"),
        btn = document.createElement("button"),
        row = document.createElement("div");
      row.className = "bookRow";
      text.textContent =
        "Напоминание · " + Daily.clock(new Date(r.at)) + ": " + r.text;
      btn.className = "settings";
      btn.textContent = "Прочитано";
      btn.onclick = () => {
        const ok = book.ack(r.id);
        tick();
        list();
        if (!ok) notice("Отметка о прочтении сохранена только в этой вкладке.");
      };
      row.append(text, btn);
      box.append(row);
    }
  }
  setInterval(() => {
    if (!document.hidden) tick();
  }, 5000);
  window.addEventListener("focus", tick);
  window.addEventListener("storage", (e) => {
    if (e.key === Daily.key || e.key === null) {
      book.reload();
      tick();
    }
  });
  tick();
  window.dailyTick = tick;
  window.dailyAnswer = async function (s) {
    const enabled = true,
      p = book.view(),
      x = s
        .trim()
        .replace(/^лира[,\s]+/iu, "")
        .replace(/[.?!]+$/u, "");
    const simple = book.handle(x, enabled, true);
    if (simple !== null) {
      askCity = null;
      return simple;
    }
    let req = x.match(
      /^(?:(?:скажи|покажи|посмотри)[,\s]+)?(?:какая\s+(?:сейчас\s+|сегодня\s+|завтра\s+)?погода|погода|прогноз погоды)(?:\s+(.*))?$/iu,
    );
    let city = "",
      tomorrow = false;
    if (req) {
      tomorrow = /завтра/iu.test(x);
      if (/послезавтра|недел|вчера/iu.test(x))
        return "Могу посмотреть погоду сейчас или прогноз на завтра.";
      city = Daily.cityName(
        (req[1] || "")
          .replace(
            /(?:^|\s)(?:на завтра|на сегодня|будет|сегодня|завтра|сейчас)(?=\s|$)/giu,
            " ",
          )
          .trim()
          .replace(/^(?:в|во|для)\s+/iu, ""),
      );
      if (!city && enabled) city = p.city;
      if (!city) {
        askCity = { tomorrow, expires: Date.now() + 90000 };
        return "Для какого города посмотреть погоду? Например: Москва.";
      }
    } else if (
      askCity &&
      Date.now() < askCity.expires &&
      /^(?:в\s+)?[\p{L}][\p{L} -]{1,60}$/u.test(x) &&
      !/[?]/.test(s) &&
      !/^запомни|^напомни|^привет|^отмена|^забудь|^как |^что /iu.test(x)
    ) {
      city = Daily.cityName(x.replace(/^в\s+/iu, ""));
      tomorrow = askCity.tomorrow;
    } else {
      askCity = null;
      return null;
    }
    askCity = null;
    ctrl = new AbortController();
    const resp = await fetch(
      "/api/weather?" +
        new URLSearchParams({ city, day: tomorrow ? "tomorrow" : "today" }),
      { signal: ctrl.signal },
    );
    const result = await resp.json();
    return resp.ok
      ? result.answer
      : result.error || "Не удалось получить прогноз.";
  };
}
