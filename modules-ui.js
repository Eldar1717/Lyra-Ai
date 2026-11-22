// Менеджер модулей: список папок modules/, включение и выключение.
// Сам модуль живёт отдельной папкой и открывается по своему адресу.
"use strict";
(() => {
  const icons = {
    door: '<path d="M5 21V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v17 M3 21h18 M12 12h.01"/>',
    module:
      '<path d="M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z"/>',
  };
  const svg = (name) =>
    `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.module}</svg>`;
  const dialog = $("modulesDialog");
  const list = $("moduleList");
  const msg = $("modulesMsg");
  let modules = [];

  const say = (text, bad = false) => {
    msg.textContent = text;
    msg.classList.toggle("bad", bad);
  };

  async function api(action, data = {}) {
    const res = await fetch("/api/modules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...data }),
    });
    let out = {};
    try {
      out = await res.json();
    } catch {}
    if (!res.ok) throw Error(out.error || "Сервер не ответил.");
    return out;
  }

  function card(m) {
    const el = document.createElement("article");
    el.className = "moduleCard";
    el.dataset.id = m.id;
    el.dataset.on = String(m.enabled);
    el.innerHTML = `
      <div class="moduleHead">
        <span class="moduleIcon">${svg(m.icon)}</span>
        <div class="moduleText">
          <h4>${escapeHtml(m.name)}<small>${m.version ? "v" + escapeHtml(m.version) : ""}</small>
            <span class="moduleState">${m.enabled ? "включён" : "выключен"}</span></h4>
          <p class="moduleDesc">${escapeHtml(m.description)}</p>
          ${m.requires.length ? `<p class="moduleReq">Нужно: ${m.requires.map(escapeHtml).join(", ")}</p>` : ""}
          ${m.tags.length ? `<div class="moduleTags">${m.tags.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>` : ""}
        </div>
      </div>
      <div class="moduleActions">
        <code class="modulePath">modules/${m.id}</code>
        <span class="moduleSpacer"></span>
        <a class="primary moduleOpen" href="${m.url}" ${m.enabled ? "" : "aria-disabled=true"}>Открыть</a>
        <button class="settings moduleToggle" type="button">${m.enabled ? "Выключить" : "Включить"}</button>
      </div>`;
    const open = el.querySelector(".moduleOpen");
    if (!m.enabled) {
      open.onclick = (e) => {
        e.preventDefault();
        say(`Модуль «${m.name}» выключен — включите его, чтобы открыть.`, true);
      };
    }
    el.querySelector(".moduleToggle").onclick = () => toggle(m);
    return el;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  function render() {
    list.textContent = "";
    if (!modules.length) {
      list.innerHTML = '<p class="modEmpty">В папке <code>modules/</code> пока нет модулей.</p>';
      return;
    }
    for (const m of modules) list.append(card(m));
  }

  async function load() {
    try {
      const out = await fetch("/api/modules").then((r) => r.json());
      modules = out.modules || [];
      render();
      const vakhta = modules.find((m) => m.id === "vakhta");
      const quick = $("headerVakhta");
      if (quick) {
        quick.hidden = !vakhta || !vakhta.enabled;
        if (vakhta) quick.title = vakhta.description;
      }
    } catch {
      list.innerHTML = "";
      say("Список модулей недоступен. Проверьте, что python server.py запущен.", true);
    }
  }

  async function toggle(m) {
    const turnOn = !m.enabled;
    say(turnOn ? `Включаю «${m.name}»…` : `Выключаю «${m.name}»…`);
    try {
      const out = await api(turnOn ? "enable" : "disable", { id: m.id });
      modules = modules.map((x) => (x.id === m.id ? { ...x, ...out.module } : x));
      render();
      say(
        turnOn
          ? `«${m.name}» включён. Страница модуля: ${m.url}`
          : `«${m.name}» выключен. Его страница и API больше не отвечают.`,
      );
      const vakhta = modules.find((x) => x.id === "vakhta");
      const quick = $("headerVakhta");
      if (quick) quick.hidden = !vakhta || !vakhta.enabled;
    } catch (e) {
      say(e.message, true);
    }
  }

  window.openModules = () => {
    dialog.showModal();
    say("");
    load();
  };
  $("openModules").onclick = window.openModules;
  dialog.addEventListener("close", () => say(""));
  load();
})();
