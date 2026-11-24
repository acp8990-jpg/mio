// Línea de tiempo del vídeo final: qué trozo de cada toma suena en cada momento, con recortes,
// silencios quitados y el momento exacto de cada palabra (para los subtítulos).

import { tokenize } from './voice.js';

export const EDIT_DEFAULTS = {
  captions: {
    on: true,
    style: 'resaltado', // clasico | resaltado | karaoke | grande
    font: 'sans', // sans | redondeada | condensada | serif
    size: 1,
    position: 0.72, // 0 arriba … 1 abajo
    upper: false,
    color: '#ffffff',
    accent: '#ffd400',
    maxWords: 4,
  },
  autoTrim: true,
  silence: 'off', // off | suave | fuerte
  zoom: 'off', // off | alterno | acercar
  transition: 'corte', // corte | fundido | flash | zoom
  format: 'auto', // auto | 9:16 | 16:9 | 1:1 | 4:5
  reframe: 0.5, // 0 = arriba, 1 = abajo (si el formato recorta)
  resolution: 1080,
  music: { assetId: null, name: '', volume: 0.25, duck: true },
  voice: { enhance: true, gate: false, volume: 1 },
  overlays: [], // { id, type: 'text'|'emoji'|'image', text, assetId, x, y, size, color, bg, start, end }
  logo: { assetId: null, corner: 'tr', size: 0.16, opacity: 0.9 },
  progress: { on: false, color: '#ff3b5c', position: 'bottom' },
  cover: { time: null, title: '', firstFrame: false },
};

/** Mezcla un objeto de edición guardado con los valores por defecto (también en profundidad). */
export function withDefaults(edit = {}) {
  const out = { ...EDIT_DEFAULTS, ...edit };
  for (const k of ['captions', 'music', 'voice', 'logo', 'progress', 'cover']) {
    out[k] = { ...EDIT_DEFAULTS[k], ...(edit[k] || {}) };
  }
  out.overlays = Array.isArray(edit.overlays) ? edit.overlays : [];
  return out;
}

// ---------------------------------------------------------------- análisis de audio

/**
 * Analiza el audio de una toma: tramos con voz, forma de onda y tiempo inicial.
 * @returns {Promise<{t0:number, duration:number, speech:number[][], wave:number[], width:number, height:number}>}
 */
export async function analyzeTake(blob) {
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const t0 = await input.getFirstTimestamp();
  const end = await input.computeDuration();
  const duration = Math.max(0.04, end - t0);
  const audio = await input.getPrimaryAudioTrack();
  const video = await input.getPrimaryVideoTrack();
  const width = video?.displayWidth || 0;
  const height = video?.displayHeight || 0;
  const WIN = 0.02; // ventanas de 20 ms
  const n = Math.ceil(duration / WIN) + 1;
  const rms = new Float32Array(n);
  if (audio && (await audio.canDecode())) {
    const sink = new mb.AudioBufferSink(audio);
    for await (const { buffer, timestamp } of sink.buffers()) {
      const ch = buffer.getChannelData(0);
      const rate = buffer.sampleRate;
      const per = Math.max(1, Math.round(rate * WIN));
      for (let i = 0; i < ch.length; i += per) {
        let sum = 0;
        const stop = Math.min(ch.length, i + per);
        for (let j = i; j < stop; j++) sum += ch[j] * ch[j];
        const idx = Math.floor((timestamp - t0 + i / rate) / WIN);
        if (idx >= 0 && idx < n) rms[idx] = Math.max(rms[idx], Math.sqrt(sum / (stop - i)));
      }
    }
  }
  // Umbral de voz relativo al ruido de fondo y al nivel de la voz.
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 0;
  const thr = Math.max(0.003, floor + (loud - floor) * 0.18);
  let speech = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    const on = rms[i] > thr;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      speech.push([start * WIN, i * WIN]);
      start = -1;
    }
  }
  if (start >= 0) speech.push([start * WIN, n * WIN]);
  // Unir huecos muy cortos (entre sílabas) y descartar chasquidos.
  const merged = [];
  for (const s of speech) {
    const last = merged[merged.length - 1];
    if (last && s[0] - last[1] < 0.22) last[1] = s[1];
    else merged.push([...s]);
  }
  speech = merged.filter(([a, b]) => b - a > 0.12).map(([a, b]) => [Math.max(0, a - 0.05), Math.min(duration, b + 0.05)]);
  // Forma de onda para la interfaz (160 columnas).
  const wave = [];
  const cols = 160;
  for (let c = 0; c < cols; c++) {
    let m = 0;
    const a = Math.floor((c / cols) * n);
    const b = Math.floor(((c + 1) / cols) * n);
    for (let i = a; i < Math.max(a + 1, b); i++) m = Math.max(m, rms[i] || 0);
    wave.push(Math.min(1, m / (loud * 1.4 || 1)));
  }
  return { t0, duration, speech, wave, width, height };
}

