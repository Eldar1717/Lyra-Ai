"use strict";
const $ = (id) => document.getElementById(id);
const paths = {
  sliders: "M4 7h8m4 0h4M4 17h3m4 0h9 M12 4v6 M8 14v6",
  expand: "M4 9V4h5m6 0h5v5m0 6v5h-5M9 20H4v-5",
  mic: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 11v1a7 7 0 0 0 14 0v-1 M12 19v3m-4 0h8",
  speaker: "M3 9h4l5-4v14l-5-4H3z M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14",
  mute: "M3 9h4l5-4v14l-5-4H3z M16 9l6 6m0-6-6 6",
  history: "M3 5v5h5 M3.6 10a8.5 8.5 0 1 1 1 8 M12 7v5l3 2",
  chat: "M4 4h16v13H9l-5 4z M8 9h8m-8 4h5",
  send: "m3 11 17-7-5 16-4-6-8-3z M11 14l9-10",
  stop: "M6 6h12v12H6z",
  // дверь рисуем в тех же границах, что «Модули» и «Настройки» (4…20),
  // иначе иконка кажется ниже остальных и кнопка «плывёт»
  door: "M6 20V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v15 M4 20h16 M11 12h.01",
  modules: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
};
function icon(n) {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[n]}"/></svg>`;
}
document
  .querySelectorAll("[data-i]")
  .forEach((e) => (e.outerHTML = icon(e.dataset.i)));
function load(k, d) {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
}
function store(k, x) {
  try {
    localStorage.setItem(k, JSON.stringify(x));
  } catch {}
}
let prefs = load("lyra:prefs", {
    engine: "demo",
    voice: "",
    rate: 1,
    model: "llama3.1:8b",
    sound: true,
  }),
  msgs = load("lyra:chat", []),
  mode = "idle",
  listen = null,
  token = 0,
  utter = null,
  ctrl = null;
