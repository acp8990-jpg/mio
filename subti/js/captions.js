// Motor de subtítulos: agrupa las palabras en «páginas» (lo que se ve a la vez en pantalla) y las
// dibuja en un canvas con el estilo elegido. Se usa igual en la vista previa y en la exportación,
// así que lo que ves es exactamente lo que se exporta.

export const FONTS = [
  ['Anton', 400, 'anton-latin-400-normal'],
  ['Archivo Black', 400, 'archivo-black-latin-400-normal'],
  ['Bricolage Grotesque', 800, 'bricolage-grotesque-latin-800-normal'],
  ['Caveat', 700, 'caveat-latin-700-normal'],
  ['DM Sans', 600, 'dm-sans-latin-600-normal'],
  ['DM Sans', 800, 'dm-sans-latin-800-normal'],
  ['Manrope', 600, 'manrope-latin-600-normal'],
  ['Manrope', 800, 'manrope-latin-800-normal'],
  ['Space Grotesk', 700, 'space-grotesk-latin-700-normal'],
  ['JetBrains Mono', 700, 'jetbrains-mono-latin-700-normal'],
];

let fontsReady = null;
export function loadFonts(base = './fonts/') {
  fontsReady ??= Promise.all(
    FONTS.map(async ([family, weight, file]) => {
      try {
        const face = new FontFace(family, `url(${base}${file}.woff2)`, { weight: String(weight) });
        await face.load();
        document.fonts.add(face);
      } catch (err) {
        console.warn('No se pudo cargar la fuente', family, err);
      }
    }),
  );
  return fontsReady;
}

/** Colores de resaltado que se ofrecen en el editor. */
export const SWATCHES = ['#FFE14D', '#3DFF8B', '#00E5FF', '#8B7BFF', '#FF4D8D', '#FF7A3D', '#FFFFFF'];

/**
 * Estilos. `pro: true` = solo en Subti Pro (se pueden probar, no exportar sin marca).
 * size: tamaño relativo al ancho del vídeo. reveal: 'page' (la frase entera aparece a la vez) o
 * 'word' (cada palabra aparece cuando se dice) o 'type' (letra a letra).
 */
export const STYLES = {
  pop: {
    name: 'Impacto', pro: false, font: 'Anton', weight: 400, upper: true, size: 0.11, words: 3,
    fill: '#FFFFFF', stroke: '#000000', strokeW: 0.14, shadow: 'rgba(0,0,0,.55)',
    active: '#FFE14D', activeScale: 1.14, reveal: 'page', enter: 'pop', lineH: 1.08,
  },
  karaoke: {
    name: 'Karaoke', pro: false, font: 'Archivo Black', weight: 400, upper: true, size: 0.078, words: 4,
    fill: '#FFFFFF', future: 'rgba(255,255,255,.42)', stroke: '#000000', strokeW: 0.12, shadow: 'rgba(0,0,0,.5)',
    active: '#3DFF8B', activeScale: 1.0, reveal: 'page', enter: 'rise', lineH: 1.14,
  },
  minimal: {
    name: 'Limpio', pro: false, font: 'DM Sans', weight: 600, upper: false, size: 0.062, words: 6,
    fill: '#FFFFFF', pill: 'rgba(12,12,16,.62)', active: null, reveal: 'word', enter: 'fade', lineH: 1.28,
  },
  caja: {
    name: 'Caja', pro: true, font: 'Manrope', weight: 800, upper: false, size: 0.082, words: 3,
    fill: '#FFFFFF', shadow: 'rgba(0,0,0,.6)', stroke: '#000000', strokeW: 0.06,
    active: '#8B7BFF', box: true, boxText: '#FFFFFF', reveal: 'word', enter: 'pop', lineH: 1.3,
  },
  neon: {
    name: 'Neón', pro: true, font: 'Space Grotesk', weight: 700, upper: true, size: 0.084, words: 3,
    fill: '#F4FDFF', glow: '#00E5FF', active: '#FF4D8D', activeScale: 1.08, reveal: 'page', enter: 'flicker', lineH: 1.12,
  },
  titular: {
    name: 'Titular', pro: true, font: 'Bricolage Grotesque', weight: 800, upper: false, size: 0.098, words: 2,
    fill: '#FFFFFF', stroke: '#111111', strokeW: 0.1, shadow: 'rgba(0,0,0,.5)', active: '#FF7A3D', activeScale: 1.18,
    reveal: 'word', enter: 'bounce', lineH: 1.04,
  },
  rotulador: {
    name: 'Rotulador', pro: true, font: 'Caveat', weight: 700, upper: false, size: 0.1, words: 4,
    fill: '#FFFFFF', stroke: '#141414', strokeW: 0.1, active: '#FFE14D', marker: true, markerText: '#141414',
    reveal: 'page', enter: 'rise', lineH: 1.05,
  },
  maquina: {
    name: 'Máquina', pro: true, font: 'JetBrains Mono', weight: 700, upper: false, size: 0.058, words: 5,
    fill: '#FFFFFF', pill: 'rgba(0,0,0,.78)', pillRadius: 0.12, active: '#3DFF8B', reveal: 'type', enter: 'none', lineH: 1.3,
  },
};

