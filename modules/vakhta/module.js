// ИИ-вахтёр: камера → распознавание лица в браузере → решение → голос.
// Сценарий диалога живёт в logic.js, реестр жильцов — на сервере
// (backend.py). Здесь только камера, сеть и интерфейс.
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const PREFS_KEY = "vakhta:prefs";
  const PIN_KEY = "vakhta:pin";
  // 320 быстрее 416 и достаточно для лица крупным планом у двери; порог детектора
  // ниже 0.5, чтобы не терять человека в сумерках подъезда.
  const DETECT = { inputSize: 320, scoreThreshold: 0.45 };
  const ROLES = {
    resident: { label: "свой · жилец", tone: "ok" },
    guest: { label: "гость из списка", tone: "guest" },
    denied: { label: "не пускать", tone: "bad" },
    ambiguous: { label: "похож на двоих", tone: "ask" },
    unknown: { label: "чужой", tone: "ask" },
  };

  const DEFAULTS = {
    threshold: 0.52,
    cooldown: 45,
    answer: 20,
    voice: "neural:aidar",
    speak: true,
    autoListen: true, // сам включает микрофон, услышав вопрос «зачем пришли»
    passGuests: false, // пускать гостя, назвавшего квартиру, без подтверждения жильца
    passDelivery: true, // курьера с номером квартиры пускать сразу
  };

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }
  function readPin() {
    try {
      return localStorage.getItem(PIN_KEY) || "";
    } catch {
      return "";
    }
  }

  let prefs = { ...DEFAULTS, ...read(PREFS_KEY, {}) };
  const logic = VakhtaLogic.create({
    config: {
      cooldownMs: prefs.cooldown * 1000,
      answerMs: prefs.answer * 1000,
      passGuests: !!prefs.passGuests,
      passDelivery: prefs.passDelivery !== false,
    },
  });

  // Портрет Лиры: тот же риг, что на главной странице, но внутри модуля.
  let lyra = null;

  const video = $("vkVideo");
  const boxCanvas = $("vkBox");
  const cropCanvas = $("vkCrop");
  const sayEl = $("vkSay");
  const heardEl = $("vkHeard");
  const badgeEl = $("vkBadge");
  const hintEl = $("vkHint");
  const doorEl = $("vkDoor");
  const logEl = $("vkLog");
  const topEl = $("vkTopStatus");
  const toastEl = $("vkToast");
  const answerForm = $("vkAnswerForm");
  const answerInput = $("vkAnswerInput");

  let stream = null,
    running = false,
    busy = false,
    loopTimer = 0,
    serverOk = true,
    listeningAnswer = false,
    facesSeen = 0,
    lastError = "";

  // ---------------- сеть ----------------
  async function api(action, data = {}) {
    let res;
    try {
      res = await fetch("/api/vakhta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, pin: readPin(), ...data }),
      });
    } catch {
      serverOk = false;
      throw Error("Сервер вахты не отвечает. Запустите python server.py.");
    }
    serverOk = true;
    let out = {};
    try {
      out = await res.json();
    } catch {
      throw Error("Сервер ответил не по-нашему.");
    }
    if (!res.ok) throw Error(out.error || "Ошибка сервера вахты.");
    return out;
  }

  function toast(message, tone = "") {
    toastEl.textContent = message;
    toastEl.dataset.tone = tone;
    toastEl.classList.add("show");
    clearTimeout(toastEl.timer);
    toastEl.timer = setTimeout(() => toastEl.classList.remove("show"), 4200);
  }

  // ---------------- лицо и камера ----------------
  let faceReady = null;
  function loadFace() {
    if (faceReady) return faceReady;
    faceReady = (async () => {
      if (!window.faceapi) {
        await new Promise((ok, no) => {
          const s = document.createElement("script");
          s.src = "/assets/face/face-api.min.js";
          s.onload = ok;
          s.onerror = () => no(Error("Не загрузился face-api.js."));
          document.head.append(s);
        });
      }
      await Promise.all(
        [
          faceapi.nets.tinyFaceDetector,
          faceapi.nets.faceLandmark68TinyNet,
          faceapi.nets.faceRecognitionNet,
        ].map((net) => net.loadFromUri("/assets/face")),
      );
      return faceapi;
    })().catch((e) => {
      faceReady = null;
      throw Error("Не загрузились модули лица из /assets/face: " + e.message);
    });
    return faceReady;
  }

  async function detectFaces(input) {
    await loadFace();
    return faceapi
      .detectAllFaces(input, new faceapi.TinyFaceDetectorOptions(DETECT))
      .withFaceLandmarks(true)
      .withFaceDescriptors();
  }

  function cameraLive() {
    return !!stream && video.readyState >= 2 && video.videoWidth > 0;
  }

  async function ensureCamera() {
    if (stream) return stream;
    if (!navigator.mediaDevices?.getUserMedia)
      throw Error("Браузер не дал доступ к камере. Откройте вахтёра на localhost или по HTTPS.");
    const got = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: false,
    });
    stream = got;
    video.srcObject = got;
    await video.play().catch(() => {});
    hintEl.hidden = true;
    got.getVideoTracks()[0].onended = () => stopDuty("Камера отключилась устройством.");
    return got;
  }

  function stopCamera() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    boxCanvas.getContext?.("2d")?.clearRect(0, 0, boxCanvas.width, boxCanvas.height);
    if (!running) hintEl.hidden = false;
  }

  // ---------------- отрисовка ----------------
  function drawBoxes(faces) {
    const ctx = boxCanvas.getContext("2d");
    if (!ctx) return;
    const w = boxCanvas.clientWidth || video.clientWidth;
    const h = boxCanvas.clientHeight || video.clientHeight;
    if (boxCanvas.width !== w || boxCanvas.height !== h) {
      boxCanvas.width = w;
      boxCanvas.height = h;
    }
    ctx.clearRect(0, 0, boxCanvas.width, boxCanvas.height);
    if (!faces.length || !video.videoWidth) return;
    const sx = video.videoWidth / w,
      sy = video.videoHeight / h;
    ctx.lineWidth = 3;
    for (const face of faces) {
      const b = face.detection.box;
      // видео отражено (scaleX(-1)), поэтому x считаем от правого края
      const x = w - (b.x + b.width) / sx,
        y = b.y / sy,
        bw = b.width / sx,
        bh = b.height / sy;
      ctx.strokeStyle = faces.length === 1 ? "rgba(181,161,255,.95)" : "rgba(251,191,36,.9)";
      ctx.beginPath();
      ctx.roundRect?.(x, y, bw, bh, 12);
      if (!ctx.roundRect) ctx.rect(x, y, bw, bh);
      ctx.stroke();
      ctx.fillStyle = "rgba(10,11,17,.62)";
      ctx.fillRect(x, Math.max(0, y - 26), Math.min(bw, 190), 24);
      ctx.fillStyle = "#e9e6ff";
      ctx.font = "13px -apple-system, Segoe UI, Arial";
      ctx.fillText(faces.length === 1 ? "лицо в кадре" : `лиц в кадре: ${faces.length}`, x + 8, Math.max(16, y - 9));
    }
  }

  function drawCrop(face) {
    const ctx = cropCanvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
    if (!face || !video.videoWidth) {
      cropCanvas.classList.remove("on");
      $("vkFaceEmpty").hidden = false;
      return;
    }
    const b = face.detection.box;
    const pad = b.width * 0.45;
    const size = Math.max(b.width, b.height) + pad * 2;
    const cx = b.x + b.width / 2,
      cy = b.y + b.height / 2;
    ctx.save();
    ctx.translate(cropCanvas.width, 0);
    ctx.scale(-1, 1); // кадр зеркальный, как в предпросмотре
    ctx.drawImage(video, cx - size / 2, cy - size / 2, size, size, 0, 0, cropCanvas.width, cropCanvas.height);
    ctx.restore();
    cropCanvas.classList.add("on");
    $("vkFaceEmpty").hidden = true;
  }

  function setBadge(kind, text) {
    badgeEl.dataset.tone = kind === "idle" ? "idle" : ROLES[kind]?.tone || "idle";
    badgeEl.textContent = text;
    const big = $("vkKioskBadge");
    if (big) {
      big.dataset.tone = badgeEl.dataset.tone;
      big.textContent = text;
    }
  }

  function showIdentity(ident, face) {
    const unknown = ident && VakhtaLogic.statusOf(ident) === "unknown";
    const name =
      ident?.match?.name ||
      (ident?.candidate ? "похож на " + ident.candidate.name : "") ||
      (unknown ? "незнакомый человек" : "");
    $("vkName").textContent = name || "—";
    $("vkFlat").textContent = ident?.match?.flat || "—";
    const status = ident ? VakhtaLogic.statusOf(ident) : "unknown";
    $("vkRole").textContent = ident ? ROLES[status]?.label || "—" : "—";
    $("vkDistance").textContent =
      ident && typeof ident.distance === "number" ? ident.distance.toFixed(2) : "—";
    drawCrop(face);
    if (!ident) return setBadge("idle", "нет в кадре");
    if (status === "resident") setBadge("resident", "свой");
    else if (status === "guest") setBadge("guest", "гость");
    else if (status === "denied") setBadge("denied", "не пускать");
    else if (status === "ambiguous") setBadge("ambiguous", "похож на двоих");
    else setBadge("unknown", "чужой");
  }

  function clearIdentity() {
    $("vkName").textContent = "—";
    $("vkFlat").textContent = "—";
    $("vkRole").textContent = "—";
    $("vkDistance").textContent = "—";
    drawCrop(null);
    setBadge("idle", "нет в кадре");
  }

  function setSay(text) {
    if (!text) return;
    sayEl.textContent = text;
    sayEl.classList.add("show");
    const big = $("vkKioskSay");
    if (big) big.textContent = text;
  }

  function setHeard(text) {
    heardEl.textContent = text;
    heardEl.hidden = !text;
    const big = $("vkKioskHeard");
    if (big) {
      big.textContent = text;
      big.hidden = !text;
    }
  }

  function pushLog(kind, text) {
    const empty = logEl.querySelector(".vk-empty");
    if (empty) empty.remove();
    const li = document.createElement("li");
    li.dataset.kind = kind;
    const time = document.createElement("time");
    time.textContent = new Date().toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const body = document.createElement("span");
    const title = document.createElement("b");
    title.textContent = text.title;
    body.append(title, text.detail || "");
    li.append(time, body);
    logEl.prepend(li);
    while (logEl.children.length > 40) logEl.lastElementChild.remove();
  }

  function doorFlash() {
    doorEl.classList.add("show");
    const big = $("vkKioskDoor");
    if (big) big.classList.add("show");
    clearTimeout(doorEl.timer);
    doorEl.timer = setTimeout(() => {
      doorEl.classList.remove("show");
      if (big) big.classList.remove("show");
    }, 2600);
  }

  // ---------------- голос ----------------
  let audioEl = null,
    speechJob = 0;

  function stopPlayback() {
    speechJob++;
    if (audioEl) {
      audioEl.onended = audioEl.onerror = null;
      audioEl.pause();
      audioEl.src = "";
      audioEl = null;
    }
    try {
      speechSynthesis?.cancel();
    } catch {}
    // анализатор от предыдущей реплики может отдавать нули — губы бы замерли
    lyra?.setAnalyser(null);
    sayEl.classList.remove("talking");
  }

  function browserSay(text, job) {
    return new Promise((ok, no) => {
      if (!window.speechSynthesis) return no(Error("Нет синтеза речи в браузере."));
      lyra?.setAnalyser(null); // у голоса браузера нет WebAudio-амплитуды: губы идут по ритму
      const u = new SpeechSynthesisUtterance(text);
      const ru = (speechSynthesis.getVoices() || []).find((v) => /^ru/i.test(v.lang));
      if (ru) u.voice = ru;
      u.lang = "ru-RU";
      u.rate = 0.98;
      u.onstart = () => job === speechJob && sayEl.classList.add("talking");
      u.onend = () => {
        if (job === speechJob) sayEl.classList.remove("talking");
        ok();
      };
      u.onerror = () => no(Error("Браузер не озвучил фразу."));
      speechSynthesis.speak(u);
    });
  }

  let audioCtx = null;
  // Амплитуда живой речи управляет губами портрета, как в Лире.
  function audioAnalyser(audio) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!audioCtx || audioCtx.state === "closed") audioCtx = new AC();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      const source = audioCtx.createMediaElementSource(audio);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      return analyser;
    } catch {
      return null;
    }
  }

  async function neuralSay(text, job) {
    const speaker = prefs.voice.slice(7);
    const res = await fetch("/api/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, speaker }),
    });
    if (!res.ok) {
      let message = "Нейроголос недоступен.";
      try {
        message = (await res.json()).error || message;
      } catch {}
      throw Error(message);
    }
    const blob = await res.blob();
    if (job !== speechJob) return;
    await new Promise((ok, no) => {
      const a = new Audio(URL.createObjectURL(blob));
      audioEl = a;
      lyra?.setAnalyser(audioAnalyser(a));
      a.onplaying = () => job === speechJob && sayEl.classList.add("talking");
      a.onended = () => {
        if (job === speechJob) sayEl.classList.remove("talking");
        lyra?.setAnalyser(null);
        URL.revokeObjectURL(a.src);
        ok();
      };
      a.onerror = () => no(Error("Браузер не воспроизвёл звук."));
      a.play().catch(no);
    });
  }

  function lyraState(text) {
    const el = $("vkLyraState");
    if (el) el.textContent = text;
  }

  async function talk(text) {
    if (!text) return;
    stopPlayback();
    const job = speechJob;
    setSay(text);
    lyra?.setMode("talk");
    lyraState("говорит");
    // Реплика висит на экране, пока Лира «говорит». Если синтез оборвался сразу
    // (нет русского голоса, ошибка схемы, мгновенный onend), губы всё равно
    // должны двигаться — иначе рот замирает на середине фразы.
    const minTalk = Math.min(4000, 600 + text.length * 55);
    const startedAt = performance.now();
    try {
      if (!prefs.speak || prefs.voice === "silent") {
        await new Promise((r) => setTimeout(r, Math.min(2600, 700 + text.length * 45)));
        return;
      }
      try {
        if (prefs.voice.startsWith("neural:")) await neuralSay(text, job);
        else await browserSay(text, job);
      } catch (e) {
        if (job !== speechJob) return;
        try {
          await browserSay(text, job);
        } catch {
          toast("Голос недоступен: " + e.message + " Текст реплики показан на экране.", "bad");
        }
      }
    } finally {
      if (job === speechJob) {
        const left = minTalk - (performance.now() - startedAt);
        if (left > 0) await new Promise((r) => setTimeout(r, left));
        if (job === speechJob) {
          lyra?.setMode("idle");
          lyraState(running ? "на дежурстве" : "ждёт у двери");
        }
      }
    }
  }

  // ---------------- действия машины состояний ----------------
  function applyActions(actions) {
    for (const a of actions) {
      if (a.type === "say") talkPromise = talk(a.text);
      else if (a.type === "unlock") {
        doorFlash();
        pushLog("unlock", { title: "дверь открыта · " + (a.name || "жилец"), detail: "" });
        api("unlock", { kind: "resident", name: a.name, flat: a.flat, decision: "open" }).catch(() => {});
      } else if (a.type === "log") {
        const titles = {
          resident: "свой: " + (a.name || "жилец"),
          guest: "гость из списка: " + (a.name || ""),
          denied: "нежелательный: " + (a.name || "без имени"),
          stranger: "чужой",
          ambiguous: "похож на двух жильцов",
          visitor: "гость в квартиру " + (a.flat || "?"),
          delivery: "доставка в квартиру " + (a.flat || "?"),
        };
        pushLog(a.kind, {
          title: titles[a.kind] || a.kind,
          detail: a.decision === "refused" ? " · не пущен" : a.decision === "pending" ? " · ждёт жильца" : "",
        });
        api("visit", {
          kind: a.kind,
          name: a.name,
          flat: a.flat,
          decision: a.decision,
          distance: a.distance,
          note: a.note,
        }).catch(() => {});
      } else if (a.type === "alert") {
        pushLog("danger", { title: "внимание", detail: " · " + (a.why === "denied" ? "посетитель из чёрного списка" : "посетитель не пропущен") });
      } else if (a.type === "notify") {
        const prefix = a.kind === "delivery" ? "Курьер" : "Гость";
        toast(
          a.flat
            ? a.passed
              ? `${prefix} в квартиру ${a.flat} — проход записан в журнал.`
              : `Сообщаю квартире ${a.flat}: гость ждёт у двери.`
            : `Сообщаю жильцам: гость к ${a.name || "ним"} ждёт у двери.`,
        );
      } else if (a.type === "reset") {
        clearIdentity();
        setHeard("");
      }
    }
    renderAnswerBar();
    scheduleAutoListen();
  }

  // Авто-микрофон: как только Лира задала вопрос и договорила, вахтёр сам слушает ответ.
  let talkPromise = Promise.resolve(),
    autoAsked = -1,
    autoBroken = false;

  function scheduleAutoListen() {
    if (prefs.autoListen === false || autoBroken) return;
    talkPromise
      .catch(() => {})
      .finally(() => {
        const snap = logic.snapshot();
        if (snap.state !== "intern" || listeningAnswer) return;
        if (autoAsked === snap.deadline) return;
        autoAsked = snap.deadline;
        setTimeout(() => {
          if (!listeningAnswer && logic.snapshot().state === "intern") listenAnswer(true);
        }, 450);
      });
  }

  function renderAnswerBar() {
    const snap = logic.snapshot();
    const waiting = snap.state === "intern";
    if (answerForm.hidden === waiting) answerForm.hidden = !waiting;
    if (waiting) {
      const left = Math.max(0, Math.round((snap.deadline - Date.now()) / 1000));
      $("vkAsrHint").textContent = listeningAnswer
        ? `Слушаю ответ · осталось ${left} с`
        : prefs.autoListen === false
          ? `Жду ответа ${left} с. Включите микрофон кнопкой или введите текст.`
          : `Жду ответа ${left} с. Микрофон включится сам — или введите текст.`;
    }
  }

  setInterval(() => {
    if (!answerForm.hidden) renderAnswerBar();
  }, 1000);

  function submitAnswer(text) {
    const clean = String(text || "").trim();
    if (!clean) return;
    // Ответ уже есть — закрываем микрофон, чтобы он не перебивал ответ вахтёра.
    if (listeningAnswer) VakhtaASR.stop();
    setHeard("Гость: " + clean);
    applyActions(logic.answer(clean, Date.now()));
    answerInput.value = "";
  }

  // ---------------- главный цикл ----------------
  async function step() {
    if (!running || busy || document.hidden) return;
    if (document.querySelector("dialog[open]")) return; // во время работы с реестром не мешаем
    if (!cameraLive()) return;
    // Пока Лира говорит, распознавание идёт реже: иначе тяжёлый кадр
    // подвешивает анимацию и рот «дёргается». Человек всё равно в кадре.
    if (lyra?.mode === "talk" && Date.now() - lastStepAt < 1100) return;
    lastStepAt = Date.now();
    busy = true;
    try {
      const faces = await detectFaces(video);
      drawBoxes(faces);
      facesSeen = faces.length;
      let ident = null;
      if (faces.length === 1) {
        try {
          ident = await api("identify", {
            descriptor: Array.from(faces[0].descriptor),
            threshold: prefs.threshold,
          });
        } catch (e) {
          if (lastError !== e.message) {
            lastError = e.message;
            toast(e.message, "bad");
          }
          ident = null;
        }
        showIdentity(ident, faces[0]);
      } else if (faces.length === 0) {
        showIdentity(null, null);
      } else {
        setBadge("idle", `в кадре ${faces.length} человека`);
        drawCrop(faces[0]);
      }
      const present = faces.length === 1 && ident ? 1 : 0;
      applyActions(logic.tick({ now: Date.now(), faces: present, ident }));
    } catch (e) {
      if (lastError !== e.message) {
        lastError = e.message;
        toast(e.message, "bad");
      }
    } finally {
      busy = false;
    }
  }

  let lastStepAt = 0;

  async function startDuty() {
    if (running) return;
    $("btnDuty").disabled = true;
    topEl.textContent = "Готовлю распознавание лица…";
    try {
      await ensureCamera();
      await loadFace(); // модели лица могли ещё не загрузиться
      running = true;
      lastError = "";
      $("btnDuty").textContent = "Остановить дежурство";
      document.body.classList.add("live"); // в полноэкранном режиме показывает камеру
      syncKioskFoot();
      topEl.dataset.live = "1";
      topEl.textContent = "Дежурство идёт · камера включена";
      hintEl.hidden = true;
      loopTimer = setInterval(step, 500);
      step();
    } catch (e) {
      toast(e.name === "NotAllowedError" ? "Доступ к камере запрещён. Разрешите камеру в браузере." : e.message, "bad");
    } finally {
      $("btnDuty").disabled = false;
    }
  }

  function stopDuty(message) {
    running = false;
    document.body.classList.remove("live");
    syncKioskFoot();
    clearInterval(loopTimer);
    loopTimer = 0;
    stopPlayback();
    VakhtaASR.stop();
    stopCamera();
    logic.reset("quiet");
    $("btnDuty").textContent = "Начать дежурство";
    topEl.dataset.live = "0";
    topEl.textContent = message || "Дежурство остановлено";
    hintEl.hidden = false;
    clearIdentity();
    renderAnswerBar();
  }

  // ---------------- ответ голосом ----------------
  async function listenAnswer(auto = false) {
    if (listeningAnswer) return;
    if (auto && logic.snapshot().state !== "intern") return;
    listeningAnswer = true;
    lyra?.setMode("listen");
    lyraState("слушает гостя");
    const btn = $("btnListen");
    btn.disabled = true;
    btn.textContent = "🎙 Слушаю…";
    renderAnswerBar();
    try {
      const text = await VakhtaASR.listen({
        maxMs: 9000,
        silenceMs: 1500,
        onPartial: (t) => {
          setHeard("Слышу: " + t);
        },
        onState: (s) => {
          if (s === "model") toast("Загружаю русскую модель распознавания…");
        },
      });
      if (text) submitAnswer(text);
      else if (!auto) toast("Не расслышал ответ. Введите текстом или скажите ещё раз.");
      else toast("Не расслышал — нажмите «Сказать голосом» или введите ответ текстом.");
    } catch (e) {
      if (auto) {
        autoBroken = true; // больше не пытаемся сами: обычно это запрет микрофона
        toast("Авто-микрофон не запустился: " + e.message + " Включите кнопкой «Сказать голосом».", "bad");
      } else toast("Микрофон недоступен: " + e.message, "bad");
    } finally {
      listeningAnswer = false;
      // Ответ мог прийти прямо из распознавания: submitAnswer уже запустил
      // реплику. Не сбрасываем портрет в «молчит», иначе рот замирает
      // ровно на фразе вахтёра (например, на отказе).
      if (lyra?.mode !== "talk") {
        lyra?.setMode("idle");
        lyraState(running ? "на дежурстве" : "ждёт у двери");
      }
      btn.disabled = false;
      btn.textContent = "🎙 Сказать голосом (локально, Vosk)";
      renderAnswerBar();
    }
  }

  // ---------------- реестр и редактор жильцов ----------------
  const MAX_SAMPLES = 5;
  let samples = []; // новые шаблоны, снятые прямо сейчас
  let editingId = null; // null — добавляем человека, иначе правим существующего
  let photoData = null; // миниатюра для карточки: data URL JPEG
  let photoTouched = false;

  function canSave() {
    if (!$("eName").value.trim()) return false;
    return editingId ? true : samples.length > 0;
  }

  function renderSamples() {
    $("eCount").textContent = samples.length;
    $("eShoot").disabled = samples.length >= MAX_SAMPLES;
    $("eSave").disabled = !canSave();
  }

  function renderPhoto() {
    const img = $("ePhotoImg");
    if (photoData) {
      img.src = photoData;
      img.hidden = false;
      $("ePhotoEmpty").hidden = true;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
      $("ePhotoEmpty").hidden = false;
    }
    $("ePhotoClear").hidden = !photoData;
  }

  // Квадратная миниатюра лица для карточки жильца (240×240, JPEG).
  function thumbnail(face, source, mirror) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 240;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const box = face.detection.box,
      size = Math.max(box.width, box.height) * 1.75,
      cx = box.x + box.width / 2,
      cy = box.y + box.height / 2;
    ctx.save();
    if (mirror) {
      ctx.translate(240, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source, cx - size / 2, cy - size / 2, size, size, 0, 0, 240, 240);
    ctx.restore();
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  async function addSampleFromImage(source, mirror = false) {
    if (samples.length >= MAX_SAMPLES) throw Error("Уже пять шаблонов — больше не нужно.");
    const faces = await detectFaces(source);
    if (faces.length !== 1)
      throw Error(
        faces.length ? "На кадре несколько лиц — нужен один человек." : "Не вижу лица: свет, анфас, без маски.",
      );
    samples.push(Array.from(faces[0].descriptor));
    if (!photoData) {
      photoData = thumbnail(faces[0], source, mirror);
      photoTouched = true;
      renderPhoto();
    }
    renderSamples();
  }

  async function shoot() {
    const status = $("eStatus");
    status.className = "vk-status";
    status.textContent = "Снимаю кадр…";
    try {
      await ensureCamera();
      await new Promise((r) => setTimeout(r, 250));
      await addSampleFromImage(video, true);
      status.className = "vk-status ok";
      status.textContent = `Шаблон ${samples.length} записан. Снимите ещё, чуть повернув голову.`;
    } catch (e) {
      status.className = "vk-status bad";
      status.textContent = e.message;
    }
  }

  async function photos(files) {
    const status = $("eStatus");
    status.className = "vk-status";
    status.textContent = "Разбираю фото…";
    let added = 0,
      failed = 0;
    for (const file of files) {
      if (samples.length >= MAX_SAMPLES) break;
      try {
        const bmp = await createImageBitmap(file);
        const c = document.createElement("canvas");
        const scale = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
        c.width = Math.round(bmp.width * scale);
        c.height = Math.round(bmp.height * scale);
        c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
        await addSampleFromImage(c);
        added++;
      } catch (e) {
        failed++;
      }
    }
    status.className = failed && !added ? "vk-status bad" : "vk-status ok";
    status.textContent =
      failed && !added
        ? "Не удалось найти одно лицо на фото."
        : `Добавлено кадров: ${added}. Новых шаблонов: ${samples.length}.` + (failed ? ` Пропущено: ${failed}.` : "");
  }

  function setFormOpen(open) {
    const dlg = $("dlgRegistry");
    dlg.classList.toggle("formOpen", !!open);
    $("eToggle").textContent = open ? "Свернуть форму" : "+ Добавить человека";
    $("eToggle").setAttribute("aria-expanded", String(!!open));
  }

  function resetEditor() {
    editingId = null;
    samples = [];
    photoData = null;
    photoTouched = false;
    $("eTitle").textContent = "Добавить человека";
    $("eName").value = "";
    $("eFlat").value = "";
    $("eNote").value = "";
    $("eRole").value = "resident";
    $("eCancel").hidden = true;
    renderSamples();
    renderPhoto();
  }

  function startEdit(person, photo) {
    setFormOpen(true);
    editingId = person.id;
    samples = [];
    photoData = photo && photo.startsWith("data:image/jpeg") ? photo : null;
    photoTouched = false;
    $("eTitle").textContent = "Редактировать: " + person.name;
    $("eName").value = person.name;
    $("eFlat").value = person.flat || "";
    $("eRole").value = person.role;
    $("eNote").value = person.note || "";
    $("eCancel").hidden = false;
    const status = $("eStatus");
    status.className = "vk-status";
    status.textContent = `В реестре ${person.samples} шаблон(ов) лица. Новые кадры добавятся к ним.`;
    renderSamples();
    renderPhoto();
    $("eName").focus();
  }

  async function savePerson(event) {
    event.preventDefault();
    const status = $("eStatus");
    const name = $("eName").value.trim();
    const flat = $("eFlat").value.trim();
    const role = $("eRole").value;
    const note = $("eNote").value.trim();
    if (!name) {
      status.className = "vk-status bad";
      status.textContent = "Укажите имя.";
      return;
    }
    if (!editingId && !samples.length) {
      status.className = "vk-status bad";
      status.textContent = "Сначала снимите кадр с камеры или загрузите фото.";
      return;
    }
    $("eSave").disabled = true;
    let message = "",
      tone = "vk-status ok";
    try {
      if (editingId) {
        const body = { id: editingId, name, flat, role, note };
        if (samples.length) body.appendSamples = samples;
        if (photoTouched) body.photo = photoData;
        const out = await api("update", body);
        message = `${out.person.name}: сохранено, шаблонов ${out.person.samples}${out.person.hasPhoto ? ", с фото" : ""}.`;
        toast("Изменения сохранены.");
      } else {
        const out = await api("enroll", { name, flat, role, note, samples, photo: photoData || undefined });
        message = `${out.person.name} записан в реестр. Проверьте в кадре — вахтёр должен узнать.`;
        toast(`${out.person.name} добавлен в реестр вахты.`);
      }
      resetEditor();
      if (flat) {
        const rooms = readOpenRooms();
        rooms.add(flat);
        saveOpenRooms(rooms); // только что изменённая квартира должна быть раскрыта
      }
      await renderRegistry();
    } catch (e) {
      message = e.message;
      tone = "vk-status bad";
    } finally {
      status.className = tone;
      status.textContent = message;
      renderSamples();
    }
  }

  function personCard(person) {
    const labels = { resident: "жилец", guest: "гость", denied: "не пускать" };
    const card = document.createElement("article");
    card.className = "vk-person";
    card.dataset.role = person.role;

    const avatar = document.createElement("div");
    avatar.className = "vk-personPhoto";
    if (person.hasPhoto) {
      const img = document.createElement("img");
      img.alt = "Фото: " + person.name;
      avatar.append(img);
      api("photo", { id: person.id })
        .then((out) => {
          if (out.photo) img.src = out.photo;
        })
        .catch(() => {});
    } else {
      avatar.classList.add("initials");
      avatar.textContent = (person.name || "?").trim().slice(0, 2).toUpperCase();
    }

    const info = document.createElement("div");
    info.className = "vk-personInfo";
    const name = document.createElement("b");
    name.textContent = person.name;
    const meta = document.createElement("span");
    meta.className = "vk-personMeta";
    meta.textContent = [
      person.flat ? "кв. " + person.flat : "без квартиры",
      labels[person.role] || person.role,
      person.samples + " шабл.",
    ].join(" · ");
    info.append(name, meta);
    if (person.note) {
      const note = document.createElement("i");
      note.textContent = person.note;
      info.append(note);
    }

    const actions = document.createElement("div");
    actions.className = "vk-personActions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "vk-btn";
    edit.textContent = "Изменить";
    edit.onclick = () => startEdit(person, avatar.querySelector("img")?.src || null);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "vk-btn danger";
    del.textContent = "Удалить";
    del.onclick = async () => {
      if (!confirm(`Удалить ${person.name} из реестра вместе с шаблонами лица и фото?`)) return;
      try {
        await api("delete", { id: person.id });
        if (editingId === person.id) {
          resetEditor();
          $("eStatus").textContent = "";
        }
        await renderRegistry();
        toast(`${person.name} удалён из реестра.`);
      } catch (e) {
        toast(e.message, "bad");
      }
    };
    actions.append(edit, del);
    card.append(avatar, info, actions);
    return card;
  }

  // ---------------- реестр: комнаты (квартиры) ----------------
  const ROOMS_KEY = "lyra.vakhta.rooms"; // какие комнаты развёрнуты
  let regQuery = "",
    regRole = "";

  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100,
      b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b === 1) return one;
    if (b >= 2 && b <= 4) return few;
    return many;
  }

  // «2» < «10» < «118б» — иначе 150 квартир сортируются как строки.
  function flatCompare(a, b) {
    const num = (v) => parseInt(String(v).replace(/[^0-9]/g, ""), 10);
    const na = num(a),
      nb = num(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "ru");
  }

  function roomKey(person) {
    return String(person.flat || "").trim() || "—";
  }

  function readOpenRooms() {
    try {
      const raw = JSON.parse(localStorage.getItem(ROOMS_KEY) || "[]");
      return new Set(Array.isArray(raw) ? raw : []);
    } catch {
      return new Set();
    }
  }

  function saveOpenRooms(set) {
    try {
      localStorage.setItem(ROOMS_KEY, JSON.stringify([...set].slice(0, 400)));
    } catch {}
  }

  function roomHead(key, people) {
    const head = document.createElement("button");
    head.type = "button";
    head.className = "vk-roomHead";
    const title = document.createElement("b");
    title.textContent = key === "—" ? "Без квартиры" : "Кв. " + key;
    const count = document.createElement("span");
    count.className = "vk-roomCount";
    count.textContent = `${people.length} ${plural(people.length, "человек", "человека", "человек")}`;
    const arrow = document.createElement("span");
    arrow.className = "vk-roomArrow";
    arrow.textContent = "▸";
    arrow.setAttribute("aria-hidden", "true");
    head.append(title, count, arrow);
    return head;
  }

  function roomBlock(key, people, openRooms, forceOpen) {
    const room = document.createElement("section");
    room.className = "vk-room";
    const open = forceOpen || openRooms.has(key);
    room.dataset.open = String(open);
    const head = roomHead(key, people);
    head.setAttribute("aria-expanded", String(open));
    const body = document.createElement("div");
    body.className = "vk-roomBody";
    for (const person of people) body.append(personCard(person));
    head.onclick = () => {
      const next = room.dataset.open !== "true";
      room.dataset.open = String(next);
      head.setAttribute("aria-expanded", String(next));
      if (next) openRooms.add(key);
      else openRooms.delete(key);
      saveOpenRooms(openRooms);
    };
    room.append(head, body);
    return room;
  }

  function renderFlatOptions(people) {
    const list = $("eFlatList");
    if (!list) return;
    list.textContent = "";
    const flats = [...new Set(people.map(roomKey).filter((f) => f !== "—"))].sort(flatCompare);
    for (const flat of flats) {
      const option = document.createElement("option");
      option.value = flat;
      list.append(option);
    }
  }

  async function renderRegistry() {
    const box = $("vkRegistryList");
    box.textContent = "";
    let people = [];
    try {
      people = (await api("list", {})).residents;
      logic.setPeople(people); // вахтёр ищет жильца по фамилии из реестра
    } catch (e) {
      box.innerHTML = '<p class="vk-status bad"></p>';
      box.querySelector("p").textContent = e.message;
      return;
    }
    renderFlatOptions(people);
    // в большой базе форма не должна занимать пол-экрана: её раскрывает кнопка
    if (!editingId) setFormOpen(people.length <= 12);
    const count = $("vkRegCount");
    if (!people.length) {
      count.textContent = "";
      box.innerHTML = '<p class="vk-note">Реестр пуст — добавьте первого жильца в форме ниже.</p>';
      return;
    }
    const query = regQuery.trim().toLowerCase();
    const shown = people.filter((p) => {
      if (regRole && p.role !== regRole) return false;
      if (!query) return true;
      return `${p.name} ${p.flat || ""} ${p.note || ""}`.toLowerCase().includes(query);
    });
    const rooms = new Map();
    for (const person of shown) {
      const key = roomKey(person);
      if (!rooms.has(key)) rooms.set(key, []);
      rooms.get(key).push(person);
    }
    const flats = rooms.size;
    count.textContent =
      `${flats} ${plural(flats, "квартира", "квартиры", "квартир")} · ` +
      `${shown.length} ${plural(shown.length, "человек", "человека", "человек")}` +
      (shown.length !== people.length ? ` из ${people.length}` : "");
    if (!shown.length) {
      box.innerHTML = '<p class="vk-note">Никого не нашли. Измените запрос или фильтр.</p>';
      return;
    }
    const openRooms = readOpenRooms();
    // мало квартир — раскрываем все; много — оставляем свёрнутыми, чтобы список был обозримым
    const forceOpen = !!query || flats <= 4;
    const sorted = [...rooms.entries()].sort((a, b) => {
      if (a[0] === "—") return 1;
      if (b[0] === "—") return -1;
      return flatCompare(a[0], b[0]);
    });
    for (const [key, group] of sorted) {
      group.sort((a, b) => a.name.localeCompare(b.name, "ru"));
      box.append(roomBlock(key, group, openRooms, forceOpen));
    }
  }

  // ---------------- портрет Лиры и полноэкранный режим ----------------
  let kiosk = false;
  const kioskEl = $("vkKiosk"),
    lyraCanvas = $("vkLyra");

  function syncKioskFoot() {
    const where = $("vkKioskWhere");
    if (where) where.textContent = running ? "на дежурстве · камера работает" : "дежурство не начато";
  }

  function enterKiosk() {
    if (kiosk) return;
    kiosk = true;
    $("vkKioskFrame").append(lyraCanvas); // тот же риг, просто крупнее и в центре
    kioskEl.hidden = false;
    document.body.classList.add("kiosk");
    document.body.style.overflow = "hidden";
    $("vkKioskSay").textContent = sayEl.textContent || "";
    $("vkKioskBadge").textContent = badgeEl.textContent;
    $("vkKioskBadge").dataset.tone = badgeEl.dataset.tone || "idle";
    $("vkKioskHeard").textContent = heardEl.textContent;
    $("vkKioskHeard").hidden = heardEl.hidden;
    syncKioskFoot();
    const root = document.documentElement;
    if (root.requestFullscreen && !document.fullscreenElement)
      root.requestFullscreen().catch(() => {});
    if (lyra) lyraCanvas.classList.toggle("custom", lyra.character === "custom");
    toast("Полноэкранный режим: Esc — выход.");
  }

  function exitKiosk(withFullscreen = true) {
    if (!kiosk) return;
    kiosk = false;
    $("vkLyraFrame").append(lyraCanvas);
    kioskEl.hidden = true;
    document.body.classList.remove("kiosk");
    document.body.style.overflow = "";
    if (withFullscreen && document.fullscreenElement)
      document.exitFullscreen?.().catch(() => {});
  }

  function initLyra() {
    lyra = VakhtaLyra.create(lyraCanvas, {
      onChange(who) {
        $("vkLyraWho").textContent = who === "custom" ? "СВОЙ ПОРТРЕТ" : "ЛИРА";
        $("vkKioskName").textContent =
          who === "custom" ? "ВАХТЁР · СВОЙ ПОРТРЕТ" : "ВАХТЁР · ЛИРА";
      },
    });
    lyra.start();
    lyra.loadPortrait();
    window.__vakhtaLyra = lyra; // для проверок в e2e и отладки
    lyraState("ждёт у двери");
    lyraCanvas.addEventListener("pointermove", (e) => {
      const rect = lyraCanvas.getBoundingClientRect();
      if (rect.width) lyra.setPointer((e.clientX - rect.left) / rect.width);
    });
    // портрет могли сменить на главной странице в другой вкладке
    window.addEventListener("storage", (e) => {
      if (e.key === VakhtaLyra.PORTRAIT_KEY) lyra.loadPortrait();
    });
  }

  $("btnKiosk").onclick = enterKiosk;
  $("btnKioskTop").onclick = enterKiosk;
  $("btnKioskExit").onclick = () => exitKiosk(true);
  $("btnPortrait").onclick = async () => {
    const ok = await lyra.loadPortrait();
    toast(
      ok
        ? "Портрет взят с главной страницы Лиры: это тот же персонаж."
        : "На главной выбран стандартный портрет Лиры — показываю его.",
    );
  };
  document.addEventListener("keydown", (e) => {
    // Esc выходит и из полноэкранного режима браузера, и из нашей сцены
    if (e.key === "Escape" && kiosk) exitKiosk(true);
    if (e.key === "f" && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) {
      if (kiosk) exitKiosk(true);
      else enterKiosk();
    }
  });
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && kiosk) exitKiosk(false);
  });

  // ---------------- настройки ----------------
  function renderSettings() {
    $("sThreshold").value = prefs.threshold;
    $("sThresholdOut").textContent = Number(prefs.threshold).toFixed(2);
    $("sCooldown").value = prefs.cooldown;
    $("sCooldownOut").textContent = prefs.cooldown;
    $("sAnswer").value = prefs.answer;
    $("sAnswerOut").textContent = prefs.answer;
    $("sVoice").value = prefs.voice;
    $("sSpeak").checked = !!prefs.speak;
    $("sAutoListen").checked = prefs.autoListen !== false;
    $("sPassGuests").checked = !!prefs.passGuests;
    $("sPassDelivery").checked = prefs.passDelivery !== false;
    $("sPin").value = readPin();
  }

  function savePrefs() {
    write(PREFS_KEY, prefs);
    logic.setConfig({
      cooldownMs: prefs.cooldown * 1000,
      answerMs: prefs.answer * 1000,
      passGuests: !!prefs.passGuests,
      passDelivery: prefs.passDelivery !== false,
    });
  }

  // ---------------- демо ----------------
  function demo(status) {
    const idents = {
      resident: { status: "resident", match: { name: "Иван Петров", flat: "42" }, distance: 0.31 },
      guest: { status: "guest", match: { name: "Анна Смирнова", flat: "8" }, distance: 0.34 },
      denied: { status: "denied", match: { name: "Пётр Сидоров", flat: "" }, distance: 0.4 },
      unknown: { status: "unknown", match: null, distance: 0.74 },
      ambiguous: { status: "ambiguous", match: null, distance: 0.47 },
    };
    if (status === "leave") {
      applyActions(logic.tick({ now: Date.now() + 60000, faces: 0, ident: null }));
      clearIdentity();
      toast("Человек ушёл из кадра — сценарий сброшен.");
      return;
    }
    const ident = idents[status];
    if (!ident) return;
    logic.reset("quiet");
    const now = Date.now();
    let actions = [];
    for (let i = 0; i < 3; i++)
      actions = logic.tick({ now: now + i, faces: 1, ident });
    showIdentity(ident, null);
    $("vkName").textContent = ident.match?.name || "неизвестный";
    $("vkFlat").textContent = ident.match?.flat || "—";
    applyActions(actions);
  }

  // ---------------- тест по фото ----------------
  async function testPhoto(file) {
    stopPlayback();
    setSay("Смотрю фото…");
    try {
      const bmp = await createImageBitmap(file);
      const c = document.createElement("canvas");
      const scale = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const faces = await detectFaces(c);
      if (faces.length !== 1) {
        setSay(faces.length ? "На фото несколько лиц." : "На фото не видно лица.");
        return;
      }
      const ctx = cropCanvas.getContext("2d");
      if (!ctx) throw Error("Браузер не умеет рисовать на canvas.");
      const b = faces[0].detection.box;
      const pad = b.width * 0.45,
        size = Math.max(b.width, b.height) + pad * 2;
      ctx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
      ctx.drawImage(c, b.x + b.width / 2 - size / 2, b.y + b.height / 2 - size / 2, size, size, 0, 0, cropCanvas.width, cropCanvas.height);
      cropCanvas.classList.add("on");
      $("vkFaceEmpty").hidden = true;
      const ident = await api("identify", { descriptor: Array.from(faces[0].descriptor), threshold: prefs.threshold });
      showIdentity(ident, null);
      logic.reset("quiet");
      const now = Date.now();
      let actions = [];
      for (let i = 0; i < 3; i++) actions = logic.tick({ now: now + i, faces: 1, ident });
      applyActions(actions);
      if (ident.status === "unknown") toast("Такой человек не записан — вахтёр спросит «зачем пришли».");
    } catch (e) {
      setSay("");
      toast(e.message, "bad");
    }
  }

  // ---------------- привязка интерфейса ----------------
  $("btnDuty").onclick = () => (running ? stopDuty() : startDuty());
  $("btnListen").onclick = () => {
    if (listeningAnswer) {
      VakhtaASR.stop();
      toast("Прослушивание остановлено.");
    } else listenAnswer(false);
  };
  answerForm.onsubmit = (e) => {
    e.preventDefault();
    submitAnswer(answerInput.value);
  };
  $("btnPhoto").onclick = () => $("vkPhotoInput").click();
  $("vkPhotoInput").onchange = (e) => {
    const file = e.target.files?.[0];
    if (file) testPhoto(file);
    e.target.value = "";
  };
  $("btnDemoBar").onclick = () => {
    const bar = $("vkDemo");
    bar.hidden = !bar.hidden;
    $("btnDemoBar").setAttribute("aria-expanded", String(!bar.hidden));
  };
  $("vkDemo").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-demo]");
    if (!btn) return;
    const what = btn.dataset.demo;
    if (what === "answer") submitAnswer("Я к Ивановым в квартиру 42, курьер");
    else if (what === "refuse") submitAnswer("Открой, я тут живу, не твоё дело");
    else demo(what);
  });

  $("btnRegistry").onclick = async () => {
    resetEditor();
    $("eStatus").textContent = "";
    regQuery = "";
    regRole = "";
    $("vkRegSearch").value = "";
    for (const b of $("vkRegFilters").querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(!b.dataset.role));
    $("dlgRegistry").showModal();
    await renderRegistry();
  };
  $("eToggle").onclick = () => {
    const open = !$("dlgRegistry").classList.contains("formOpen");
    setFormOpen(open);
    if (open) $("eName").focus();
  };
  $("vkRegSearch").oninput = () => {
    regQuery = $("vkRegSearch").value;
    renderRegistry();
  };
  $("vkRegFilters").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-role]");
    if (!btn) return;
    regRole = btn.dataset.role;
    for (const b of $("vkRegFilters").querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(b === btn));
    renderRegistry();
  });
  $("btnJournal").onclick = async () => {
    $("dlgJournal").showModal();
    await renderJournal();
  };
  $("btnSettings").onclick = () => {
    renderSettings();
    $("dlgSettings").showModal();
  };
  $("dlgRegistry").addEventListener("close", () => {
    if (!running) stopCamera(); // камеру включали только для съёмки шаблона
    resetEditor();
    $("eStatus").textContent = "";
  });

  $("eCancel").onclick = () => {
    resetEditor();
    $("eStatus").className = "vk-status";
    $("eStatus").textContent = "Редактирование отменено.";
  };
  $("ePhotoClear").onclick = () => {
    photoData = null;
    photoTouched = true;
    renderPhoto();
    $("eStatus").className = "vk-status";
    $("eStatus").textContent = "Фото будет удалено при сохранении.";
  };
  $("eName").oninput = renderSamples;

  $("eShoot").onclick = shoot;
  $("eClear").onclick = () => {
    samples = [];
    renderSamples();
    $("eStatus").textContent = "Шаблоны очищены.";
  };
  $("ePhotos").onchange = (e) => {
    if (e.target.files?.length) photos([...e.target.files]);
    e.target.value = "";
  };
  $("vkEnrollForm").onsubmit = savePerson;

  const bindRange = (id, key, out, scale = 1) => {
    $(id).oninput = () => {
      prefs[key] = Number($(id).value);
      $(out).textContent = scale === 1 ? prefs[key] : prefs[key].toFixed(2);
      savePrefs();
    };
  };
  bindRange("sThreshold", "threshold", "sThresholdOut", 0.01);
  bindRange("sCooldown", "cooldown", "sCooldownOut");
  bindRange("sAnswer", "answer", "sAnswerOut");
  $("sVoice").onchange = () => {
    prefs.voice = $("sVoice").value;
    savePrefs();
    if (prefs.voice !== "silent") talk("Здравствуйте! Проходите, пожалуйста.");
  };
  $("sSpeak").onchange = () => {
    prefs.speak = $("sSpeak").checked;
    savePrefs();
    if (!prefs.speak) stopPlayback();
  };
  $("sAutoListen").onchange = () => {
    prefs.autoListen = $("sAutoListen").checked;
    savePrefs();
    autoBroken = false;
    if (!prefs.autoListen) VakhtaASR.stop();
  };
  $("sPassDelivery").onchange = () => {
    prefs.passDelivery = $("sPassDelivery").checked;
    savePrefs();
    toast(
      prefs.passDelivery
        ? "Курьеры с номером квартиры проходят сразу, жильцам приходит уведомление в журнале."
        : "Курьеры тоже ждут подтверждения жильца.",
    );
  };
  $("sPassGuests").onchange = () => {
    prefs.passGuests = $("sPassGuests").checked;
    savePrefs();
    toast(
      prefs.passGuests
        ? "Гости, назвавшие квартиру, будут проходить без подтверждения жильца."
        : "Гости ждут подтверждения жильца — дверь вахтёр не открывает.",
    );
  };
  $("sPin").onchange = () => {
    try {
      localStorage.setItem(PIN_KEY, $("sPin").value.trim());
    } catch {}
  };
  $("sForget").onclick = async () => {
    if (!confirm("Удалить все шаблоны лиц? Жильцов придётся записать заново.")) return;
    try {
      await api("forgetAll", {});
      await renderRegistry();
      toast("Биометрия реестра удалена.");
    } catch (e) {
      toast(e.message, "bad");
    }
  };

  window.addEventListener("pagehide", () => {
    if (running) stopDuty("Дежурство остановлено");
    else stopCamera();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && running) {
      stopDuty("Вкладка скрыта — дежурство остановлено");
      toast("Дежурство остановлено: вкладка была скрыта. Нажмите «Начать дежурство» снова.");
    }
  });

  // стартовое состояние
  try {
    initLyra();
  } catch (e) {
    // без портрета вахтёр работает: текст и голос остаются
    $("vkLyraFrame").hidden = true;
    console.warn("Портрет Лиры недоступен:", e.message);
  }
  loadFace().catch(() => {}); // прогреваем модели лица, пока вахтёр не нужен
  resetEditor();
  clearIdentity();
  api("list", {})
    .then((out) => {
      logic.setPeople(out.residents);
      topEl.textContent = `Готов к дежурству · в реестре ${out.residents.length} чел.`;
      if (!out.residents.length)
        toast("Реестр пуст: откройте «Жильцы» и запишите первого жильца.");
    })
    .catch((e) => toast(e.message, "bad"));
})();
