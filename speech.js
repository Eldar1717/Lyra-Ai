// Playback and metering share one audio graph: pauses close the mouth, including on interruption.
const voiceSample =
  "Привет! Слышишь, как по-разному звучит одна и та же фраза? Выбери голос, с которым тебе приятно разговаривать.";
const roster = [
  ["xenia", "Ксения"],
  ["kseniya", "Ксения II"],
  ["baya", "Бая"],
  ["aidar", "Айдар"],
  ["eugene", "Евгений"],
];
let voiceJob = null,
  audioGraph = null,
  meter = null,
  pcm = new Float32Array(512),
  previewActive = false;
function unlockVoice() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioGraph || audioGraph.state === "closed") audioGraph = new AC();
    if (audioGraph.state === "suspended") audioGraph.resume().catch(() => {});
  } catch {}
}
for (const name of ["pointerdown", "keydown"])
  window.addEventListener(name, unlockVoice, { capture: true, once: true });
function volumeShape() {
  if (!meter || audioGraph?.state !== "running") return null;
  meter.getFloatTimeDomainData(pcm);
  let e = 0;
  for (const x of pcm) e += x * x;
  let rms = Math.sqrt(e / pcm.length);
  return Math.min(1, Math.sqrt(Math.max(0, rms - 0.007)) * 2.75);
}
function testState(on) {
  previewActive = on;
  const b = $("voiceTest");
  b.textContent = on ? "Остановить пробу" : "▶  Послушать голос";
  b.setAttribute("aria-pressed", on);
}
function stopAudio() {
  const j = voiceJob;
  voiceJob = null;
  meter = null;
  if (j) {
    j.abort.abort();
    j.audio?.pause();
    j.audio?.removeAttribute("src");
    j.node?.disconnect();
    j.meter?.disconnect();
    if (j.url) URL.revokeObjectURL(j.url);
    j.end?.();
  }
  testState(false);
}
function speechChunks(text) {
  let chunks = [],
    rest = text.trim();
  while (rest.length > 600) {
    let part = rest.slice(0, 600),
      end =
        Math.max(
          ...Array.from(part.matchAll(/[.!?;…](?=\s)/g), (m) => m.index + 1),
          0,
        ) || part.lastIndexOf(" ");
    if (end < 1) end = 600;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
async function neuralSpeak(text, speaker, rate, preview) {
  stopAudio();
  unlockVoice();
  const j = { abort: new AbortController(), audio: new Audio(), url: null };
  voiceJob = j;
  testState(preview);
  const message = (s) => {
    if (preview) $("voiceInfo").textContent = s;
    else $("status").textContent = s;
  };
  state("think");
  message("Готовлю голос…");
  try {
    if (audioGraph?.state === "running") {
      j.node = audioGraph.createMediaElementSource(j.audio);
      j.meter = audioGraph.createAnalyser();
      j.meter.fftSize = 512;
      j.node.connect(j.meter);
      j.meter.connect(audioGraph.destination);
    }
    for (const part of speechChunks(text)) {
      if (voiceJob !== j) return;
      const res = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: part, speaker }),
        signal: j.abort.signal,
      });
      if (!res.ok)
        throw Error(
          (await res.json()).error || "Не удалось подготовить голос.",
        );
      const blob = await res.blob();
      if (voiceJob !== j) return;
      j.url = URL.createObjectURL(blob);
      j.audio.src = j.url;
      j.audio.playbackRate = +rate || 1;
      j.audio.preservesPitch = true;
      await new Promise((ok, no) => {
        j.end = ok;
        j.audio.onended = ok;
        j.audio.onerror = () => no(Error("Браузер не воспроизвёл звук."));
        j.audio.onplaying = () => {
          if (j !== voiceJob) return;
          meter = j.meter;
          state("talk");
          if (preview)
            message(
              "Проба голоса · " + roster.find((v) => v[0] === speaker)?.[1],
            );
        };
        j.audio.play().catch(no);
      });
      if (j !== voiceJob) return;
      meter = null;
      URL.revokeObjectURL(j.url);
      j.url = null;
    }
    if (j === voiceJob) {
      stopAudio();
      state("idle");
      if (preview)
        $("voiceInfo").textContent =
          "Выберите другой голос для сравнения или нажмите «Сохранить».";
    }
  } catch (e) {
    if (j !== voiceJob) return;
    stopAudio();
    state("idle");
    const msg = e.message || "Нейроголос недоступен.";
    if (preview) {
      $("voiceInfo").textContent = msg;
      return;
    }
    notice(msg + (synth ? " Использую системную озвучку." : ""));
    systemSpeak(text, "", rate, false);
  }
}
function voiceChoice() {
  return prefs.voice || "neural:xenia";
}
function speak(text, preview = false) {
  if (!preview && !prefs.sound) return;
  const selected = preview ? $("voices").value : voiceChoice(),
    rate = preview ? $("rate").value : prefs.rate;
  if (selected.startsWith("neural:"))
    neuralSpeak(text, selected.slice(7), rate, preview);
  else systemSpeak(text, selected === "system" ? "" : selected, rate, preview);
}
$("voiceTest").onclick = () => {
  if (previewActive) {
    silence();
    $("voiceInfo").textContent = "Проба остановлена.";
    return;
  }
  silence();
  speak(voiceSample, true);
};
$("voices").onchange = () => {
  if (previewActive) silence();
  $("voiceInfo").textContent = "Сравните голоса на одной и той же фразе.";
};
$("settingsDialog").addEventListener("close", () => {
  if (previewActive) silence();
});

if (synth) synth.onvoiceschanged = voiceList;
