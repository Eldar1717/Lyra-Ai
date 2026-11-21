// Edge-connected background key, not global colour replacement: do not erase eye whites.
function preparePortrait(src, remove, tolerance) {
  const w = src.width,
    h = src.height,
    c = surface(w, h),
    ctx = c.getContext("2d");
  ctx.drawImage(src, 0, 0);
  let im = ctx.getImageData(0, 0, w, h),
    d = im.data;
  let transparent = false;
  for (let i = 3; i < d.length; i += 4)
    if (d[i] < 224) {
      transparent = true;
      break;
    }
  if (!remove || transparent)
    return {
      image: c,
      alpha: transparent,
      label: transparent
        ? "Прозрачность исходника сохранена."
        : "Исходный фон сохранён.",
    };
  let samples = [];
  for (let j = 0; j < 48; j++) {
    let x = Math.round(((w - 1) * j) / 47);
    for (let y of [0, Math.floor(h * 0.025)])
      samples.push(Array.from(d.slice((y * w + x) * 4, (y * w + x) * 4 + 3)));
  }
  const dist = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  let best = 0,
    bg = samples[0];
  for (let a of samples) {
    let hits = samples.filter((b) => dist(a, b) < 19).length;
    if (hits > best) {
      best = hits;
      bg = a;
    }
  }
  const mask = new Uint8Array(w * h),
    q = new Int32Array(w * h);
  let tail = 0,
    head = 0;
  function test(i) {
    if (mask[i]) return;
    mask[i] = 1;
    let off = i * 4;
    if (
      Math.max(
        Math.abs(d[off] - bg[0]),
        Math.abs(d[off + 1] - bg[1]),
        Math.abs(d[off + 2] - bg[2]),
      ) <= tolerance
    ) {
      mask[i] = 2;
      q[tail++] = i;
    }
  }
  for (let x = 0; x < w; x++) {
    test(x);
    test((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    test(y * w);
    test(y * w + w - 1);
  }
  while (head < tail) {
    let i = q[head++];
    if (i % w) test(i - 1);
    if (i % w < w - 1) test(i + 1);
    if (i >= w) test(i - w);
    if (i + w < mask.length) test(i + w);
  }
  if (!tail || tail > w * h * 0.97)
    return {
      image: c,
      alpha: false,
      label: "Фон не определён. Попробуйте другой допуск.",
    };
  // Keep subpixel hair edges. Unmix sampled backdrop to limit light halos on dark scenes.
  for (let i = 0; i < mask.length; i++) {
    let off = i * 4;
    if (mask[i] === 2) {
      d[off + 3] = 0;
      continue;
    }
    if (mask[i] !== 1) continue;
    const delta = Math.max(...bg.map((v, j) => Math.abs(d[off + j] - v)));
    let a = Math.min(1, Math.max(0.1, (delta - tolerance + 8) / 80));
    for (let j = 0; j < 3; j++)
      d[off + j] = Math.min(
        255,
        Math.max(0, (d[off + j] - (1 - a) * bg[j]) / a),
      );
    d[off + 3] = Math.round(255 * a);
  }
  ctx.putImageData(im, 0, 0);
  return {
    image: c,
    alpha: true,
    label: `Удалён краевой фон: ${Math.round((100 * tail) / (w * h))}%.`,
  };
}
