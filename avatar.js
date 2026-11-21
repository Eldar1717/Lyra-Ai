// A photo rig is a portrait and landmarks, independent of the speech/LLM provider.
let wordPulse = -1000;
const surface = (w, h) =>
  Object.assign(document.createElement("canvas"), { width: w, height: h });
const pic = (n) => Object.assign(new Image(), { src: "assets/" + n });
const original = pic("lyra.webp"),
  defaultEyes = pic("eyes.png"),
  defaultLips = pic("lips.png");
const frame = surface(576, 768),
  fc = frame.getContext("2d"),
  pc = $("portrait").getContext("2d");
let rig = null;
const cap = (v, a, b) => Math.max(a, Math.min(b, v));
// Pre-sample small regions once, rather than reprocessing the full photo each frame.
function patch(tex, cx, cy, rx, ry, kind) {
  const w = Math.ceil(rx * 2.8),
    h = Math.ceil(ry * (kind === "lip" ? 7 : 5.5)),
    ox = Math.round(cx - w / 2),
    oy = Math.round(cy - h / 2),
    ct = tex.getContext("2d"),
    src = ct.getImageData(ox, oy, w, h).data,
    n = kind === "gaze" ? 5 : 11,
    strip = surface(w * n, h),
    dst = strip.getContext("2d");
  for (let i = 0; i < n; i++) {
    const im = dst.createImageData(w, h),
      t = i / (n - 1);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const dx = (ox + x - cx) / rx,
          dy = oy + y - cy,
          f = Math.max(0, 1 - dx * dx);
        let sx = x,
          sy = y,
          dark = 0;
        if (kind === "gaze") {
          sx -=
            (i - 2) *
            0.85 *
            Math.exp(-dx * dx * 6 - ((dy * dy) / (ry * ry)) * 1.65) *
            f;
        } else if (kind === "eye") {
          const top = -ry * f,
            bot = ry * f,
            mid = top + (bot - top) * t * 0.999;
          if (dy < mid && dy > top - ry * 1.45)
            sy +=
              (top - mid) *
              cap((dy - top + ry * 1.45) / (mid - top + ry * 1.45), 0, 1);
          else if (dy >= mid && dy < bot)
            sy += ((top - mid) * (bot - dy)) / Math.max(0.015, bot - mid);
        } else {
          const gap = ry * 1.55 * t * f;
          if (dy > 0)
            sy -= Math.min(dy, gap) * cap(1 - (dy - gap) / (ry * 3), 0, 1);
          dark = cap(dy * 1.6, 0, 1) * cap((gap - dy) * 1.5, 0, 1) * 0.8;
        }
        sx = cap(sx, 0, w - 1);
        sy = cap(sy, 0, h - 1);
        const x0 = Math.floor(sx),
          y0 = Math.floor(sy),
          x1 = Math.min(x0 + 1, w - 1),
          y1 = Math.min(y0 + 1, h - 1),
          a = sx - x0,
          b = sy - y0;
        for (let c = 0; c < 4; c++) {
          let val =
            (1 - b) *
              ((1 - a) * src[(y0 * w + x0) * 4 + c] +
                a * src[(y0 * w + x1) * 4 + c]) +
            b *
              ((1 - a) * src[(y1 * w + x0) * 4 + c] +
                a * src[(y1 * w + x1) * 4 + c]);
          im.data[(y * w + x) * 4 + c] =
            c < 3 ? val * (1 - dark) + [57, 29, 34][c] * dark : val;
        }
      }
    dst.putImageData(im, w * i, 0);
  }
  return { strip, w, h, ox, oy };
}
// The teeth belong behind the lips: all enamel is clipped to the current oral aperture.
// Find the lip seam close to the line between marked corners, then warp original lip texture.
function mouthRig(tex, points, scale) {
  const [a, b] = points,
    rx = (b[0] - a[0]) / 2,
    cx = (a[0] + b[0]) / 2,
    cy = (a[1] + b[1]) / 2;
  const w = Math.ceil(rx * 2.7),
    h = Math.ceil(rx * 1.95),
    ox = Math.round(cx - w / 2),
    oy = Math.round(cy - h * 0.41),
    base = tex.getContext("2d").getImageData(ox, oy, w, h).data;
  const seam = new Float32Array(w),
    rough = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let u = (x + ox - a[0]) / (2 * rx),
      prior = a[1] + u * (b[1] - a[1]) - oy,
      r = Math.max(2, rx * 0.14),
      best = Infinity;
    rough[x] = prior;
    for (let y = Math.ceil(prior - r); y <= prior + r; y++) {
      let k = (y * w + x) * 4;
      let cost =
        0.3 * base[k] +
        0.55 * base[k + 1] +
        0.15 * base[k + 2] +
        14 * ((y - prior) / r) ** 2;
      if (cost < best) {
        best = cost;
        rough[x] = y;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0,
      total = 0;
    for (let j = -3 * scale; j <= 3 * scale; j++) {
      let k = 1 / (1 + Math.abs(j) / scale);
      sum += rough[cap(x + j, 0, w - 1)] * k;
      total += k;
    }
    seam[x] = sum / total;
  }
  const neutral = surface(w * 11, h),
    dent = surface(w * 11, h),
    nc = neutral.getContext("2d"),
    dc = dent.getContext("2d");
  for (let n = 0; n <= 10; n++) {
    let t = n / 10,
      open = nc.createImageData(w, h),
      enamel = dc.createImageData(w, h);
    for (let x = 0; x < w; x++) {
      const dx = (ox + x - cx) / rx,
        ax = Math.abs(dx),
        shape = Math.max(0, 1 - dx * dx),
        gap = rx * 0.45 * t * shape,
        up = gap * 0.16,
        down = gap - up,
        top = seam[x] - up,
        bottom = seam[x] + down;
      // Shallow scallops separate the incisors; tooth seams darken away from the highlight.
      const phase = Math.abs(Math.sin(dx * Math.PI * 4.15)),
        arch = Math.max(0, 1 - ax ** 1.8),
        toothH =
          Math.min(rx * 0.172, gap * 0.62) *
          arch *
          (0.83 + 0.17 * Math.sqrt(phase));
      for (let y = 0; y < h; y++) {
        const dy = y - seam[x];
        let sy = y;
        if (y < top) sy = y + up * Math.max(0, 1 - (top - y) / (rx * 0.45));
        else if (y > bottom)
          sy = y - down * Math.max(0, 1 - (y - bottom) / (rx * 0.63));
        else sy = seam[x];
        sy = cap(sy, 0, h - 1);
        let y0 = Math.floor(sy),
          f = sy - y0,
          at = (y * w + x) * 4;
        let inside =
          cap((y - top) / scale + 0.22, 0, 1) *
          cap((bottom - y) / scale + 0.22, 0, 1) *
          cap(gap / scale, 0, 1);
        let upper =
          cap((top + toothH - y) / scale + 0.4, 0, 1) *
          cap((0.88 - ax) * 12, 0, 1) *
          cap((gap / scale - 0.65) / 1.5, 0, 1);
        let lowerH = gap * 0.12 * arch * cap((t - 0.45) * 2, 0, 1),
          lower =
            cap((y - bottom + lowerH) / scale + 0.24, 0, 1) *
            cap((0.68 - ax) * 10, 0, 1) *
            cap((t - 0.45) * 2, 0, 1);
        let glow = cap((y - top) / (scale * 2.0), 0, 1),
          light =
            0.76 +
            0.19 * glow -
            0.21 * ax * ax -
            0.06 * Math.exp(-phase * phase * 44);
        let tongue =
          0.85 *
          Math.exp(-(((y - bottom + gap * 0.19) / (scale + gap * 0.25)) ** 2)) *
          arch;
        for (let c = 0; c < 4; c++) {
          let val =
            (1 - f) * base[(y0 * w + x) * 4 + c] +
            f * base[(Math.min(h - 1, y0 + 1) * w + x) * 4 + c];
          if (c === 3) {
            open.data[at + c] = enamel.data[at + c] = val;
            continue;
          }
          const oral = [61, 29, 35][c] + tongue * [44, 19, 18][c];
          const teeth = oral * (1 - upper) + [237, 222, 206][c] * light * upper,
            finished = teeth * (1 - lower) + [164, 142, 131][c] * lower;
          open.data[at + c] = val * (1 - inside) + oral * inside;
          enamel.data[at + c] = val * (1 - inside) + finished * inside;
        }
      }
    }
    nc.putImageData(open, n * w, 0);
    dc.putImageData(enamel, n * w, 0);
  }
  return {
    neutral: { strip: neutral, w, h, ox, oy },
    dent: { strip: dent, w, h, ox, oy },
  };
}

function stamp(p, i) {
  if (p) fc.drawImage(p.strip, p.w * i, 0, p.w, p.h, p.ox, p.oy, p.w, p.h);
}
function buildRig(img, eyes, mouth, custom, alpha = false) {
  const scale = custom && img.width >= 1152 ? 2 : 1;
  eyes = eyes.map((p) => p.map((v) => v * scale));
  if (mouth) mouth = mouth.map((p) => p.map((v) => v * scale));
  let tex = surface(576 * scale, 768 * scale);
  tex.getContext("2d").drawImage(img, 0, 0, tex.width, tex.height);
  let span = eyes[1][0] - eyes[0][0];
  return {
    tex,
    custom,
    alpha,
    scale,
    gaze: eyes.map((p) => patch(tex, ...p, span * 0.25, span * 0.095, "gaze")),
    eyes: custom
      ? eyes.map((p) => patch(tex, ...p, span * 0.25, span * 0.095, "eye"))
      : [],
    lips: mouthRig(
      tex,
      mouth || [
        [258, 317],
        [315, 317],
      ],
      scale,
    ),
  };
}
let standard = null;
function useRig(r) {
  rig = r;
  const k = r?.scale || 1;
  frame.width = $("portrait").width = 576 * k;
  frame.height = $("portrait").height = 768 * k;
  pc.setTransform(k, 0, 0, k, 0, 0);
  $("portrait").classList.toggle("custom", !!r?.custom && !r.alpha);
  $("portrait").classList.toggle("photoAlpha", !!r?.custom && !!r.alpha);
  $("avatarName").textContent = r?.custom ? "Свой портрет" : "Портрет Лиры";
}
function initDefault() {
  standard = buildRig(
    original,
    [
      [242.5, 241.5],
      [326, 238.5],
    ],
    null,
    false,
  );
  if (!rig) useRig(standard);
}
if (original.complete && original.naturalWidth) initDefault();
else original.onload = initDefault;
const bars = Array.from({ length: 26 }, () => {
  let b = document.createElement("b");
  $("bars").append(b);
  return b;
});
let aim = 0,
  look = 0,
  nextGaze = 0,
  pointerUntil = 0,
  nextBlink = 2200,
  blink = -1000,
  lastFrame = 0,
  attention = 0,
  voiceJaw = 0;
$("stage").addEventListener("pointermove", (e) => {
  const r = $("stage").getBoundingClientRect();
  aim = cap(4 * ((e.clientX - r.left) / r.width - 0.5), -2, 2);
  pointerUntil = performance.now() + 1200;
});
function draw(ms) {
  requestAnimationFrame(draw);
  if (!rig || ms - lastFrame < 32 || document.hidden) return;
  lastFrame = ms;
  let t = ms * 0.001;
  if (ms > nextBlink) {
    blink = ms;
    nextBlink = ms + (Math.random() < 0.12 ? 330 : 2300 + Math.random() * 3700);
  }
  if (ms > nextGaze && ms > pointerUntil) {
    aim = mode === "listen" ? 0 : Math.random() * 3.2 - 1.6;
    nextGaze = ms + 1700 + 2200 * Math.random();
  }
  look += (aim - look) * 0.24;
  attention += ((mode === "listen" ? 1 : 0) - attention) * 0.1;
  let eye = Math.round(10 * Math.max(0, 1 - Math.abs((ms - blink - 93) / 100))),
    g = motion ? cap(2 + Math.round(look), 0, 4) : 2;
  const stress = ms - wordPulse < 210 ? 1 : 0.72;
  let mouthTarget =
    mode === "talk"
      ? stress *
        Math.abs(Math.sin(11 * t + 0.8 * Math.sin(4.7 * t))) *
        (0.36 + 0.64 * Math.abs(Math.sin(t * 3.9)))
      : 0;
  const amplitude = mode === "talk" ? volumeShape() : null;
  if (amplitude !== null) mouthTarget = amplitude;
  voiceJaw += (mouthTarget - voiceJaw) * 0.74;
  const mouth = cap(Math.round(voiceJaw * 11), 0, 10);
  fc.clearRect(0, 0, frame.width, frame.height);
  fc.drawImage(rig.tex, 0, 0);
  if (!eye && g !== 2) rig.gaze.forEach((p) => stamp(p, g));
  if (rig.custom) {
    if (eye) rig.eyes.forEach((p) => stamp(p, eye));
  } else {
    if (eye && defaultEyes.naturalWidth)
      fc.drawImage(defaultEyes, 147 * eye, 0, 147, 38, 211, 217, 147, 38);
  }
  if (mouth) {
    const amount = $("settingsDialog").open
      ? +$("dental").value
      : (prefs.dental ?? 0.9);
    stamp(rig.lips.neutral, mouth);
    fc.globalAlpha = cap(amount, 0, 1);
    stamp(rig.lips.dent, mouth);
    fc.globalAlpha = 1;
  }
  if ($("settingsDialog").open) {
    const face = $("facemon"),
      ctx = face.getContext("2d"),
      k = rig.scale;
    ctx.clearRect(0, 0, face.width, face.height);
    ctx.drawImage(
      frame,
      183 * k,
      149 * k,
      204 * k,
      216 * k,
      0,
      0,
      face.width,
      face.height,
    );
  }
  // Smoothly varying horizontal strips keep shoulders anchored as the head tilts.
  pc.clearRect(0, 0, 576, 768);
  if (!motion) pc.drawImage(frame, 0, 0, 576, 768);
  else {
    const head = look * 0.75 + Math.sin(0.63 * t) * 1.8 + attention * 2.2,
      breath = Math.sin(t * 1.28) * 1.75,
      nod =
        (mode === "talk"
          ? Math.sin(t * 3.2) * 1.65
          : attention * Math.sin(t * 2.5)) + breath;
    const offset = (y) =>
      Math.exp(-((y - 240) ** 2) / 38500) * nod +
      breath * Math.exp(-((y - 460) ** 2) / 19000);
    for (let y = 0; y < 768; y += 4) {
      let k = Math.exp(-((y - 240) ** 2) / 38000),
        x = head * k,
        top = y + offset(y),
        bottom = y + 4 + offset(y + 4);
      pc.drawImage(
        frame,
        0,
        y * rig.scale,
        frame.width,
        4 * rig.scale,
        x,
        top,
        576,
        bottom - top + 0.25,
      );
    }
    $("portrait").style.transform =
      `translateX(-50%) rotate(${Math.sin(t * 0.43) * 0.32 - attention * 0.8 + look * 0.1}deg)`;
  }
  bars.forEach((b, i) => {
    b.style.height =
      3 +
      Math.sin((Math.PI * i) / 25) *
        (4 +
          17 *
            Math.abs(Math.sin(i * 1.8 + 0.3)) *
            Math.abs(
              Math.cos(
                i * 0.45 + (motion ? t * (mode === "talk" ? 5 : 0.55) : 0),
              ),
            )) +
      "px";
  });
}
requestAnimationFrame(draw);
