// Frames are sampled only by explicit actions; face matching never leaves the browser.
window.Camera = (() => {
  const video = $("cameraVideo"),
    panel = $("cameraPanel"),
    key = "lyra:face:1",
    btn = $("cameraToggle");
  const modelSelect = $('visionModel');
  modelSelect.value = load('lyra:vision:model', '') === 'lfm3-omni' ? 'lfm3-omni' : 'gemma3:4b';
  modelSelect.onchange = () => store('lyra:vision:model', modelSelect.value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname),
    say = (s) => {
      $("cameraStatus").textContent = s;
    };
  let epoch = 0,
    stream = null,
    pending = false,
    busy = false,
    models = null,
    cancelVision = null;
  const reference = () => {
    const a = load(key, null);
    return Array.isArray(a) && a.length === 128 && a.every(Number.isFinite)
      ? new Float32Array(a)
      : null;
  };
  function ui() {
    const live = !!stream;
    btn.textContent = pending
      ? "Отменить включение"
      : live
        ? "Выключить камеру"
        : "Включить камеру";
    btn.setAttribute("aria-pressed", String(live));
    video.hidden = !live;
    $("cameraEnroll").disabled = !live || busy;
    $("cameraMatch").disabled = !live || busy || !reference();
    $("cameraAsk").disabled = !live || busy;
    $("cameraForget").disabled = !reference();
  }
  function stop(message = "Камера выключена.") {
    epoch++;
    pending = busy = false;
    cancelVision?.abort();
    cancelVision = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    ui();
    say(message);
  }
  async function start() {
    if (!local) {
      say("Откройте http://localhost:8000 на своём компьютере.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      say(
        "Браузер не предоставил доступ к камере. Откройте Лиру отдельной вкладкой на localhost.",
      );
      return;
    }
    const id = ++epoch;
    pending = true;
    ui();
    say("Ожидаю разрешения камеры…");
    try {
      const st = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 960 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      if (id !== epoch) {
        st.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = st;
      video.srcObject = st;
      await video.play();
      if (id !== epoch) return;
      pending = false;
      ui();
      st.getVideoTracks()[0].onended = () => {
        if (id === epoch) stop("Камера отключена устройством.");
      };
      say("Камера включена. Для анализа задайте вопрос или выберите действие.");
    } catch (e) {
      if (id === epoch)
        stop(
          e.name === "NotAllowedError"
            ? "Доступ запрещён. Проверьте разрешение камеры в браузере и в настройках macOS."
            : "Камера недоступна. Проверьте подключение и доступ к ней.",
        );
    }
  }
  btn.onclick = () => (stream || pending ? stop() : start());
  panel.addEventListener("toggle", () => {
    if (!panel.open) stop();
  });
  window.addEventListener("pagehide", () => stop());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
  });
  function frame() {
    if (!stream || video.readyState < 2 || !video.videoWidth)
      throw Error("Сначала включите камеру и дождитесь изображения.");
    const c = document.createElement("canvas"),
      scale = Math.min(1, 768 / Math.max(video.videoWidth, video.videoHeight));
    c.width = Math.max(1, Math.round(video.videoWidth * scale));
    c.height = Math.max(1, Math.round(video.videoHeight * scale));
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    return c;
  }
  function ready() {
    if (!models)
      models = (async () => {
        if (!window.faceapi)
          await new Promise((ok, no) => {
            const s = document.createElement("script");
            s.src = "assets/face/face-api.min.js";
            s.onload = ok;
            s.onerror = no;
            document.head.append(s);
          });
        await Promise.all(
          [
            faceapi.nets.tinyFaceDetector,
            faceapi.nets.faceLandmark68TinyNet,
            faceapi.nets.faceRecognitionNet,
          ].map((n) => n.loadFromUri("assets/face")),
        );
      })().catch(() => {
        models = null;
        throw Error(
          "Не загрузились модули лица. Проверьте, что assets/face распакована полностью.",
        );
      });
    return models;
  }
  async function descriptor(id, img) {
    say("Сверяю лицо в браузере…");
    await ready();
    if (id !== epoch) throw Error("Операция отменена.");
    const faces = await faceapi
      .detectAllFaces(
        img,
        new faceapi.TinyFaceDetectorOptions({
          inputSize: 416,
          scoreThreshold: 0.45,
        }),
      )
      .withFaceLandmarks(true)
      .withFaceDescriptors();
    if (id !== epoch) throw Error("Операция отменена.");
    if (faces.length !== 1)
      throw Error(
        faces.length
          ? "В кадре несколько лиц. Для сравнения нужен один человек."
          : "Не различаю лицо. Посмотрите в камеру при хорошем освещении.",
      );
    return faces[0].descriptor;
  }
  $("cameraEnroll").onclick = async () => {
    if (
      busy ||
      !stream ||
      !confirm(
        "Сохранить числовой образец вашего лица в этом браузере? Предыдущий образец будет заменён. Фото не сохраняется.",
      )
    )
      return;
    const id = epoch;
    busy = true;
    ui();
    try {
      const d = await descriptor(id, frame());
      localStorage.setItem(key, JSON.stringify(Array.from(d)));
      say("Образец вашего лица сохранён. Попробуйте «Ты меня узнаёшь?»");
    } catch (e) {
      if (id === epoch) say(e.message);
    } finally {
      if (id === epoch) {
        busy = false;
        ui();
      }
    }
  };
  $("cameraForget").onclick = () => {
    if (confirm("Удалить образец лица из этого браузера?")) {
      try {
        localStorage.removeItem(key);
        stop("Образец лица удалён. Камера выключена.");
      } catch {
        say("Браузер не разрешил удалить образец.");
      }
    }
  };
  function intent(s) {
    const x = s
      .toLowerCase()
      .trim()
      .replace(/^лира[,\s]+/u, "")
      .replace(/[?!.,]+$/u, "")
      .trim();
    if (/^(?:ты меня узна[её]шь|узна[её]шь меня|это я|узнай меня)$/u.test(x))
      return "match";
    if (
      /^(?:что (?:ты )?видишь|что (?:у меня )?в рук[еах]+|что (?:сейчас )?в кадре|что я держу|посмотри (?:в камеру|на кадр)|опиши (?:кадр|что видишь))(?:$|[\s,:])/u.test(
        x,
      )
    )
      return "scene";
    return null;
  }
  async function answer(kind, question, signal) {
    if (!stream)
      return "Камера выключена. Откройте «Камера» и нажмите «Включить камеру».";
    if (busy) throw Error("Дождитесь окончания обработки кадра.");
    const id = epoch;
    busy = true;
    ui();
    let abort = null,
      onAbort = null;
    try {
      if (kind === "match") {
        const ref = reference();
        if (!ref) return "Образца пока нет. Нажмите «Запомнить моё лицо».";
        const d = await descriptor(id, frame());
        if (signal.aborted) throw Error("Сравнение отменено.");
        const distance = Math.hypot(...d.map((v, i) => v - ref[i]));
        const result =
          distance < 0.52
            ? "Да, лицо похоже на ваш сохранённый образец."
            : "Не уверена, что это вы. Попробуйте посмотреть прямо в камеру.";
        say(result);
        return result;
      }
      const image = frame().toDataURL("image/jpeg", 0.8).split(",")[1];
      abort = cancelVision = new AbortController();
      onAbort = () => abort.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      say("Отправляю один кадр локальной модели зрения…");
      const r = await fetch("/api/vision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, image, model: modelSelect.value }),
        signal: abort.signal,
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error || "Ошибка модели зрения.");
      if (id !== epoch || signal.aborted) throw Error("Операция отменена.");
      say("Ответ по кадру — в чате.");
      return d.answer;
    } catch (e) {
      const m =
        e.name === "AbortError" ? "Обработка кадра отменена." : e.message;
      if (id === epoch) say(m);
      throw Error(m);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      if (id === epoch) {
        cancelVision = null;
        busy = false;
        ui();
      }
    }
  }
  $("cameraForm").onsubmit = (e) => {
    e.preventDefault();
    send($("cameraQuestion").value.trim() || "Что ты видишь?", "scene");
  };
  $("cameraMatch").onclick = () => send("Ты меня узнаёшь?", "match");
  ui();
  return { intent, answer };
})();