export const DEFAULT_SETTINGS = {
  style: 'pop',
  size: 1, // multiplicador sobre el tamaño del estilo
  y: 0.7, // centro vertical de los subtítulos (0 = arriba, 1 = abajo)
  words: null, // palabras por página (null = la del estilo)
  upper: null, // mayúsculas (null = la del estilo)
  color: null, // color de resaltado (null = el del estilo)
};

export function resolveStyle(settings) {
  const base = STYLES[settings.style] || STYLES.pop;
  return {
    ...base,
    words: settings.words ?? base.words,
    upper: settings.upper ?? base.upper,
    active: settings.color && base.active !== null ? settings.color : base.active,
    size: base.size * (settings.size || 1),
  };
}

// ---------------------------------------------------------------- páginas

const ENDS = /[.!?…]["»”)]*$/;
const SOFT = /[,;:]["»”)]*$/;

/**
 * words: [{ w, s, e }] en segundos. Devuelve [{ s, e, words: [{ w, s, e, i }] }].
 * Corta por número de palabras, por longitud, en los puntos y en las pausas.
 */
export function buildPages(words, maxWords = 3, maxChars = 22) {
  const pages = [];
  let cur = null;
  let chars = 0;
  words.forEach((wd, i) => {
    const prev = words[i - 1];
    const gap = prev ? wd.s - prev.e : 0;
    const breakHere =
      !cur ||
      cur.words.length >= maxWords ||
      chars + wd.w.length > maxChars * Math.max(1, maxWords / 3) ||
      gap > 0.65 ||
      (prev && ENDS.test(prev.w)) ||
      (prev && SOFT.test(prev.w) && cur.words.length >= Math.ceil(maxWords / 2));
    if (breakHere) {
      cur = { s: wd.s, e: wd.e, words: [] };
      pages.push(cur);
      chars = 0;
    }
    cur.words.push({ ...wd, i });
    cur.e = wd.e;
    chars += wd.w.length + 1;
  });
  // Cada página se queda un poco más en pantalla (sin pisar la siguiente) para que dé tiempo a leerla.
  for (let k = 0; k < pages.length; k++) {
    const next = pages[k + 1];
    pages[k].e = next ? Math.min(next.s, pages[k].e + 0.6) : pages[k].e + 0.8;
  }
  return pages;
}

export function pageAt(pages, t) {
  // búsqueda binaria: última página que ya ha empezado
  let lo = 0;
  let hi = pages.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].s <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  return t < pages[found].e ? found : null;
}

// ---------------------------------------------------------------- dibujo

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const easeBack = (x) => {
  x = clamp01(x);
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function layout(ctx, page, st, W, fontPx) {
  ctx.font = `${st.weight} ${fontPx}px "${st.font}"`;
  // Las palabras que crecen al decirse necesitan más aire para no pisar a sus vecinas.
  const grow = st.activeScale && st.activeScale > 1 ? (st.activeScale - 1) * 0.9 : 0;
  const space = ctx.measureText(' ').width * (st.box || st.marker ? 1.6 : 1) + fontPx * (0.06 + grow);
  const maxW = W * 0.84;
  const lines = [];
  let line = { items: [], w: 0 };
  for (const wd of page.words) {
    const text = st.upper ? wd.w.toLocaleUpperCase('es') : wd.w;
    const w = ctx.measureText(text).width;
    const add = line.items.length ? space + w : w;
    if (line.items.length && line.w + add > maxW) {
      lines.push(line);
      line = { items: [], w: 0 };
    }
    line.items.push({ wd, text, w, x: line.items.length ? line.w + space : 0 });
    line.w += line.items.length > 1 ? space + w : w;
  }
  if (line.items.length) lines.push(line);
  // Si una palabra sola no cabe, se reduce el tamaño de toda la página.
  const widest = Math.max(...lines.map((l) => l.w));
  return { lines, space, scale: widest > maxW ? maxW / widest : 1 };
}

/**
 * Dibuja los subtítulos del instante t (segundos) sobre un canvas de W×H.
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 */
export function drawCaptions(ctx, W, H, t, pages, settings) {
  const idx = pageAt(pages, t);
  if (idx === null) return;
  const page = pages[idx];
  const st = resolveStyle(settings);
  const base = Math.round(Math.min(W, H * 0.75) * st.size);
  let { lines, scale } = layout(ctx, page, st, W, base);
  let fontPx = base;
  if (scale < 1) {
    fontPx = Math.floor(base * scale);
    ({ lines } = layout(ctx, page, st, W, fontPx));
  }
  const lineH = fontPx * st.lineH;
  const blockH = lines.length * lineH;
  const cy = H * settings.y;
  const top = cy - blockH / 2;

  const age = t - page.s;
  const left = page.e - t;
  // Animación de entrada y salida de la página entera
  let alpha = 1;
  let pageScale = 1;
  let dy = 0;
  switch (st.enter) {
    case 'pop':
      pageScale = 0.78 + 0.22 * easeBack(age / 0.18);
      alpha = clamp01(age / 0.06);
      break;
    case 'bounce':
      pageScale = 0.6 + 0.4 * easeBack(age / 0.24);
      alpha = clamp01(age / 0.08);
      break;
    case 'rise':
      dy = (1 - easeOut(age / 0.22)) * fontPx * 0.35;
      alpha = clamp01(age / 0.12);
      break;
    case 'fade':
      alpha = clamp01(age / 0.15);
      break;
    case 'flicker':
      alpha = age < 0.16 ? (Math.floor(age * 50) % 2 ? 0.35 : 1) : 1;
      break;
  }
  alpha *= clamp01(left / 0.08);
  if (alpha <= 0) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.font = `${st.weight} ${fontPx}px "${st.font}"`;
  ctx.translate(W / 2, cy + dy);
  ctx.scale(pageScale, pageScale);
  ctx.translate(-W / 2, -cy);

  // palabra activa: la última que ya ha empezado (se mantiene durante las pausas)
  let activeI = -1;
  for (const wd of page.words) if (wd.s <= t) activeI = wd.i;

  // Fondo tipo «píldora» por línea
  if (st.pill) {
    const padX = fontPx * 0.42;
    const padY = fontPx * 0.2;
    ctx.fillStyle = st.pill;
    lines.forEach((ln, li) => {
      const vis = visibleWidth(ln, st, t, page);
      if (vis <= 0) return;
      const x = (W - vis) / 2 - padX;
      const y = top + li * lineH + (lineH - fontPx) / 2 - padY;
      roundRect(ctx, x, y, vis + padX * 2, fontPx + padY * 2, fontPx * (st.pillRadius ?? 0.35));
      ctx.fill();
    });
  }

  lines.forEach((ln, li) => {
    // Con palabras que van apareciendo, la línea se centra según lo que ya se ve.
    const x0 = (W - visibleWidth(ln, st, t)) / 2;
    const y = top + li * lineH + lineH / 2;
    for (const it of ln.items) {
      const { wd } = it;
      const started = wd.s <= t;
      const isActive = wd.i === activeI && st.active;
      if (st.reveal !== 'page' && !started) continue;

      let text = it.text;
      if (st.reveal === 'type') {
        const dur = Math.max(0.12, Math.min(wd.e - wd.s, 0.5));
        const n = Math.ceil(text.length * clamp01((t - wd.s) / dur));
        text = text.slice(0, n);
        if (!text) continue;
      }

      const wAge = t - wd.s;
      let s = 1;
      let wy = 0;
      if (isActive && st.activeScale && st.activeScale !== 1) {
        s = 1 + (st.activeScale - 1) * easeBack(wAge / 0.16);
      }
      if (st.reveal === 'word' && wAge < 0.2) {
        if (st.enter === 'bounce' || st.enter === 'pop') s *= 0.7 + 0.3 * easeBack(wAge / 0.2);
        else wy = (1 - easeOut(wAge / 0.18)) * fontPx * 0.25;
      }
      const cx = x0 + it.x + it.w / 2;
      ctx.save();
      ctx.translate(cx, y + wy);
      ctx.scale(s, s);
      if (st.reveal === 'word' && wAge < 0.12) ctx.globalAlpha *= clamp01(wAge / 0.12);

      let color = st.fill;
      if (st.future && !started) color = st.future;
      if (isActive && !st.box && !st.marker) color = st.active;

      // Caja o subrayado de rotulador detrás de la palabra activa
      if (isActive && (st.box || st.marker)) {
        const k = easeOut(wAge / 0.14);
        const padX = fontPx * 0.2;
        const h = fontPx * (st.marker ? 0.72 : 1.12);
        const w = (it.w + padX * 2) * (st.marker ? k : 0.85 + 0.15 * easeBack(wAge / 0.16));
        ctx.fillStyle = st.active;
        if (st.marker) {
          ctx.save();
          ctx.rotate(-0.03);
          roundRect(ctx, -it.w / 2 - padX, -h / 2 + fontPx * 0.08, w, h, fontPx * 0.12);
          ctx.globalAlpha *= 0.95;
          ctx.fill();
          ctx.restore();
        } else {
          roundRect(ctx, -w / 2, -h / 2, w, h, fontPx * 0.22);
          ctx.fill();
        }
        color = st.marker ? st.markerText : st.boxText;
      }

      const tx = -it.w / 2;
      if (st.glow) {
        ctx.shadowColor = isActive ? st.active : st.glow;
        ctx.shadowBlur = fontPx * 0.45;
        ctx.fillStyle = color;
        ctx.fillText(text, tx, 0);
        ctx.shadowBlur = fontPx * 0.15;
        ctx.fillText(text, tx, 0);
        ctx.shadowBlur = 0;
      } else {
        const boxed = isActive && (st.box || st.marker);
        if (st.shadow && !boxed) {
          ctx.shadowColor = st.shadow;
          ctx.shadowBlur = fontPx * 0.18;
          ctx.shadowOffsetY = fontPx * 0.05;
        }
        if (st.stroke && !boxed) {
          ctx.strokeStyle = st.stroke;
          ctx.lineWidth = fontPx * st.strokeW;
          ctx.strokeText(text, tx, 0);
          ctx.shadowColor = 'transparent';
        }
        ctx.fillStyle = color;
        ctx.fillText(text, tx, 0);
      }
      // cursor de máquina de escribir
      if (st.reveal === 'type' && wd.i === activeI && Math.floor(t * 2.5) % 2 === 0) {
        const cw = ctx.measureText(text).width;
        ctx.fillStyle = st.active || st.fill;
        ctx.fillRect(tx + cw + fontPx * 0.06, -fontPx * 0.42, fontPx * 0.09, fontPx * 0.84);
      }
      ctx.restore();
    }
  });
  ctx.restore();
}

function visibleWidth(ln, st, t) {
  if (st.reveal === 'page') return ln.w;
  let w = 0;
  for (const it of ln.items) if (it.wd.s <= t) w = it.x + it.w;
  return w;
}

/** Marca de agua de la versión gratuita: discreta pero legible, arriba a la derecha. */
export function drawWatermark(ctx, W, H) {
  const u = Math.min(W, H) / 1080;
  const fs = Math.round(30 * u);
  ctx.save();
  ctx.font = `800 ${fs}px "Manrope"`;
  const label = 'hecho con subti';
  const tw = ctx.measureText(label).width;
  const dot = fs * 0.62;
  const padX = fs * 0.6;
  const h = fs * 1.8;
  const w = tw + dot + padX * 2 + fs * 0.4;
  const x = W - w - 36 * u;
  const y = 48 * u + (H > W ? 90 * u : 0);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = 'rgba(10,10,14,.55)';
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  const g = ctx.createLinearGradient(x, 0, x + dot * 2, 0);
  g.addColorStop(0, '#8B7BFF');
  g.addColorStop(1, '#FF4D8D');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x + padX + dot / 2, y + h / 2, dot / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + padX + dot + fs * 0.4, y + h / 2 + 1);
  ctx.restore();
}

// ---------------------------------------------------------------- SRT / texto

const pad = (n, l = 2) => String(n).padStart(l, '0');
const srtTime = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

export function toSRT(words) {
  const pages = buildPages(words, 7, 42);
  return pages
    .map((p, i) => `${i + 1}\n${srtTime(p.s)} --> ${srtTime(p.e)}\n${p.words.map((w) => w.w).join(' ')}\n`)
    .join('\n');
}

/**
 * Reparte los tiempos cuando el usuario edita el texto de una página: si el número de palabras no
 * cambia, se conservan los tiempos; si cambia, se reparten en el mismo intervalo según su longitud.
 */
export function retimeWords(oldWords, text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  if (tokens.length === oldWords.length) return tokens.map((w, k) => ({ ...oldWords[k], w }));
  const s = oldWords[0].s;
  const e = oldWords[oldWords.length - 1].e;
  const total = tokens.reduce((a, w) => a + w.length + 1, 0);
  let acc = s;
  return tokens.map((w) => {
    const d = ((w.length + 1) / total) * (e - s);
    const wd = { w, s: acc, e: acc + d };
    acc += d;
    return wd;
  });
}
