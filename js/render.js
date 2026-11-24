// Dibuja un fotograma del vídeo final: encuadre, zoom, transiciones, elementos, barra de progreso
// y subtítulos. Lo usan igual la vista previa y la exportación, así que lo que ves es lo que sale.

export const FORMATS = {
  '9:16': 9 / 16,
  '16:9': 16 / 9,
  '1:1': 1,
  '4:5': 4 / 5,
};

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Tamaño de salida a partir del primer clip, el formato y la resolución (lado corto). */
export function outputDims(srcW, srcH, format, resolution) {
  const aspect = FORMATS[format] ?? srcW / srcH;
  const short = resolution === 'original' || !resolution ? Math.min(srcW, srcH) : resolution;
  return aspect >= 1
    ? { width: even(short * aspect), height: even(short) }
    : { width: even(short), height: even(short / aspect) };
}

const FONTS = {
  sans: (px) => `800 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`,
  redondeada: (px) => `800 ${px}px "Arial Rounded MT Bold", "Nunito", "Varela Round", system-ui, sans-serif`,
  condensada: (px) => `700 ${px}px "Arial Narrow", "Roboto Condensed", "Oswald", Impact, sans-serif`,
  serif: (px) => `700 ${px}px Georgia, "Times New Roman", serif`,
};
export const fontFor = (name, px) => (FONTS[name] || FONTS.sans)(px);

const TRANS = 0.3; // duración de las transiciones (s)

/** Zoom de la toma en el instante t (1 = sin zoom). */
function zoomAt(edit, piece, t) {
  let z = 1;
  if (edit.zoom === 'alterno') z = piece.index % 2 ? 1.14 : 1;
  else if (edit.zoom === 'acercar') {
    const c = piece.clip;
    const k = (t - c.outStart) / Math.max(0.1, c.outEnd - c.outStart);
    z = 1 + 0.08 * Math.min(1, Math.max(0, k));
  }
  if (edit.transition === 'zoom') {
    const c = piece.clip;
    const dIn = t - c.outStart;
    const dOut = c.outEnd - t;
    if (c.index > 0 && dIn < TRANS) z *= 1 + 0.35 * (1 - dIn / TRANS) ** 2;
    if (dOut < TRANS && !c.last) z *= 1 + 0.35 * (1 - dOut / TRANS) ** 2;
  }
  return z;
}

/** Opacidad del velo de transición (negro o blanco) en el instante t. */
function veilAt(edit, piece, t) {
  if (edit.transition !== 'fundido' && edit.transition !== 'flash') return 0;
  const c = piece.clip;
  const half = TRANS / 2;
  const dIn = t - c.outStart;
  const dOut = c.outEnd - t;
  let a = 0;
  if (c.index > 0 && dIn < half) a = Math.max(a, 1 - dIn / half);
  if (!c.last && dOut < half) a = Math.max(a, 1 - dOut / half);
  return edit.transition === 'flash' ? a * 0.85 : a;
}

/**
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {object} o { source, srcW, srcH, t, piece, timeline, edit, images: Map<assetId, ImageBitmap>, scale? }
 */
export function drawFrame(ctx, W, H, o) {
  const { source, srcW, srcH, t, piece, timeline, edit } = o;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (source && srcW && srcH && piece) {
    // Encuadre «cover» con desplazamiento vertical elegible y zoom hacia la cara (algo por encima del centro).
    const z = zoomAt(edit, piece, t);
    const base = Math.max(W / srcW, H / srcH);
    const s = base * z;
    const dw = srcW * s;
    const dh = srcH * s;
    const fx = 0.5;
    const fy = 0.42;
    let x = W * fx - dw * fx;
    let y = (H - dh) * (edit.reframe ?? 0.5);
    if (z > 1) y = H * fy - (H * fy - y) * z;
    x = Math.min(0, Math.max(W - dw, x));
    y = Math.min(0, Math.max(H - dh, y));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, x, y, dw, dh);
    const veil = veilAt(edit, piece, t);
    if (veil > 0) {
      ctx.fillStyle = edit.transition === 'flash' ? `rgba(255,255,255,${veil})` : `rgba(0,0,0,${veil})`;
      ctx.fillRect(0, 0, W, H);
    }
  }
  drawOverlays(ctx, W, H, t, edit, o.images, timeline);
  if (edit.progress.on && timeline.duration > 0) drawProgress(ctx, W, H, t / timeline.duration, edit.progress);
  if (edit.captions.on && piece) drawCaptions(ctx, W, H, piece.clip, t, edit.captions);
  ctx.restore();
}

