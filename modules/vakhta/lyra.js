// Портрет Лиры для вахтёра: тот же риг, что в avatar.js на главной странице —
// предсэмплированные полосы глаз и губ, зубы за губами, дыхание и покачивание.
// Если на главной выбран свой портрет (localStorage «lyra:portrait»), вахтёр берёт
// именно его: персонаж сохраняется, меняются только размер и место показа.
const VakhtaLyra = (() => {
  const PORTRAIT_KEY = "lyra:portrait";
  const surface = (w, h) =>
    Object.assign(document.createElement("canvas"), { width: w, height: h });
  const cap = (v, a, b) => Math.max(a, Math.min(b, v));
  const EYES = [
    [242.5, 241.5],
    [326, 238.5],
  ];

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

  function readSaved() {
    try {
      const raw = localStorage.getItem(PORTRAIT_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (!/^data:image\/(webp|jpeg|png);base64,/.test(saved?.src || "")) return null;
      if (!Array.isArray(saved.eyes) || saved.eyes.length !== 2) return null;
      return saved;
    } catch {
      return null;
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(Error("Портрет не загрузился."));
      img.src = src;
    });
  }

  function create(canvas, options = {}) {
    if (!canvas) throw Error("Нужен canvas для портрета.");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw Error("Браузер не умеет рисовать на canvas.");
    const motion =
      options.motion !== false &&
      !(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

    let rig = null,
      frame = null,
      fc = null,
      mode = "idle",
      analyser = null,
      jaw = 0,
      look = 0,
      attention = 0,
      aim = 0,
      pointerUntil = 0,
      blink = -1000,
      nextBlink = 1200 + Math.random() * 2500,
      nextGaze = 2500,
      wordPulse = -1000,
      voiceUntil = 0,
      lastLevel = 0,
      mouthIndex = 0,
      last = 0,
      raf = 0,
      character = "lyra",
      loading = 0;

    function applyRig(next, who) {
      rig = next;
      character = who;
      const k = rig.scale || 1;
      frame = surface(576 * k, 768 * k);
      fc = frame.getContext("2d");
      canvas.width = 576 * k;
      canvas.height = 768 * k;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      if (typeof options.onChange === "function") options.onChange(who, rig);
    }

    function stamp(p, i) {
      if (p) fc.drawImage(p.strip, p.w * i, 0, p.w, p.h, p.ox, p.oy, p.w, p.h);
    }

    const blinkSprite = new Image();
    blinkSprite.src = "/assets/eyes.png";

    async function defaultRig() {
      const img = await loadImage("/assets/lyra.webp");
      applyRig(buildRig(img, EYES, null, false), "lyra");
    }

    // Портрет из Лиры. Возвращает true, если персонаж взят с главной страницы.
    async function loadPortrait() {
      const token = ++loading;
      const saved = readSaved();
      if (!saved) {
        // своего портрета нет: показываем стандартную Лиру (в том числе при первом кадре)
        if (!rig || character !== "lyra") await defaultRig();
        return false;
      }
      try {
        const img = await loadImage(saved.src);
        if (token !== loading) return true;
        applyRig(
          buildRig(img, saved.eyes, saved.mouth || null, true, !!saved.alpha),
          "custom",
        );
        return true;
      } catch {
        if (token === loading) await defaultRig().catch(() => {});
        return false;
      }
    }

    function amplitude() {
      if (!analyser) return null;
      const pcm = new Float32Array(512);
      analyser.getFloatTimeDomainData(pcm);
      let energy = 0;
      for (const v of pcm) energy += v * v;
      const rms = Math.sqrt(energy / pcm.length);
      return Math.min(1, Math.sqrt(Math.max(0, rms - 0.007)) * 2.75);
    }

    function draw(ms) {
      raf = requestAnimationFrame(draw);
      if (!rig || document.hidden || ms - last < 32) return;
      last = ms;
      const t = ms * 0.001;
      const k = rig.scale || 1;
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
      const eye = Math.round(10 * Math.max(0, 1 - Math.abs((ms - blink - 93) / 100))),
        g = motion ? cap(2 + Math.round(look), 0, 4) : 2;
      const stress = ms - wordPulse < 210 ? 1 : 0.72;
      // Ритм губ без микрофона/анализатора: слоги, ударения и паузы.
      const rhythm =
        mode === "talk"
          ? stress *
            Math.abs(Math.sin(11 * t + 0.8 * Math.sin(4.7 * t))) *
            (0.36 + 0.64 * Math.abs(Math.sin(t * 3.9)))
          : 0;
      let target = rhythm;
      if (mode === "talk") {
        const level = amplitude();
        if (level !== null && level > 0.02) {
          voiceUntil = ms + 180; // голос действительно звучит
          lastLevel = level;
        }
        // Анализатор иногда отдаёт нули: AudioContext на паузе, элемент уже
        // остановлен или переключились на голос браузера. Тогда губы двигаются
        // по ритму — рот не должен замирать, пока Лира говорит.
        target = ms < voiceUntil ? Math.max(lastLevel, rhythm * 0.34) : rhythm;
        if (ms >= voiceUntil) lastLevel = 0;
      }
      jaw += (target - jaw) * 0.74;
      const mouth = cap(Math.round(jaw * 11), 0, 10);
      mouthIndex = mouth;

      fc.clearRect(0, 0, frame.width, frame.height);
      fc.drawImage(rig.tex, 0, 0);
      if (!eye && g !== 2) rig.gaze.forEach((p) => stamp(p, g));
      if (rig.custom) {
        if (eye) rig.eyes.forEach((p) => stamp(p, eye));
      } else if (eye && blinkSprite.naturalWidth) {
        fc.drawImage(blinkSprite, 147 * eye, 0, 147, 38, 211 * k, 217 * k, 147 * k, 38 * k);
      }
      if (mouth) {
        stamp(rig.lips.neutral, mouth);
        fc.globalAlpha = 0.9;
        stamp(rig.lips.dent, mouth);
        fc.globalAlpha = 1;
      }

      ctx.clearRect(0, 0, 576, 768);
      if (!motion) {
        ctx.drawImage(frame, 0, 0, 576, 768);
        return;
      }
      // Пологие горизонтальные полосы: плечи на месте, голова покачивается.
      const headAngle = look * 0.75 + Math.sin(0.63 * t) * 1.8 + attention * 2.2,
        breath = Math.sin(t * 1.28) * 1.75,
        nod = (mode === "talk" ? Math.sin(t * 3.2) * 1.65 : attention * Math.sin(t * 2.5)) + breath,
        offset = (y) =>
          Math.exp(-((y - 240) ** 2) / 38500) * nod +
          breath * Math.exp(-((y - 460) ** 2) / 19000);
      for (let y = 0; y < 768; y += 4) {
        const near = Math.exp(-((y - 240) ** 2) / 38000),
          x = headAngle * near,
          top = y + offset(y),
          bottom = y + 4 + offset(y + 4);
        ctx.drawImage(frame, 0, y * k, frame.width, 4 * k, x, top, 576, bottom - top + 0.25);
      }
      canvas.dataset.tilt = String(Math.round((Math.sin(t * 0.43) * 0.32 - attention * 0.8 + look * 0.1) * 10) / 10);
    }

    function start() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    }
    function stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    }

    return {
      start,
      stop,
      canvas,
      loadPortrait,
      get character() {
        return character;
      },
      get ready() {
        return !!rig;
      },
      get scale() {
        return rig ? rig.scale || 1 : 1;
      },
      setMode(next) {
        if (next === "talk" && mode !== "talk") wordPulse = performance.now();
        mode = next === "talk" || next === "listen" ? next : "idle";
      },
      get mode() {
        return mode;
      },
      // текущее раскрытие рта (0…10) и звучит ли голос — для проверок и отладки
      get mouth() {
        return mouthIndex;
      },
      get voice() {
        return lastLevel;
      },
      setAnalyser(node) {
        analyser = node || null;
      },
      // Взгляд за курсором: -1…1 по горизонтали, как на главной странице.
      setPointer(px) {
        aim = cap(4 * (px - 0.5), -2, 2);
        pointerUntil = performance.now() + 1200;
      },
    };
  }

  return { create, readSaved, PORTRAIT_KEY };
})();

if (typeof module !== "undefined" && module.exports) module.exports = VakhtaLyra;
else if (typeof window !== "undefined") window.VakhtaLyra = VakhtaLyra;