// ---------------------------------------------------------------- tiempos de cada palabra

/**
 * Reparte las palabras del texto sobre los tramos con voz, en proporción a su longitud.
 * Tiempos relativos al inicio de la toma (segundos).
 */
export function wordTimings(text, speech, from, to) {
  const words = tokenize(text);
  if (!words.length) return [];
  let spans = speech
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => b - a > 0.05);
  if (!spans.length) spans = [[from, to]];
  const total = spans.reduce((s, [a, b]) => s + (b - a), 0);
  // Peso: letras + un extra por pausa tras puntuación.
  const weights = words.map((w) => w.norm.length + 1.5 + (/[.,;:!?…]$/.test(w.text) ? 1.5 : 0));
  const sumW = weights.reduce((a, b) => a + b, 0);
  const toReal = (speechTime) => {
    let acc = 0;
    for (const [a, b] of spans) {
      if (speechTime <= acc + (b - a)) return a + (speechTime - acc);
      acc += b - a;
    }
    return spans[spans.length - 1][1];
  };
  const out = [];
  let accW = 0;
  for (let i = 0; i < words.length; i++) {
    const s = toReal((accW / sumW) * total);
    accW += weights[i];
    const e = toReal((accW / sumW) * total);
    out.push({ text: words[i].text, start: s, end: Math.max(e, s + 0.05) });
  }
  return out;
}

/** Agrupa palabras en frases cortas para mostrar en pantalla. */
export function chunkWords(words, maxWords) {
  const chunks = [];
  let cur = [];
  const flush = () => {
    if (cur.length) chunks.push(cur);
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = words[i - 1];
    if (cur.length && prev && w.start - prev.end > 0.6) flush();
    cur.push(w);
    if (cur.length >= maxWords || /[.!?…;:]$/.test(w.text) || (/,$/.test(w.text) && cur.length >= 2)) flush();
  }
  flush();
  return chunks.map((ws, i) => {
    const next = chunks[i + 1];
    const end = next ? Math.min(next[0].start, ws[ws.length - 1].end + 0.8) : ws[ws.length - 1].end + 0.6;
    return { words: ws, start: ws[0].start, end };
  });
}

// ---------------------------------------------------------------- línea de tiempo

const SILENCE = {
  suave: { gap: 0.55, pad: 0.16 },
  fuerte: { gap: 0.3, pad: 0.08 },
};

/**
 * @param {object} project proyecto (clips: { seg: { take, trimIn, trimOut, text } }, order)
 * @param {string[]} segments fragmentos del guion
 * @param {Map<number, object[]>} takesBySeg tomas grabadas (con .analysis)
 * @param {object} edit edición (withDefaults)
 */