function drawProgress(ctx, W, H, k, p) {
  const h = Math.max(4, Math.round(Math.min(W, H) * 0.012));
  const y = p.position === 'top' ? 0 : H - h;
  ctx.fillStyle = 'rgba(255,255,255,.25)';
  ctx.fillRect(0, y, W, h);
  ctx.fillStyle = p.color;
  ctx.fillRect(0, y, W * Math.min(1, Math.max(0, k)), h);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/** Textos, emojis, imágenes y logo encima del vídeo. */
function drawOverlays(ctx, W, H, t, edit, images, timeline) {
  const unit = Math.min(W, H);
  for (const ov of edit.overlays) {
    const start = ov.start ?? 0;
    const end = ov.end ?? Infinity;
    if (t < start || t > end) continue;
    // Pequeña animación de entrada.
    const k = Math.min(1, (t - start) / 0.25);
    const pop = 0.85 + 0.15 * (1 - (1 - k) ** 3);
    const cx = ov.x * W;
    const cy = ov.y * H;
    ctx.save();
    ctx.globalAlpha = k;
    ctx.translate(cx, cy);
    ctx.scale(pop, pop);
    if (ov.type === 'image') {
      const img = images?.get(ov.assetId);
      if (img) {
        const w = unit * ov.size;
        const h = (w * img.height) / img.width;
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
      }
    } else {
      const px = Math.round(unit * (ov.type === 'emoji' ? 0.16 : 0.07) * ov.size);
      ctx.font = ov.type === 'emoji' ? `${px}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif` : fontFor(ov.font || 'sans', px);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lines = String(ov.text || '').split('\n');
      const lh = px * 1.2;
      const widths = lines.map((l) => ctx.measureText(l).width);
      const bw = Math.max(...widths) + px * 0.9;
      const bh = lh * lines.length + px * 0.45;
      if (ov.type === 'text' && ov.bg) {
        ctx.fillStyle = ov.bg;
        roundRect(ctx, -bw / 2, -bh / 2, bw, bh, px * 0.3);
        ctx.fill();
      }
      lines.forEach((l, i) => {
        const y = (i - (lines.length - 1) / 2) * lh;
        if (ov.type === 'text' && !ov.bg) {
          ctx.lineJoin = 'round';
          ctx.lineWidth = px * 0.16;
          ctx.strokeStyle = 'rgba(0,0,0,.85)';
          ctx.strokeText(l, 0, y);
        }
        ctx.fillStyle = ov.color || '#fff';
        ctx.fillText(l, 0, y);
      });
    }
    ctx.restore();
  }
  // Logo / marca de agua en una esquina durante todo el vídeo.
  const logo = edit.logo;
  const img = logo.assetId && images?.get(logo.assetId);
  if (img) {
    const w = unit * logo.size;
    const h = (w * img.height) / img.width;
    const m = unit * 0.04;
    const x = logo.corner.includes('l') ? m : W - w - m;
    const y = logo.corner.includes('t') ? m + (edit.progress.on && edit.progress.position === 'top' ? unit * 0.02 : 0) : H - h - m;
    ctx.save();
    ctx.globalAlpha = logo.opacity;
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
  }
}

/** Parte una frase en líneas que quepan en `maxW`. */
function layoutLines(ctx, words, maxW, space) {
  const lines = [];
  let line = [];
  let width = 0;
  for (const w of words) {
    const ww = ctx.measureText(w.display).width;
    if (line.length && width + space + ww > maxW) {
      lines.push({ words: line, width });
      line = [];
      width = 0;
    }
    width += (line.length ? space : 0) + ww;
    line.push({ ...w, width: ww });
  }
  if (line.length) lines.push({ words: line, width });
  return lines;
}

/** Subtítulos: la frase actual con la palabra que se está diciendo destacada según el estilo. */
export function drawCaptions(ctx, W, H, clip, t, cap) {
  const chunk = clip.chunks.find((c) => t >= c.start && t < c.end);
  if (!chunk) return;
  const unit = Math.min(W, H);
  const big = cap.style === 'grande';
  const px = Math.round(unit * (big ? 0.11 : 0.068) * cap.size);
  ctx.save();
  ctx.font = fontFor(cap.font, px);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  const upper = cap.upper || big;
  const words = chunk.words.map((w) => ({ ...w, display: upper ? w.text.toLocaleUpperCase('es') : w.text }));
  const space = ctx.measureText(' ').width;
  const lines = layoutLines(ctx, words, W * 0.86, space);
  const lh = px * 1.22;
  const blockH = lh * lines.length;
  const cy = Math.min(H - blockH / 2 - unit * 0.04, Math.max(blockH / 2 + unit * 0.04, H * cap.position));

  // Animación de aparición de la frase.
  const appear = Math.min(1, (t - chunk.start) / 0.12);
  const popScale = big ? 0.8 + 0.2 * appear : 0.94 + 0.06 * appear;

  lines.forEach((line, li) => {
    const y = cy + (li - (lines.length - 1) / 2) * lh;
    let x = W / 2 - line.width / 2;
    for (const w of line.words) {
      const current = t >= w.start && t < w.end;
      const spoken = t >= w.start;
      ctx.save();
      const wx = x + w.width / 2;
      ctx.translate(wx, y);
      ctx.scale(popScale, popScale);
      let fill = cap.color;
      if (cap.style === 'resaltado' && current) {
        const padX = px * 0.18;
        ctx.fillStyle = cap.accent;
        roundRect(ctx, -w.width / 2 - padX, -px * 0.62, w.width + padX * 2, px * 1.24, px * 0.22);
        ctx.fill();
        fill = contrastOn(cap.accent);
      } else if (cap.style === 'karaoke' && spoken) fill = cap.accent;
      else if (big && current) fill = cap.accent;
      if (!(cap.style === 'resaltado' && current)) {
        ctx.lineWidth = px * 0.2;
        ctx.strokeStyle = 'rgba(0,0,0,.9)';
        ctx.strokeText(w.display, -w.width / 2, 0);
      }
      ctx.fillStyle = fill;
      ctx.fillText(w.display, -w.width / 2, 0);
      ctx.restore();
      x += w.width + space;
    }
  });
  ctx.restore();
}

function contrastOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#000';
  const n = parseInt(m[1], 16);
  const l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.6 ? '#111' : '#fff';
}
