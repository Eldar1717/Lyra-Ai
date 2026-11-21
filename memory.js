// Text facts live on the Lyra server; the opaque key selects this browser's private scope.
const Facts = (() => {
  const old = load("lyra:memory:v1", {});
  const options = load("lyra:facts:options", null) || {
    enabled: old?.enabled !== false,
    local: false,
    external: false,
  };
  let token = "",
    volatile = false;
  try {
    token = localStorage.getItem("lyra:facts:key") || "";
  } catch {}
  if (!/^[0-9a-f]{64}$/.test(token)) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    try {
      localStorage.setItem("lyra:facts:key", token);
    } catch {
      volatile = true;
    }
  }
  const headers = () => ({
    "Content-Type": "application/json",
    "X-Lyra-Profile": token,
  });
  async function api(action, d = {}) {
    let r = await fetch("/api/facts", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ action, ...d }),
    });
    let result = await r.json();
    if (!r.ok) throw Error(result.error || "Ошибка памяти.");
    return result;
  }
  function legacy() {
    const p = load("lyra:memory:v1", {}) || {},
      b = load("lyra:notebook:1", {}) || {};
    let rows = [];
    if (p.names?.self) rows.push("Меня зовут " + p.names.self + ".");
    let friends = Array.isArray(p.people)
      ? p.people
      : ["friend", "friendF"].flatMap((role) =>
          p.names?.[role] ? [{ name: p.names[role], role }] : [],
        );
    const labels = {
      birthday: "день рождения",
      city: "место жительства",
      work: "работа",
      likes: "предпочтения",
      pets: "питомцы",
    };
    for (const f of friends) {
      if (!f?.name) continue;
      let ref = f.name + (f.tag ? " (" + f.tag + ")" : "");
      rows.push(
        (f.role === "friendF" ? "Моя подруга — " : "Мой друг — ") + ref + ".",
      );
      for (const [k, v] of Object.entries(f.facts || {}))
        if (labels[k] && v) rows.push(ref + " — " + labels[k] + ": " + v + ".");
    }
    if (b.city) rows.push("Мой город — " + b.city + ".");
    if (b.work) rows.push("Моё место работы — " + b.work + ".");
    for (const r of b.rows || []) if (!r.at && r.text) rows.push(r.text);
    return [...new Set(rows)];
  }
  const wantsContext = () =>
    options.enabled &&
    (prefs.engine === "ollama" ? options.local : options.external);
  async function answer(text) {
    const summary =
      /^(?:лира[,\s]+)?(?:что (?:ты )?(?:обо мне помнишь|помнишь обо мне|запомнила)|что у тебя в памяти|покажи (?:мои заметки|память))[?!.\s]*$/iu.test(
        text,
      );
    if (!options.enabled)
      return summary || /^(?:лира[,\s]+)?запомни[,:\s]/iu.test(text)
        ? "Память выключена. Включите её в настройках."
        : null;
    if (summary) {
      const a = await api("list");
      return a.facts.length
        ? "Сохранено фактов: " +
            a.facts.length +
            ". " +
            a.facts
              .slice(0, 8)
              .map((r) => r.content)
              .join("; ") +
            (a.facts.length > 8 ? " Остальные — в настройках памяти." : "")
        : "В памяти пока нет фактов.";
    }
    const a = await api("observe", { text });
    if (a.captured) {
      const city = text.match(
        /^(?:(?:лира[,\s]+)?запомни[,:\s]+(?:что\s+)?)?(?:мой город\s*[:—–-]?\s*|я живу в\s+)([^.,!?]{1,80})[.!]?$/iu,
      );
      if (city) book.profile(Daily.cityName(city[1]), book.view().work);
      if (!a.explicit && prefs.engine !== "demo") {
        notice(a.added ? "Факт сохранён в памяти." : "Этот факт уже сохранён.");
        return null;
      }
      return a.added
        ? "Запомнила: " +
            text.replace(
              /^(?:лира[,\s]+)?(?:пожалуйста[,\s]+)?(?:запомни(?:те)?|не забывай)[,:\s]+(?:что\s+)?/iu,
              "",
            )
        : "Это уже есть в памяти.";
    }
    if (
      prefs.engine === "demo" &&
      (/\?$/.test(text) ||
        /^(?:как|где|что|когда|кто|расскажи о) /iu.test(text))
    ) {
      const hit = await api("recall", { text });
      if (hit.facts.length)
        return "Из памяти: " + hit.facts.slice(0, 3).join("; ");
    }
    return null;
  }
  return { options, headers, api, legacy, answer, wantsContext, volatile };
})();
// UI bindings
(() => {
  const dialog = $("memoryDialog");
  let rows = [],
    editing = null,
    run = 0;
  const status = (s) => ($("memStatus").textContent = s);
  function draw() {
    const q = $("factSearch").value.trim().toLowerCase();
    $("factCount").textContent = rows.length;
    const box = $("factRows");
    box.replaceChildren();
    for (const r of rows.filter((r) => r.content.toLowerCase().includes(q))) {
      const div = document.createElement("div");
      div.className = "bookRow";
      const span = document.createElement("span");
      span.textContent = r.content;
      const edit = document.createElement("button");
      edit.className = "textBtn";
      edit.textContent = "Изменить";
      edit.onclick = () => {
        editing = r.id;
        $("factInput").value = r.content;
        $("factPut").textContent = "Сохранить правку";
        $("factInput").focus();
      };
      const del = document.createElement("button");
      del.className = "textBtn";
      del.textContent = "Удалить";
      del.onclick = () =>
        task(async () => {
          await Facts.api("delete", { id: r.id });
          if (editing === r.id) reset();
          await refresh();
          status("Запись удалена.");
        });
      div.append(span, edit, del);
      box.append(div);
    }
    if (!box.children.length)
      box.textContent = q
        ? "Совпадений нет."
        : "Фактов пока нет. Попробуйте «Запомни: …».";
  }
  async function refresh() {
    let seq = ++run;
    let d = await Facts.api("list");
    if (seq === run) {
      rows = d.facts;
      draw();
    }
  }
  function reset() {
    editing = null;
    $("factInput").value = "";
    $("factPut").textContent = "Добавить факт";
  }
  async function task(f) {
    try {
      await f();
    } catch (e) {
      status(e.message || "Не удалось обратиться к памяти.");
    }
  }
  $("openMemory").onclick = () => {
    reset();
    $("factSearch").value = "";
    $("memEnabled").checked = Facts.options.enabled;
    $("memLocal").checked = Facts.options.local;
    $("memExternal").checked = Facts.options.external;
    $("bookCity").value = book.view().city;
    $("memImport").hidden = !Facts.legacy().length;
    status(
      Facts.volatile
        ? "Внимание: браузер не сохраняет ключ профиля. После закрытия доступ к этим фактам может потеряться."
        : "",
    );
    dialog.showModal();
    task(refresh);
  };
  $("factSearch").oninput = draw;
  $("factPut").onclick = () =>
    task(async () => {
      const text = $("factInput").value.trim();
      if (!text) return status("Введите текст факта.");
      const d = await Facts.api(editing ? "edit" : "add", {
        id: editing,
        text,
      });
      reset();
      await refresh();
      status(d.added === 0 ? "Уже есть в памяти." : "Запись сохранена.");
    });
  $("memClear").onclick = () => {
    if (
      confirm(
        "Удалить все факты этого профиля из базы? История чата и напоминания останутся.",
      )
    )
      task(async () => {
        await Facts.api("clear");
        reset();
        await refresh();
        status("Факты удалены.");
      });
  };
  $("memImport").onclick = () => {
    const facts = Facts.legacy();
    if (
      confirm(
        `Перенести прежние карточки и заметки в базу на сервере Лиры? До ${facts.length} текстовых фактов. Исходные данные в браузере не удаляются.`,
      )
    )
      task(async () => {
        let d = await Facts.api("import", { facts });
        await refresh();
        status("Добавлено фактов: " + d.added + ". Повторы пропущены.");
      });
  };
  $("memSave").onclick = () => {
    Object.assign(Facts.options, {
      enabled: $("memEnabled").checked,
      local: $("memLocal").checked,
      external: $("memExternal").checked,
    });
    store("lyra:facts:options", Facts.options);
    book.profile($("bookCity").value, book.view().work);
    dialog.close();
  };
})();
