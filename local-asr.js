// Audio stays in this tab. Load the bundled worker/model lazily, once per session.
let asrPromise;
function russianModel() {
  if (!asrPromise)
    asrPromise = (async () => {
      if (!window.Vosk)
        await new Promise((ok, no) => {
          let script = document.createElement("script");
          script.src = "assets/asr/vosk.js";
          script.onload = ok;
          script.onerror = () =>
            no(Error("Не загрузился модуль Vosk. Проверьте полноту архива."));
          document.head.append(script);
        });
      return new Promise((ok, no) => {
        let model = new Vosk.Model(
            new URL("assets/asr/ru-small.tar.gz", location.href).href,
            -1,
          ),
          done = false;
        const fail = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          model.terminate();
          no(
            Error(
              "Не удалось загрузить русскую модель. Проверьте файл assets/asr/ru-small.tar.gz и доступ к хранилищу браузера.",
            ),
          );
        };
        let timer = setTimeout(fail, 120000);
        model.on("error", fail);
        model.on("load", (m) => {
          if (!m.result) {
            fail();
            return;
          }
          if (done) return;
          done = true;
          clearTimeout(timer);
          ok(model);
        });
      });
    })().catch((e) => {
      asrPromise = null;
      throw e;
    });
  return asrPromise;
}
class OfflineRecognizer {
  start() {
    this.segments = [];
    this.queue = [];
    this.closed = false;
    this.ending = false;
    this.gotAudio = false;
    this.startCapture().catch((e) => this.fail(e));
  }
  async startCapture() {
    if (!navigator.mediaDevices?.getUserMedia)
      throw Error(
        "Для микрофона нужен localhost или HTTPS. Откройте приложение отдельной вкладкой.",
      );
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw Error("Этот браузер не поддерживает Web Audio.");
    this.ctx = new AC({ sampleRate: 16000 });
    const ready = this.ctx.resume();
    ready.catch(() => {});
    const modelPromise = russianModel();
    modelPromise.catch(() => {});
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    if (this.closed || this.ending) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    await ready;
    if (this.closed || this.ending) return;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.node = this.ctx.createScriptProcessor(1024, 1, 1);
    const rate = this.ctx.sampleRate;
    this.node.onaudioprocess = (e) => {
      if (this.closed || this.ending) return;
      const samples = new Float32Array(e.inputBuffer.getChannelData(0));
      this.gotAudio = true;
      if (this.rec) this.rec.acceptWaveformFloat(samples, rate);
      else this.queue.push(samples);
    };
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination);
    if (!this.rec) $("status").textContent = "Слушаю · подготовка Vosk";
    const model = await modelPromise;
    if (this.closed) return;
    const rec = (this.rec = new model.KaldiRecognizer(rate));
    rec.on("error", (m) => this.fail(Error(m.error)));
    rec.on("partialresult", (m) => {
      if (!this.closed) this.emit(m.result.partial);
    });
    rec.on("result", (m) => {
      if (this.closed) return;
      const text = m.result.text?.trim();
      if (text) this.segments.push(text);
      this.emit("");
      if (m.final) {
        this.abort();
        this.onend?.();
      } else if (text && !this.continuous && !this.ending) this.stop();
    });
    for (const a of this.queue) rec.acceptWaveformFloat(a, rate);
    this.queue = [];
    if (this.ending) rec.retrieveFinalResult();
    else $("status").textContent = "Слушаю вас · локально";
  }
  emit(partial) {
    const text = [...this.segments, partial].filter(Boolean).join(" ");
    this.onresult?.({ results: [[{ transcript: text }]] });
  }
  disconnect() {
    if (this.node) {
      this.node.onaudioprocess = null;
      this.node.disconnect();
      this.node = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx && this.ctx.state !== "closed")
      this.ctx.close().catch(() => {});
    this.ctx = null;
  }
  stop() {
    if (this.closed || this.ending) return;
    this.ending = true;
    this.disconnect();
    if (!this.gotAudio) {
      this.abort();
      this.onend?.();
      return;
    }
    $("status").textContent = "Распознаю фразу…";
    if (this.rec) this.rec.retrieveFinalResult();
    this.timer = setTimeout(
      () =>
        this.fail(
          Error(
            "Не удалось завершить распознавание. Проверьте загрузку файлов модели и попробуйте снова.",
          ),
        ),
      90000,
    );
  }
  fail(e) {
    if (this.closed) return;
    this.abort();
    this.onerror?.({
      error:
        e?.name === "NotAllowedError"
          ? "not-allowed"
          : e?.name === "NotFoundError"
            ? "audio-capture"
            : "local",
      message: e?.message || "Модель не загрузилась.",
    });
  }
  abort() {
    this.closed = true;
    clearTimeout(this.timer);
    this.disconnect();
    this.rec?.remove();
    this.rec = null;
    this.queue = [];
  }
}
