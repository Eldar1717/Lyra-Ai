// Локальное распознавание ответа гостя (Vosk, модель уже лежит в /assets/asr).
// Аудио не покидает компьютер. Если модель или микрофон недоступны, интерфейс
// вахтёра предложит ввести ответ с клавиатуры — сценарий не блокируется.
const VakhtaASR = (() => {
  let modelPromise = null,
    session = null;

  function loadScript(src) {
    return new Promise((ok, no) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = ok;
      s.onerror = () => no(Error("Не загрузился модуль Vosk. Проверьте /assets/asr/vosk.js."));
      document.head.append(s);
    });
  }

  function loadModel() {
    if (modelPromise) return modelPromise;
    modelPromise = (async () => {
      if (!window.Vosk) await loadScript("/assets/asr/vosk.js");
      return new Promise((ok, no) => {
        const model = new Vosk.Model(new URL("/assets/asr/ru-small.tar.gz", location.href).href, -1);
        let done = false;
        const fail = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          model.terminate?.();
          no(Error("Русская модель Vosk не загрузилась. Проверьте /assets/asr/ru-small.tar.gz."));
        };
        const timer = setTimeout(fail, 120000);
        model.on("error", fail);
        model.on("load", (m) => {
          if (!m?.result) return fail();
          if (done) return;
          done = true;
          clearTimeout(timer);
          ok(model);
        });
      });
    })().catch((e) => {
      modelPromise = null; // следующая попытка начнётся с чистого листа
      throw e;
    });
    return modelPromise;
  }

  function stop() {
    const s = session;
    session = null;
    s?.cancel?.();
  }

  /**
   * Слушает микрофон до паузы в речи. Возвращает распознанный текст.
   * options: { maxMs, silenceMs, onPartial, onState }
   */
  async function listen(options = {}) {
    const maxMs = Math.max(2000, Math.min(options.maxMs || 9000, 20000));
    const silenceMs = options.silenceMs || 1600;
    const state = (s) => options.onState?.(s);
    const partial = (t) => options.onPartial?.(t);
    stop();
    if (!navigator.mediaDevices?.getUserMedia)
      throw Error("Для микрофона откройте вахтёра на localhost или по HTTPS.");
    state("model");
    const model = await loadModel();
    state("mic");
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw Error("Браузер не поддерживает Web Audio.");
    const ctx = new AC({ sampleRate: 16000 });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const rec = new model.KaldiRecognizer(ctx.sampleRate || 16000);
    rec.setWords(true);

    return new Promise((resolve, reject) => {
      let node = null,
        closed = false,
        text = "",
        heard = false,
        lastChange = Date.now(),
        started = Date.now(),
        ticker = 0,
        queued = [];

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ticker);
        source.disconnect();
        if (node) {
          node.port && (node.port.onmessage = null);
          node.onaudioprocess = null;
          node.disconnect();
        }
        stream.getTracks().forEach((t) => t.stop());
        if (ctx.state !== "closed") ctx.close().catch(() => {});
        try {
          rec.remove();
        } catch {}
        session = null;
      };
      const finish = () => {
        if (closed) return;
        try {
          rec.retrieveFinalResult();
        } catch {}
        const result = (text || "").trim();
        cleanup();
        resolve(result);
      };
      const fail = (e) => {
        if (closed) return;
        cleanup();
        reject(e instanceof Error ? e : Error(String(e?.error || e?.message || e)));
      };

      session = { cancel: () => { cleanup(); resolve(""); } };

      rec.on("error", (m) => fail(Error(m?.error || "Ошибка распознавания.")));
      rec.on("partialresult", (m) => {
        const t = (m?.result?.partial || "").trim();
        if (t && t !== text) {
          heard = true;
          lastChange = Date.now();
          partial(t);
        }
      });
      rec.on("result", (m) => {
        const t = (m?.result?.text || "").trim();
        if (t) {
          text = (text + " " + t).trim();
          heard = true;
          lastChange = Date.now();
          partial(text);
        }
      });

      const push = (samples) => {
        if (closed) return;
        if (!rec) return;
        try {
          rec.acceptWaveformFloat(samples, ctx.sampleRate);
        } catch {
          /* фрагмент потерян, продолжаем слушать */
        }
      };

      const startCapture = async () => {
        if (ctx.audioWorklet) {
          try {
            await ctx.audioWorklet.addModule("/audio-capture.js");
            node = new AudioWorkletNode(ctx, "lyra-pcm");
            node.port.onmessage = (e) => {
              if (e.data instanceof Float32Array) push(e.data);
            };
          } catch {
            node = null;
          }
        }
        if (!node) {
          node = ctx.createScriptProcessor(512, 1, 1);
          node.onaudioprocess = (e) => push(new Float32Array(e.inputBuffer.getChannelData(0)));
        }
        source.connect(node);
        node.connect(ctx.destination);
        for (const chunk of queued) push(chunk);
        queued = [];
        state("listen");
        ticker = setInterval(() => {
          if (closed) return;
          const now = Date.now();
          if (heard && now - lastChange > silenceMs) return finish();
          if (!heard && now - started > Math.min(4000, maxMs)) return finish();
          if (now - started > maxMs) return finish();
        }, 250);
      };

      startCapture().catch(fail);
    });
  }

  return { listen, stop, loadModel };
})();

if (typeof module !== "undefined" && module.exports) module.exports = VakhtaASR;
else if (typeof window !== "undefined") window.VakhtaASR = VakhtaASR;
