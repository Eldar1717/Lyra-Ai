// Decode and trim in the browser. Only the previewed PCM is sent, on explicit save.
(() => {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname),
    msg = (s) => ($("cloneStatus").textContent = s);
  const file = $("cloneFile"),
    start = $("cloneStart"),
    audio = $("clonePreview"),
    consent = $("cloneConsent"),
    save = $("cloneSave"),
    del = $("cloneDelete");
  let decoded = null,
    blob = null,
    url = null,
    seq = 0,
    busy = false,
    has = false,
    info = "";
  async function api(action, body) {
    const r = await fetch("/api/clone/" + action, {
      method: "POST",
      headers: {
        ...Facts.headers(),
        ...(body
          ? { "Content-Type": "audio/wav", "X-Voice-Consent": "yes" }
          : {}),
      },
      body,
    });
    const d = await r.json();
    if (!r.ok) throw Error(d.error);
    return d;
  }
  function buttons() {
    save.disabled = busy || !consent.checked || !blob;
    del.disabled = busy || !has;
    file.disabled = start.disabled = consent.disabled = busy;
  }
  function drop() {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    audio.hidden = true;
    if (url) URL.revokeObjectURL(url);
    url = blob = null;
    buttons();
  }
  function reset() {
    seq++;
    drop();
    decoded = null;
    file.value = "";
    start.value = "0";
    consent.checked = false;
    buttons();
  }
  function cut() {
    drop();
    consent.checked = false;
    if (!decoded) return;
    const offset = Number(start.value),
      i = Math.round(offset * 24000),
      n = Math.min(12 * 24000, decoded.length - i);
    if (!Number.isFinite(i) || i < 0 || n < 6 * 24000) {
      msg("Выберите начало так, чтобы осталось не менее 6 секунд речи.");
      return;
    }
    const buf = new ArrayBuffer(44 + 2 * n),
      v = new DataView(buf),
      chars = (i, s) =>
        [...s].forEach((c, k) => v.setUint8(i + k, c.charCodeAt(0)));
    chars(0, "RIFF");
    v.setUint32(4, 36 + n * 2, true);
    chars(8, "WAVEfmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 24000, true);
    v.setUint32(28, 48000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    chars(36, "data");
    v.setUint32(40, n * 2, true);
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, j) =>
      decoded.getChannelData(j),
    );
    for (let k = 0; k < n; k++) {
      let x = 0;
      for (const c of channels) x += c[i + k];
      v.setInt16(
        44 + k * 2,
        Math.max(-1, Math.min(1, x / channels.length)) * 32767,
        true,
      );
    }
    blob = new Blob([buf], { type: "audio/wav" });
    url = URL.createObjectURL(blob);
    audio.src = url;
    audio.hidden = false;
    msg(
      `Прослушайте фрагмент: ${(n / 24000).toFixed(1)} с. До сохранения он остаётся в браузере.`,
    );
    buttons();
  }
  start.oninput = cut;
  consent.onchange = buttons;
  file.onchange = async () => {
    const f = file.files[0],
      id = ++seq;
    drop();
    decoded = null;
    consent.checked = false;
    start.value = "0";
    if (!f) return;
    if (f.size > 16 * 1024 * 1024) {
      msg("Файл больше 16 МБ. Выберите короткую запись.");
      return;
    }
    try {
      msg("Читаю запись…");
      const ctx = new OfflineAudioContext(1, 1, 24000),
        a = await ctx.decodeAudioData(await f.arrayBuffer());
      if (seq !== id) return;
      decoded = a;
      cut();
    } catch {
      if (seq === id)
        msg("Формат не удалось прочитать. Попробуйте WAV или MP3.");
    }
  };
  window.refreshClone = async () => {
    if (!local) {
      $("cloneInputs").hidden = true;
      msg(
        "Откройте Лиру на своём компьютере по адресу http://localhost:8000. В удалённом предпросмотре загрузка отключена.",
      );
      return;
    }
    try {
      const d = await api("status");
      window.cloneAvailable = has = d.sample;
      info =
        d.package && d.model
          ? "Файлы XTTS найдены."
          : "Для синтеза нужна установка по XTTS.md.";
      if (!decoded)
        msg((has ? "Образец сохранён. " : "Образца пока нет. ") + info);
      voiceList();
      buttons();
    } catch (e) {
      msg(e.message);
    }
  };
  save.onclick = async () => {
    if (!local || !consent.checked || !blob || busy) return;
    busy = true;
    buttons();
    try {
      await api("sample", blob);
      window.cloneAvailable = has = true;
      reset();
      voiceList();
      $("voices").value = "clone:xtts";
      msg(
        "Образец сохранён. " +
          info +
          " Нажмите «Послушать голос», затем «Сохранить» внизу настроек.",
      );
    } catch (e) {
      msg(e.message);
    } finally {
      busy = false;
      buttons();
    }
  };
  del.onclick = async () => {
    if (
      !local ||
      busy ||
      !confirm(
        "Удалить сохранённый образец голоса из Лиры? Исходная запись останется у вас.",
      )
    )
      return;
    busy = true;
    buttons();
    try {
      silence();
      await api("delete");
      window.cloneAvailable = has = false;
      if (prefs.voice === "clone:xtts") {
        prefs.voice = "neural:xenia";
        store("lyra:prefs", prefs);
      }
      if ($("voices").value === "clone:xtts")
        $("voices").value = "neural:xenia";
      reset();
      voiceList();
      msg("Образец удалён.");
    } catch (e) {
      msg(e.message);
    } finally {
      busy = false;
      buttons();
    }
  };
  $("settingsDialog").addEventListener("close", reset);
})();
