// Render-thread capture, independent of portrait animation and DOM work. No microphone monitoring.
class LyraPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(512);
    this.pos = 0;
    this.active = true;
    this.port.onmessage = (e) => {
      if (e.data === "flush" && this.active) {
        this.active = false;
        this.emit();
        this.port.postMessage("flushed");
      }
    };
  }
  emit() {
    if (this.pos) {
      const pcm = this.buf.slice(0, this.pos);
      this.port.postMessage(pcm, [pcm.buffer]);
      this.pos = 0;
    }
  }
  process(inputs) {
    if (!this.active) return false;
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.pos++] = ch[i];
        if (this.pos === this.buf.length) this.emit();
      }
    }
    return true;
  }
}
registerProcessor("lyra-pcm", LyraPCM);
