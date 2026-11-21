// Scene state is separate from the portrait rig. Never post user images to the server.
(() => {
  const image = (src) => `url("${src}")`;
  const presets = [
    { id: "night", label: "Сумерки в горах", bg: image("assets/night.jpg") },
    { id: "forest", label: "Туманный лес", bg: image("assets/forest.jpg") },
    { id: "loft", label: "Вечерний интерьер", bg: image("assets/loft.jpg") },
    {
      id: "gradient",
      label: "Градиент",
      bg: "radial-gradient(ellipse at 75% 80%,#75618a,transparent 64%),linear-gradient(120deg,#192039,#4f5277 62%,#725576)",
    },
  ];
  const customKey = "lyra:background:image",
    choiceKey = "lyra:background:id";
  let uploaded = "",
    selected = "night",
    task = 0;
  try {
    const data = localStorage.getItem(customKey) || "";
    if (/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(data))
      uploaded = data;
    selected = localStorage.getItem(choiceKey) || "night";
  } catch {}
  const all = () =>
    uploaded
      ? [...presets, { id: "custom", label: "Мой фон", bg: image(uploaded) }]
      : presets;
  function render() {
    const list = all();
    let scene = list.find((x) => x.id === selected) || list[0];
    selected = scene.id;
    document.querySelector(".sky").style.backgroundImage = scene.bg;
    $("changeScene").title = "Фон: " + scene.label;
    const nodes = list.map((s) => {
      const btn = document.createElement("button");
      btn.className = "sceneCard";
      btn.type = "button";
      btn.dataset.scene = s.id;
      btn.setAttribute("aria-pressed", String(s.id === selected));
      const preview = document.createElement("span");
      preview.className = "sceneThumb";
      preview.style.backgroundImage = s.bg;
      const caption = document.createElement("span");
      caption.textContent = s.label;
      btn.append(preview, caption);
      btn.onclick = () => {
        task++;
        choose(s.id);
        $("scenes").querySelector(`[data-scene="${s.id}"]`).focus();
      };
      return btn;
    });
    $("scenes").replaceChildren(...nodes);
    $("deleteScene").hidden = !uploaded;
  }
  function choose(id, saveImage = false) {
    selected = id;
    render();
    let msg = "Выбран фон: " + all().find((x) => x.id === selected).label + ".";
    try {
      if (saveImage) localStorage.setItem(customKey, uploaded);
      localStorage.setItem(choiceKey, selected);
    } catch {
      msg = "Фон применён на эту сессию. Браузер не смог сохранить выбор.";
    }
    $("sceneMsg").textContent = msg;
  }
  $("changeScene").onclick = () => {
    $("sceneMsg").textContent = "";
    $("sceneDialog").showModal();
  };
  $("sceneDone").onclick = () => $("sceneDialog").close();
  $("sceneDialog").addEventListener("close", () => {
    task++;
  });
  $("sceneFile").onchange = async () => {
    let f = $("sceneFile").files[0];
    $("sceneFile").value = "";
    if (!f) return;
    let n = ++task;
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(f.type) ||
      f.size > 12 * 1024 * 1024
    ) {
      $("sceneMsg").textContent = "Выберите JPG, PNG или WebP не больше 12 МБ.";
      return;
    }
    let url = URL.createObjectURL(f);
    try {
      $("sceneMsg").textContent = "Подготовка изображения…";
      let im = new Image();
      im.src = url;
      await im.decode();
      if (n !== task) return;
      const scale = Math.min(
          1,
          1920 / Math.max(im.naturalWidth, im.naturalHeight),
        ),
        c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(im.naturalWidth * scale));
      c.height = Math.max(1, Math.round(im.naturalHeight * scale));
      let ctx = c.getContext("2d");
      ctx.fillStyle = "#222c50";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(im, 0, 0, c.width, c.height);
      uploaded = c.toDataURL("image/jpeg", 0.88);
      choose("custom", true);
    } catch {
      if (n === task)
        $("sceneMsg").textContent =
          "Не удалось прочитать изображение. Прежний фон сохранён.";
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  $("deleteScene").onclick = () => {
    task++;
    uploaded = "";
    try {
      localStorage.removeItem(customKey);
    } catch {}
    choose(selected === "custom" ? "night" : selected);
    $("sceneMsg").textContent = "Пользовательский фон удалён.";
  };
  render();
})();