export function buildTimeline(project, segments, takesBySeg, edit) {
  const order = orderOf(project, segments, takesBySeg);
  const clips = [];
  const pieces = [];
  let t = 0;
  for (const seg of order) {
    const take = selectedTake(project, seg, takesBySeg);
    if (!take?.analysis) continue;
    const a = take.analysis;
    const cfg = project.clips?.[seg] || {};
    const text = cfg.text ?? segments[seg] ?? '';
    // Recorte: manual, automático (de la primera a la última palabra) o completo.
    let from = 0;
    let to = a.duration;
    if (edit.autoTrim && a.speech.length) {
      from = Math.max(0, a.speech[0][0] - 0.15);
      to = Math.min(a.duration, a.speech[a.speech.length - 1][1] + 0.3);
    }
    if (cfg.trimIn != null) from = Math.max(0, Math.min(cfg.trimIn, a.duration - 0.1));
    if (cfg.trimOut != null) to = Math.max(from + 0.1, Math.min(cfg.trimOut, a.duration));

    // Tramos que se conservan (quitando silencios largos si se pide).
    let keep = [[from, to]];
    const sil = SILENCE[edit.silence];
    if (sil && a.speech.length) {
      keep = [];
      for (const [s, e] of a.speech) {
        const ks = Math.max(from, s - sil.pad);
        const ke = Math.min(to, e + sil.pad);
        if (ke - ks < 0.08) continue;
        const last = keep[keep.length - 1];
        if (last && ks - last[1] < sil.gap) last[1] = Math.max(last[1], ke);
        else keep.push([ks, ke]);
      }
      if (!keep.length) keep = [[from, to]];
    }

    const clip = { seg, take, text, index: clips.length, outStart: t, pieces: [], words: [], chunks: [] };
    for (const [ks, ke] of keep) {
      const piece = {
        clip,
        take,
        srcStart: ks,
        srcEnd: ke,
        outStart: t,
        outEnd: t + (ke - ks),
        index: pieces.length,
      };
      clip.pieces.push(piece);
      pieces.push(piece);
      t = piece.outEnd;
    }
    clip.outEnd = t;
    // Palabras en tiempo de salida.
    const toOut = (src) => {
      for (const p of clip.pieces) if (src >= p.srcStart - 0.01 && src <= p.srcEnd + 0.01) return p.outStart + Math.max(0, src - p.srcStart);
      return null;
    };
    for (const w of wordTimings(text, a.speech, from, to)) {
      const s = toOut(w.start);
      const e = toOut(w.end);
      if (s == null) continue;
      clip.words.push({ text: w.text, start: s, end: e ?? s + (w.end - w.start) });
    }
    clip.chunks = chunkWords(clip.words, edit.captions.style === 'grande' ? Math.min(2, edit.captions.maxWords) : edit.captions.maxWords);
    clips.push(clip);
  }
  if (clips.length) clips[clips.length - 1].last = true;
  return { clips, pieces, duration: t };
}

export function orderOf(project, segments, takesBySeg) {
  const all = new Set([...segments.keys(), ...takesBySeg.keys()]);
  const saved = (project.order || []).filter((s) => all.has(s));
  const rest = [...all].filter((s) => !saved.includes(s)).sort((a, b) => a - b);
  return [...saved, ...rest];
}

export function selectedTake(project, seg, takesBySeg) {
  const list = takesBySeg.get(seg) || [];
  const id = project.clips?.[seg]?.take;
  return list.find((t) => t.id === id) || list[list.length - 1] || null;
}

export function pieceAt(timeline, t) {
  const ps = timeline.pieces;
  let lo = 0;
  let hi = ps.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < ps[mid].outStart) hi = mid - 1;
    else if (t >= ps[mid].outEnd) lo = mid + 1;
    else return ps[mid];
  }
  return ps[Math.min(ps.length - 1, Math.max(0, lo))] || null;
}

/** Tramos con voz en tiempo de salida (para bajar la música y la puerta de ruido). */
export function speechOut(timeline) {
  const out = [];
  for (const p of timeline.pieces) {
    for (const [s, e] of p.take.analysis.speech) {
      const a = Math.max(s, p.srcStart);
      const b = Math.min(e, p.srcEnd);
      if (b > a) out.push([p.outStart + (a - p.srcStart), p.outStart + (b - p.srcStart)]);
    }
  }
  return out;
}
