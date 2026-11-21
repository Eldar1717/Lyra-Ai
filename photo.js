let rawPhoto = null,
  hasAlpha = false,
  photo = null,
  points = [],
  readId = 0;
const marks = $("marks"),
  mc = marks.getContext("2d");
const prompts = [
  "центр зрачка слева на снимке",
  "центр зрачка справа на снимке",
  "левый на снимке уголок рта",
  "правый на снимке уголок рта",
];
function guide(msg) {
  $("guide").textContent = msg;
}
function paintMarks() {
  if (!photo) return;
  mc.clearRect(0, 0, marks.width, marks.height);
  mc.drawImage(photo, 0, 0, marks.width, marks.height);
  let r = Math.max(3, Math.min(marks.width, marks.height) / 89);
  points.forEach(([x, y], i) => {
    mc.beginPath();
    mc.arc(x, y, r, 0, Math.PI * 2);
    mc.fillStyle = "#c6affb";
    mc.fill();
    mc.strokeStyle = "#261d33";
    mc.lineWidth = r / 3;
    mc.stroke();
  });
  $("undo").hidden = !points.length;
  $("applyPhoto").hidden = points.length !== 4;
  guide(
    points.length === 4
      ? "Разметка готова. Примените портрет или исправьте последнюю точку."
      : `Шаг ${points.length + 1} из 4: нажмите на ${prompts[points.length]}.`,
  );
}
$("changeAvatar").onclick = () => {
  $("photoDialog").showModal();
};
$("file").onchange = async () => {
  const f = $("file").files[0];
  $("file").value = "";
  if (!f) return;
  const id = ++readId;
  rawPhoto = photo = null;
  $("prep").hidden = true;
  points = [];
  $("sheet").hidden = $("undo").hidden = $("applyPhoto").hidden = true;
  if (
    f.size > 12 * 1024 * 1024 ||
    !["image/png", "image/jpeg", "image/webp"].includes(f.type)
  ) {
    guide("Выберите JPG, PNG или WebP не больше 12 МБ.");
    return;
  }
  let url = URL.createObjectURL(f);
  try {
    let im = new Image();
    im.src = url;
    await im.decode();
    if (id !== readId) return;
    if (im.naturalWidth < 80 || im.naturalHeight < 80)
      throw Error("Снимок слишком мал. Выберите более крупный портрет.");
    let k = Math.min(1, 2560 / Math.max(im.width, im.height));
    let src = surface(
      Math.max(1, Math.round(im.width * k)),
      Math.max(1, Math.round(im.height * k)),
    );
    src.getContext("2d").drawImage(im, 0, 0, src.width, src.height);
    startPhoto(src, []);
  } catch (e) {
    guide(
      e.message.startsWith("Снимок")
        ? e.message
        : "Не удалось открыть изображение.",
    );
  } finally {
    URL.revokeObjectURL(url);
  }
};
function startPhoto(src, pts) {
  rawPhoto = src;
  points = pts;
  marks.width = src.width;
  marks.height = src.height;
  $("sheet").hidden = $("prep").hidden = false;
  refreshPhoto();
}
function refreshPhoto() {
  if (!rawPhoto) return;
  const processed = preparePortrait(
    rawPhoto,
    $("cut").checked,
    +$("tolerance").value,
  );
  photo = processed.image;
  hasAlpha = processed.alpha;
  $("prepInfo").textContent =
    photo.width + " × " + photo.height + " · " + processed.label;
  $("tolerance").disabled = !$("cut").checked;
  paintMarks();
}
$("cut").onchange = $("tolerance").onchange = refreshPhoto;
$("exportWebp").onclick = () => {
  if (!photo) return;
  photo.toBlob(
    (blob) => {
      if (!blob || blob.type !== "image/webp") {
        guide("Браузер не поддерживает экспорт WebP. Попробуйте Chrome.");
        return;
      }
      let url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = "portrait.webp";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    },
    "image/webp",
    0.98,
  );
};
marks.onclick = (e) => {
  if (!photo || points.length === 4) return;
  const rect = marks.getBoundingClientRect(),
    x = ((e.clientX - rect.left) * marks.width) / rect.width,
    y = ((e.clientY - rect.top) * marks.height) / rect.height;
  let p = points;
  if (
    p.length === 1 &&
    (x - p[0][0] < 10 || Math.abs(y - p[0][1]) > (x - p[0][0]) * 0.55)
  ) {
    guide("Глаза должны идти слева направо. Используйте снимок почти анфас.");
    return;
  }
  if (p.length === 2 && y < Math.min(p[0][1], p[1][1]) + 5) {
    guide("Укажите уголок рта ниже глаз.");
    return;
  }
  if (
    p.length === 3 &&
    (x - p[2][0] < 5 || Math.abs(y - p[2][1]) > (x - p[2][0]) * 0.55)
  ) {
    guide("Укажите второй уголок рта, справа от первого.");
    return;
  }
  points.push([x, y]);
  paintMarks();
};
$("undo").onclick = () => {
  points.pop();
  paintMarks();
};
function align() {
  let [a, b] = points,
    dx = b[0] - a[0],
    dy = b[1] - a[1],
    d = dx * dx + dy * dy,
    gap = Math.min(115, Math.max(84, (Math.sqrt(d) * 576) / photo.width)),
    A = (gap * dx) / d,
    B = (-gap * dy) / d,
    E = 285 - gap / 2 - A * a[0] + B * a[1],
    F = 240 - B * a[0] - A * a[1],
    transform = ([x, y]) => [A * x - B * y + E, B * x + A * y + F];
  const k = 2,
    tex = surface(576 * k, 768 * k),
    c = tex.getContext("2d");
  c.imageSmoothingQuality = "high";
  if (!hasAlpha) {
    c.save();
    c.filter = "blur(18px)";
    c.drawImage(photo, -24, -24, tex.width + 48, tex.height + 48);
    c.restore();
  }
  c.setTransform(k * A, k * B, -k * B, k * A, k * E, k * F);
  c.drawImage(photo, 0, 0);
  c.resetTransform();
  let lips = points.slice(2).map(transform);
  const span = lips[1][0] - lips[0][0];
  if (
    span < 18 ||
    span > 115 ||
    lips.some(([x, y]) => y < 258 || y > 393 || x < 190 || x > 387)
  )
    throw Error(
      "Разметка не похожа на фронтальное лицо. Уточните положение глаз и уголков губ.",
    );
  return {
    tex,
    eyes: [
      [285 - gap / 2, 240],
      [285 + gap / 2, 240],
    ],
    mouth: lips,
  };
}
$("applyPhoto").onclick = () => {
  try {
    const { tex, eyes, mouth } = align();
    useRig(buildRig(tex, eyes, mouth, true, hasAlpha));
    let saved = true;
    try {
      localStorage.setItem(
        "lyra:portrait",
        JSON.stringify({
          src: tex.toDataURL("image/webp", 0.98),
          alpha: hasAlpha,
          eyes,
          mouth,
        }),
      );
    } catch {
      saved = false;
    }
    $("photoDialog").close();
    $("settingsDialog").close();
    notice(
      saved
        ? "Портрет применён. Для проверки попробуйте «Расскажи о себе»."
        : "Портрет применён на эту сессию. Браузер не разрешил его сохранить.",
    );
  } catch (e) {
    guide(e.message);
  }
};
let photoGeneration = 0;
$("restore").onclick = () => {
  photoGeneration++;
  readId++;
  rawPhoto = photo = null;
  $("prep").hidden = true;
  points = [];
  $("sheet").hidden = $("undo").hidden = $("applyPhoto").hidden = true;
  guide("Форматы: JPG, PNG, WebP · до 12 МБ");
  useRig(standard);
  try {
    localStorage.removeItem("lyra:portrait");
  } catch {}
  $("photoDialog").close();
  $("settingsDialog").close();
  notice("Возвращён исходный портрет Лиры.");
};
(async () => {
  let saved = load("lyra:portrait", null),
    gen = photoGeneration;
  if (!/^data:image\/(webp|jpeg|png);base64,/.test(saved?.src || "")) return;
  try {
    let im = new Image();
    im.src = saved.src;
    await im.decode();
    if (gen === photoGeneration && !rig?.custom)
      useRig(buildRig(im, saved.eyes, saved.mouth, true, !!saved.alpha));
  } catch {
    notice("Сохранённый портрет не загрузился. Используется портрет Лиры.");
  }
})();
