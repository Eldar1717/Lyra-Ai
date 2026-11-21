// One input gesture owns a recognition session; stale callbacks never submit.
let held = null,
  deadline = null,
  session = null;
function updateHint() {
  $("ptthelp").innerHTML =
    prefs.micMode === "toggle"
      ? "<kbd>Пробел</kbd> — удерживайте. Кнопка включает и выключает микрофон. Можно перебивать."
      : "<kbd>Пробел</kbd> или кнопка — удерживайте, чтобы говорить. Можно перебивать.";
}
function discard() {
  clearTimeout(deadline);
  held = null;
  session = null;
  silence();
}
function finish() {
  held = null;
  const s = session;
  if (!s || s.id !== token || s.ending) return;
  s.ending = true;
  clearTimeout(deadline);
  if (listen) {
    try {
      listen.stop();
    } catch {
      complete(s);
    }
  } else complete(s);
}
function complete(s) {
  if (session !== s || token !== s.id) return;
  session = null;
  held = null;
  clearTimeout(deadline);
  listen = null;
  state("idle");
  const text = (s.previous + " " + s.current).trim();
  if (text) send(text);
  else notice("Не услышала фразу. Удерживайте кнопку, пока говорите.");
}
function begin(owner) {
  discard();
  notice("");
  const R =
    prefs.asr === "browser"
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : OfflineRecognizer;
  if (!R) {
    notice(
      "В этом браузере нет голосового ввода. Используйте Chrome или текстовый чат.",
    );
    return;
  }
  held = owner;
  const s = { id: token, previous: "", current: "", ending: false };
  session = s;
  function arm() {
    if (s !== session || s.id !== token) return;
    let r = new R();
    listen = r;
    r.lang = "ru-RU";
    r.continuous = owner !== "toggle";
    r.interimResults = true;
    const valid = () => listen === r && session === s && s.id === token;
    r.onresult = (e) => {
      if (!valid()) return;
      s.current = Array.from(e.results, (v) => v[0].transcript.trim())
        .filter(Boolean)
        .join(" ");
      $("input").value = (s.previous + " " + s.current).trim();
    };
    r.onerror = (e) => {
      if (!valid()) return;
      const messages = {
        "not-allowed":
          "Микрофон заблокирован. Разрешите доступ в отдельной вкладке Chrome.",
        "no-speech": "Не услышала речь. Попробуйте ещё раз.",
        network:
          "Браузерный сервис недоступен. В настройках голоса выберите «Локальный Vosk».",
        "audio-capture": "Микрофон не найден. Проверьте устройство ввода.",
      };
      if (e.error === "no-speech" && s.previous.trim()) {
        complete(s);
        return;
      }
      discard();
      notice(
        messages[e.error] ||
          (e.error === "local"
            ? "Локальное распознавание: " + e.message
            : "") ||
          "Распознавание остановлено. Попробуйте ещё раз.",
      );
    };
    r.onend = () => {
      if (!valid()) return;
      listen = null;
      if (s.ending || owner === "toggle") {
        complete(s);
        return;
      }
      if (!s.current.trim()) {
        discard();
        notice("Распознавание остановилось. Попробуйте ещё раз.");
        return;
      }
      s.previous = (s.previous + " " + s.current).trim();
      s.current = "";
      arm();
    };
    try {
      r.start();
      state("listen");
    } catch {
      discard();
      notice("Не удалось запустить микрофон. Проверьте разрешения браузера.");
    }
  }
  arm();
  if (s === session) deadline = setTimeout(finish, 60000);
}
const mic = $("mic");
mic.onpointerdown = (e) => {
  if (prefs.micMode === "toggle" || e.button !== 0) return;
  e.preventDefault();
  mic.setPointerCapture(e.pointerId);
  begin(e.pointerId);
};
mic.onpointerup = (e) => {
  if (held === e.pointerId) finish();
};
mic.onpointercancel = (e) => {
  if (held === e.pointerId) discard();
};
mic.onlostpointercapture = (e) => {
  if (held === e.pointerId) discard();
};
mic.oncontextmenu = (e) => e.preventDefault();
mic.onclick = (e) => {
  if (prefs.micMode === "toggle" || e.detail === 0) {
    if (mode === "listen") finish();
    else begin("toggle");
  }
};
window.addEventListener("keydown", (e) => {
  if (
    e.code !== "Space" ||
    document.querySelector("dialog[open]") ||
    e.altKey ||
    e.ctrlKey ||
    e.metaKey
  )
    return;
  const el = e.target;
  if (
    el !== mic &&
    (el.isContentEditable || el.closest("input,textarea,select,button,a"))
  )
    return;
  e.preventDefault();
  if (!e.repeat) begin("space");
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && held === "space") {
    e.preventDefault();
    finish();
  }
});
window.addEventListener("blur", () => {
  if (mode === "listen") discard();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && mode === "listen") discard();
});
state("idle");
updateHint();