const synth = window.speechSynthesis;
const motion = !matchMedia("(prefers-reduced-motion: reduce)").matches;
function notice(msg) {
  $("notice").textContent = msg;
  $("notice").hidden = !msg;
}
function state(m) {
  mode = m;
  window.wakeStateChanged?.();
  $("status").textContent = {
    idle: "Готова к разговору",
    listen: "Слушаю вас",
    think: "Обдумываю ответ",
    talk: "Говорю",
  }[m];
  $("mic").innerHTML =
    icon(m === "listen" ? "stop" : "mic") +
    `<span>${{ idle: prefs.micMode === "toggle" ? "Начать разговор" : "Зажмите и говорите", listen: prefs.micMode === "toggle" ? "Закончить фразу" : "Слушаю…", think: "Перебить", talk: "Перебить" }[m]}</span>`;
  $("mic").classList.toggle("active", m === "listen");
}
function silence() {
  stopAudio();
  token++;
  if (ctrl) ctrl.abort();
  if (listen) {
    let r = listen;
    listen = null;
    r.abort();
  }
  synth?.cancel();
  utter = null;
  state("idle");
}
function systemSpeak(txt, voice, rate, preview) {
  if (!synth) {
    notice("Синтез речи недоступен в этом браузере. Ответ показан в чате.");
    return;
  }
  let u = new SpeechSynthesisUtterance(txt);
  utter = u;
  u.lang = "ru-RU";
  u.rate = +rate;
  testState(preview);
  let vs = synth.getVoices();
  u.voice =
    vs.find((v) => v.voiceURI === voice) ||
    vs.find((v) => v.lang.startsWith("ru")) ||
    null;
  u.onboundary = (e) => {
    if (utter === u) wordPulse = performance.now();
  };
  u.onstart = () => {
    if (u === utter) {
      state("talk");
      if (preview) $("voiceInfo").textContent = "Проба системного голоса";
    }
  };
  u.onend = () => {
    if (u === utter) {
      testState(false);
      utter = null;
      state("idle");
    }
  };
  u.onerror = (e) => {
    if (u === utter) {
      testState(false);
      utter = null;
      state("idle");
      if (!["interrupted", "canceled"].includes(e.error))
        notice(
          "Не удалось озвучить ответ. Проверьте русский голос в настройках браузера.",
        );
    }
  };
  synth.speak(u);
}
function demo(s) {
  s = s.toLowerCase();
  if (/как твои дела|как дела/.test(s))
    return "Хорошо. Смотрю на горы и думаю, как здесь тихо. А каким был твой день?";
  if (/о себе|кто ты|как тебя зовут/.test(s))
    return "Я Лира. Мне досталась комната с видом на горы и голос, чтобы с тобой разговаривать. Здесь можно немного отвлечься, помечтать или просто поболтать.";
  if (/мечт|горы|путешеств/.test(s))
    return "Давай представим: мы приехали в маленький дом у подножия гор. До рассвета ещё час. Пойдём встречать солнце или сначала заварим чай?";
  if (/чай|кофе/.test(s))
    return "Тогда я поставлю чайник у окна. Пока вода нагревается, расскажи: какое место ты хотел бы увидеть на рассвете?";
  if (/привет|здравств|добрый/.test(s))
    return "Привет! Рада тебя видеть. О чём тебе хочется поговорить?";
  if (/устал|груст|тяжел/.test(s))
    return "Хочешь рассказать, что сегодня отняло больше всего сил? Или лучше ненадолго сменим тему?";
  if (/время|час/.test(s))
    return (
      "Сейчас " +
      new Date().toLocaleTimeString("ru-RU", {
        hour: "numeric",
        minute: "numeric",
      }) +
      " по времени твоего устройства."
    );
  if (/спасибо/.test(s))
    return "Пожалуйста. Я рядом, если захочешь продолжить разговор.";
  return "Пока я в демонстрационном режиме и не умею свободно отвечать на любую тему. Можем помечтать о путешествии или познакомиться. Для полноценной беседы подключи языковую модель в настройках.";
}
function line(el, m) {
  let p = document.createElement("p"),
    b = document.createElement("strong");
  b.textContent = m.role === "user" ? "Вы: " : "Лира: ";
  p.append(b, document.createTextNode(m.content));
  el.append(p);
}
function persist() {
  msgs = msgs.slice(-100);
  store("lyra:chat", msgs);
}
async function send(s, cameraAction = null) {
  s = s.trim().slice(0, 2000);
  if (!s) return;
  silence();
  const id = token;
  notice("");
  $("input").value = "";
  const cam = cameraAction || window.Camera?.intent(s);
  msgs.push({ role: "user", content: s, ...(cam ? { camera: true } : {}) });
  persist();
  $("last").replaceChildren();
  line($("last"), msgs.at(-1));
  state("think");
  let a;
  try {
    if (cam) ctrl = new AbortController();
    const remembered = cam
      ? await Camera.answer(cam, s, ctrl.signal)
      : ((await dailyAnswer(s)) ??
        (id === token ? await Facts.answer(s) : null));
    if (id !== token) return;
    if (remembered !== null) a = remembered;
    else if (prefs.engine !== "demo") {
      ctrl = new AbortController();
      let r = await fetch("/api/chat", {
        method: "POST",
        headers: Facts.wantsContext()
          ? Facts.headers()
          : { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: msgs.filter((m) => !m.camera).slice(-18),
          useFacts: Facts.wantsContext(),
          model: prefs.model,
          engine: prefs.engine,
        }),
        signal: ctrl.signal,
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      a = data.answer;
      if (!a) throw Error();
    } else {
      await new Promise((r) => setTimeout(r, 330));
      a = demo(s);
    }
    if (id !== token) return;
    msgs.push({
      role: "assistant",
      content: a,
      ...(cam ? { camera: true } : {}),
    });
    persist();
    line($("last"), msgs.at(-1));
    state("idle");
    speak(a);
  } catch (e) {
    if (id === token) {
      notice(e.message || "Модель не ответила. Проверьте настройки.");
      state("idle");
    }
  }
}
$("form").onsubmit = (e) => {
  e.preventDefault();
  send($("input").value);
};
document
  .querySelectorAll(".chips button")
  .forEach((b) => (b.onclick = () => send(b.textContent)));
function soundUI() {
  const b = $("sound");
  b.innerHTML = icon(prefs.sound ? "speaker" : "mute");
  b.title = b.ariaLabel = prefs.sound
    ? "Выключить озвучку"
    : "Включить озвучку";
  b.setAttribute("aria-pressed", prefs.sound);
}
$("sound").onclick = () => {
  prefs.sound = !prefs.sound;
  if (!prefs.sound && (utter || voiceJob)) {
    stopAudio();
    utter = null;
    synth?.cancel();
    state("idle");
  }
  store("lyra:prefs", prefs);
  soundUI();
};
soundUI();
$("historyBtn").onclick = () => {
  $("log").replaceChildren();
  if (!msgs.length)
    $("log").textContent = "Здесь появятся ваши сообщения и ответы Лиры.";
  msgs.forEach((m) => line($("log"), m));
  $("historyDialog").showModal();
  $("log").scrollTop = $("log").scrollHeight;
};
$("clear").onclick = () => {
  silence();
  msgs = [];
  persist();
  $("last").replaceChildren();
  $("log").textContent = "История очищена.";
};
function voiceList() {
  const v = $("voices");
  const chosen = $("settingsDialog").open && v.value ? v.value : voiceChoice();
  v.replaceChildren();
  const group = document.createElement("optgroup");
  group.label = "Нейроголоса · Silero";
  roster.forEach(([id, name]) =>
    group.append(new Option(name + " · " + id, "neural:" + id)),
  );
  v.append(group);
  if (window.cloneAvailable || chosen === "clone:xtts")
    v.append(new Option("Мой голос · XTTS-v2", "clone:xtts"));
  const sys = document.createElement("optgroup");
  sys.label = "Голоса устройства";
  sys.append(new Option("Русский · системный", "system"));
  synth
    ?.getVoices()
    .filter((x) => x.lang.startsWith("ru"))
    .forEach((x) => sys.append(new Option(x.name, x.voiceURI)));
  v.append(sys);
  v.value = chosen;
  if (!v.value) v.value = "system";
}

const engineHelp = {
  compatible:
    "По умолчанию: LM Studio на компьютере с сервером Лиры. Другой API задаётся через LLM_BASE_URL и LLM_API_KEY (см. README).",
  ollama: "Ollama должна быть запущена на компьютере с сервером Лиры.",
};
function showSettings() {
  silence();
  $("engine").value = prefs.engine;
  $("asrReview").value = prefs.asrReview || "smart";
  $("asrFilter").value = prefs.asrFilter || "normal";
  $("asr").value = prefs.asr || "local";
  $("micMode").value = prefs.micMode || "hold";
  $("rate").value = prefs.rate;
  voiceList();
  $("dental").value = prefs.dental ?? 0.9;
  $("voiceInfo").textContent = "Сравните голоса на одной и той же фразе.";
  $("engine").onchange();
  $("settingsDialog").showModal();
  window.refreshClone?.();
}
$("engine").onchange = () => {
  let e = $("engine").value;
  $("modelrow").hidden = e === "demo";
  $("models").replaceChildren();
  $("modelInfo").textContent = engineHelp[e] || "";
  $("model").value =
    (prefs.engine === e ? prefs.model : prefs.modelIds?.[e]) ||
    (e === "ollama" ? "llama3.1:8b" : "");
};
$("refresh").onclick = async () => {
  let e = $("engine").value;
  const btn = $("refresh");
  btn.disabled = true;
  $("modelInfo").textContent = "Запрашиваю модели…";
  try {
    const r = await fetch("/api/models?engine=" + e),
      d = await r.json();
    if (e !== $("engine").value) return;
    if (!r.ok) throw Error(d.error);
    $("models").replaceChildren(...d.models.map((k) => new Option(k, k)));
    if (d.models.length && !d.models.includes($("model").value))
      $("model").value = d.models[0];
    $("modelInfo").textContent = d.models.length
      ? "Доступно моделей: " + d.models.length + ". Выберите ID в поле выше."
      : "Список пуст. Загрузите модель на сервер.";
  } catch (err) {
    if (e === $("engine").value)
      $("modelInfo").textContent =
        (err.message || "Список недоступен.") + " ID можно ввести вручную.";
  } finally {
    btn.disabled = false;
  }
};
$("save").onclick = () => {
  let e = $("engine").value,
    m = $("model").value.trim();
  if (e !== "demo" && !m) {
    $("modelInfo").textContent = "Введите ID модели.";
    $("model").focus();
    return;
  }
  prefs.modelIds = { ...prefs.modelIds, [e]: m };
  Object.assign(prefs, {
    micMode: $("micMode").value,
    asr: $("asr").value,
    asrReview: $("asrReview").value,
    asrFilter: $("asrFilter").value,
    engine: e,
    model: m,
    rate: $("rate").value,
    voice: $("voices").value,
    dental: +$("dental").value,
  });
  store("lyra:prefs", prefs);
  state("idle");
  updateHint();
  $("settingsDialog").close();
};
$("expand").onclick = async () => {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  if ($("stage").classList.contains("big")) {
    $("stage").classList.remove("big");
    return;
  }
  try {
    await $("stage").requestFullscreen();
  } catch {
    $("stage").classList.add("big");
  }
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("stage").classList.remove("big");
});
window.addEventListener("pagehide", silence);
