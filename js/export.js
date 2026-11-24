// Une los clips en un único vídeo MP4, en el propio dispositivo, con resolución elegible hasta 4K.
// 1) Ruta rápida: si los clips ya son H.264/AAC, del mismo tamaño, y se exporta en «Original»,
//    se copian los paquetes sin recodificar (instantáneo, sin pérdida).
// 2) Ruta general: decodifica, reescala (sube o baja) a la resolución pedida y recodifica a MP4.

import {
  Input,
  Output,
  BlobSource,
  BufferTarget,
  StreamTarget,
  ALL_FORMATS,
  Mp4OutputFormat,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  CanvasSink,
  CanvasSource,
  AudioBufferSink,
  AudioSample,
  AudioSampleSource,
  canEncodeVideo,
  canEncodeAudio,
  QUALITY_HIGH,
} from 'mediabunny';
import { drawFrame, outputDims, fontFor } from './render.js';
import { speechOut } from './timeline.js';

/** Resoluciones de exportación: el número es el lado corto (720p, 1080p, 2K, 4K). */
export const RESOLUTIONS = [
  { value: 'original', label: 'Original' },
  { value: 720, label: '720p (HD)' },
  { value: 1080, label: '1080p (Full HD)' },
  { value: 1440, label: '1440p (2K)' },
  { value: 2160, label: '2160p (4K)' },
];

const MP4_COPY_VIDEO = ['avc', 'hevc'];
const MP4_COPY_AUDIO = ['aac'];

async function describe(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error('Uno de los clips no contiene vídeo.');
  const audio = await input.getPrimaryAudioTrack();
  const start = await input.getFirstTimestamp();
  const end = await input.computeDuration();
  return {
    input,
    video,
    audio,
    start,
    duration: Math.max(0.04, end - start),
    vConfig: await video.getDecoderConfig(),
    aConfig: audio ? await audio.getDecoderConfig() : null,
    rotation: await video.getRotation(),
  };
}

function sameBytes(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const x = ArrayBuffer.isView(a) ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(a);
  const y = ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function canCopy(clips) {
  const f = clips[0];
  if (!f.vConfig || !MP4_COPY_VIDEO.includes(f.video.codec)) return false;
  if (f.audio && (!f.aConfig || !MP4_COPY_AUDIO.includes(f.audio.codec))) return false;
  return clips.every(
    (c) =>
      c.video.codec === f.video.codec &&
      c.video.codedWidth === f.video.codedWidth &&
      c.video.codedHeight === f.video.codedHeight &&
      c.rotation === f.rotation &&
      sameBytes(c.vConfig?.description, f.vConfig.description) &&
      !!c.audio === !!f.audio &&
      (!f.audio ||
        (c.audio.codec === f.audio.codec &&
          c.audio.sampleRate === f.audio.sampleRate &&
          c.audio.numberOfChannels === f.audio.numberOfChannels &&
          sameBytes(c.aConfig?.description, f.aConfig.description))),
  );
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

const STANDARD_ASPECTS = [[9, 16], [16, 9], [1, 1], [3, 4], [4, 3], [4, 5]];
const near = (a, b) => Math.abs(a - b) / b < 0.03;

/**
 * Tamaño de salida: el lado corto es la resolución pedida. Si la proporción es casi estándar
 * (9:16, 16:9, 1:1…), se ajusta a la exacta: 4K vertical = 2160×3840.
 */
export function targetSize(srcW, srcH, resolution) {
  if (resolution === 'original' || !resolution) return { width: even(srcW), height: even(srcH) };
  const aspect = srcW / srcH;
  const std = STANDARD_ASPECTS.find(([a, b]) => near(aspect, a / b));
  if (std) {
    const [a, b] = std;
    return a <= b
      ? { width: even(resolution), height: even((resolution * b) / a) }
      : { width: even((resolution * a) / b), height: even(resolution) };
  }
  const scale = resolution / Math.min(srcW, srcH);
  return { width: even(srcW * scale), height: even(srcH * scale) };
}

// ---------------------------------------------------------------- destino

/**
 * Escribe en el almacenamiento privado del navegador (OPFS) si está disponible, para que un 4K largo
 * no tenga que caber en la memoria del móvil. Si no, se usa memoria.
 */
async function createTarget() {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (root && typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype) {
      for await (const name of root.keys()) {
        if (name.startsWith('teleclip-export-')) await root.removeEntry(name).catch(() => {});
      }
      const handle = await root.getFileHandle(`teleclip-export-${Date.now()}.mp4`, { create: true });
      const writable = await handle.createWritable();
      return {
        target: new StreamTarget(writable, { chunked: true }),
        fastStart: false,
        result: () => handle.getFile(),
      };
    }
  } catch (err) {
    console.warn('OPFS no disponible, exporto en memoria', err);
  }
  const target = new BufferTarget();
  return {
    target,
    fastStart: 'in-memory',
    result: async () => new Blob([target.buffer], { type: 'video/mp4' }),
  };
}

async function done(dest, mode, width, height) {
  const file = await dest.result();
  return {
    blob: file.type === 'video/mp4' ? file : new Blob([file], { type: 'video/mp4' }),
    mime: 'video/mp4',
    ext: 'mp4',
    mode,
    width,
    height,
  };
}

// ---------------------------------------------------------------- ruta rápida

async function collect(track) {
  const packets = [];
  for await (const p of new EncodedPacketSink(track).packets()) packets.push(p);
  return packets;
}

async function copyJoin(clips, onProgress) {
  const first = clips[0];
  const dest = await createTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: dest.fastStart }), target: dest.target });
  const vSource = new EncodedVideoPacketSource(first.video.codec);
  output.addVideoTrack(vSource, { rotation: first.rotation });
  let aSource = null;
  if (first.audio) {
    aSource = new EncodedAudioPacketSource(first.audio.codec);
    output.addAudioTrack(aSource);
  }
  await output.start();

  const total = clips.reduce((s, c) => s + c.duration, 0);
  let offset = 0;
  let firstVideo = true;
  let firstAudio = true;
  for (const clip of clips) {
    const vp = await collect(clip.video);
    const ap = clip.audio ? await collect(clip.audio) : [];
    let i = 0;
    let j = 0;
    // Intercalamos audio y vídeo por marca de tiempo, respetando el orden de cada pista.
    while (i < vp.length || j < ap.length) {
      const takeAudio = j < ap.length && (i >= vp.length || ap[j].timestamp < vp[i].timestamp);
      const p = takeAudio ? ap[j++] : vp[i++];
      const shifted = p.clone({ timestamp: Math.max(0, p.timestamp - clip.start + offset) });
      if (takeAudio) {
        await aSource.add(shifted, firstAudio ? { decoderConfig: first.aConfig } : undefined);
        firstAudio = false;
      } else {
        await vSource.add(shifted, firstVideo ? { decoderConfig: first.vConfig } : undefined);
        firstVideo = false;
        onProgress?.(Math.min(1, (shifted.timestamp + 0.001) / total));
      }
    }
    offset += clip.duration;
  }
  await output.finalize();
  return done(dest, 'copia directa', even(first.video.displayWidth), even(first.video.displayHeight));
}

// ---------------------------------------------------------------- ruta general (reescalado)

/** Convierte un AudioBuffer al número de canales y frecuencia indicados. */
async function conform(buffer, channels, rate) {
  if (buffer.numberOfChannels === channels && buffer.sampleRate === rate) return buffer;
  const length = Math.max(1, Math.round(buffer.duration * rate));
  const ctx = new OfflineAudioContext(channels, length, rate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

let aacReady = null;
/** Garantiza AAC: si el navegador no lo codifica (Firefox, algunos Chrome), registra el codificador WASM. */
function ensureAac() {
  aacReady ??= (async () => {
    if (await canEncodeAudio('aac')) return true;
    const { registerAacEncoder } = await import('../vendor/mediabunny-aac-encoder.min.mjs');
    registerAacEncoder();
    return canEncodeAudio('aac');
  })().catch((err) => {
    console.warn('Sin codificador AAC', err);
    return false;
  });
  return aacReady;
}

async function pickVideoCodec(width, height, bitrate) {
  // H.264 primero: es el MP4 que aceptan todas las redes y editores.
  for (const codec of ['avc', 'hevc', 'vp9', 'av1']) {
    if (await canEncodeVideo(codec, { width, height, bitrate })) return codec;
  }
  throw new Error(`Este dispositivo no puede codificar vídeo a ${width}×${height}. Prueba con una resolución menor.`);
}

async function reencodeJoin(clips, resolution, onProgress) {
  const first = clips[0];
  const { width, height } = targetSize(first.video.displayWidth, first.video.displayHeight, resolution);
  // ≈0,15 bits por píxel a 30 fps: ~9 Mbps en 1080p, ~37 Mbps en 4K.
  const bitrate = Math.round(width * height * 30 * 0.15);
  const vCodec = await pickVideoCodec(width, height, bitrate);
  const audioClips = clips.filter((c) => c.audio);
  let aCodec = null;
  if (audioClips.length) {
    if (await ensureAac()) aCodec = 'aac';
    else if (await canEncodeAudio('opus')) aCodec = 'opus';
  }

  const dest = await createTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: dest.fastStart }), target: dest.target });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const vSource = new CanvasSource(canvas, { codec: vCodec, bitrate, keyFrameInterval: 2 });
  output.addVideoTrack(vSource);
  let aSource = null;
  if (aCodec) {
    aSource = new AudioSampleSource({ codec: aCodec, bitrate: QUALITY_HIGH });
    output.addAudioTrack(aSource);
  }
  await output.start();

  // Todo el audio sale con el mismo formato aunque los clips difieran (mono/estéreo, 44,1/48 kHz).
  const outRate = aCodec === 'opus' ? 48000 : audioClips[0]?.audio.sampleRate || 48000;
  const outChannels = Math.min(2, Math.max(1, ...audioClips.map((c) => c.audio.numberOfChannels)));

  const total = clips.reduce((s, c) => s + c.duration, 0);
  let offset = 0;
  let lastTs = -1;
  for (const clip of clips) {
    const videoJob = (async () => {
      // Frames a su tamaño original (ya rotados) y reescalado de alta calidad al tamaño final.
      const sink = new CanvasSink(clip.video, { poolSize: 2 });
      for await (const frame of sink.canvases()) {
        const src = frame.canvas;
        // Misma proporción (±3 %): llena el cuadro. Distinta: encaja con bandas negras sin recortar.
        const fill = near(src.width / src.height, width / height);
        const scale = (fill ? Math.max : Math.min)(width / src.width, height / src.height);
        const dw = src.width * scale;
        const dh = src.height * scale;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(src, (width - dw) / 2, (height - dh) / 2, dw, dh);
        // Las marcas de tiempo deben crecer siempre, también en el empalme entre clips.
        const ts = Math.max(0, lastTs + 1 / 240, frame.timestamp - clip.start + offset);
        lastTs = ts;
        await vSource.add(ts, frame.duration || 1 / 30);
        onProgress?.(Math.min(1, ts / total));
      }
    })();
    const audioJob = (async () => {
      if (!aSource || !clip.audio) return;
      for await (const { buffer, timestamp } of new AudioBufferSink(clip.audio).buffers()) {
        const normalized = await conform(buffer, outChannels, outRate);
        const ts = Math.max(0, timestamp - clip.start + offset);
        for (const sample of AudioSample.fromAudioBuffer(normalized, ts)) {
          await aSource.add(sample);
          sample.close();
        }
      }
    })();
    await Promise.all([videoJob, audioJob]);
    offset += clip.duration;
  }
  await output.finalize();
  const label = { avc: 'H.264', hevc: 'H.265', vp9: 'VP9', av1: 'AV1' }[vCodec];
  return done(dest, `${label}${aCodec ? ' + ' + aCodec.toUpperCase() : ''}`, width, height);
}

/**
 * @param {Blob[]} blobs clips en orden
 * @param {{ resolution?: 'original'|720|1080|1440|2160, onProgress?: (p:number)=>void }} options
 * @returns {Promise<{blob: Blob, mime: string, ext: string, mode: string, width: number, height: number}>}
 */
export async function joinClips(blobs, { resolution = 'original', onProgress } = {}) {
  if (!blobs.length) throw new Error('No hay clips que unir.');
  const clips = [];
  for (const b of blobs) clips.push(await describe(b));

  const f = clips[0].video;
  const size = targetSize(f.displayWidth, f.displayHeight, resolution);
  const sameSize = resolution === 'original' ||
    (size.width === even(f.displayWidth) && size.height === even(f.displayHeight));
  if (sameSize && canCopy(clips)) {
    try {
      return await copyJoin(clips, onProgress);
    } catch (err) {
      console.warn('Copia directa fallida, recodificando…', err);
    }
  }
  onProgress?.(0);
  return reencodeJoin(clips, resolution, onProgress);
}

// ================================================================ exportación con edición

/** ¿La edición no cambia nada respecto a unir los clips tal cual? (permite la copia directa) */
export function isPlainEdit(edit, project) {
  const clipsTouched = Object.values(project.clips || {}).some((c) => c.trimIn != null || c.trimOut != null);
  return (
    !edit.captions.on && !edit.autoTrim && edit.silence === 'off' && edit.zoom === 'off' &&
    edit.transition === 'corte' && edit.format === 'auto' && !edit.overlays.length && !edit.logo.assetId &&
    !edit.progress.on && !edit.music.assetId && !edit.voice.enhance && !edit.voice.gate &&
    edit.voice.volume === 1 && !edit.cover.firstFrame && !clipsTouched
  );
}

async function openTake(cache, take) {
  if (!cache.has(take.id)) {
    const input = new Input({ source: new BlobSource(take.blob), formats: ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    cache.set(take.id, { input, video, audio, t0: take.analysis?.t0 ?? (await input.getFirstTimestamp()) });
  }
  return cache.get(take.id);
}

/** Fotograma de una toma en un instante (relativo al inicio de la toma), como canvas. */
export async function frameAt(take, rel, cache = new Map()) {
  const inp = await openTake(cache, take);
  const sink = new CanvasSink(inp.video, { poolSize: 1 });
  const w = await sink.getCanvas(inp.t0 + Math.max(0, rel));
  return w?.canvas ?? null;
}

/** Dibuja la portada: el fotograma elegido con su título (si lo hay). */
export async function renderCover(ctx, W, H, { timeline, edit, images, cache }) {
  const t = Math.min(edit.cover.time ?? 0, Math.max(0, timeline.duration - 0.05));
  const piece = timeline.pieces.find((p) => t >= p.outStart && t < p.outEnd) || timeline.pieces[0];
  const rel = piece.srcStart + (t - piece.outStart);
  const src = await frameAt(piece.take, rel, cache);
  drawFrame(ctx, W, H, {
    source: src, srcW: src?.width, srcH: src?.height, t, piece, timeline,
    edit: { ...edit, captions: { ...edit.captions, on: !edit.cover.title && edit.captions.on }, transition: 'corte' },
    images,
  });
  const title = edit.cover.title?.trim();
  if (title) {
    const unit = Math.min(W, H);
    const px = Math.round(unit * 0.1);
    ctx.save();
    ctx.font = fontFor(edit.captions.font, px);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    // Partir el título en líneas.
    const words = title.toLocaleUpperCase('es').split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > W * 0.86 && line) {
        lines.push(line);
        line = w;
      } else line = test;
    }
    lines.push(line);
    const lh = px * 1.15;
    lines.forEach((l, i) => {
      const y = H * 0.5 + (i - (lines.length - 1) / 2) * lh;
      ctx.lineWidth = px * 0.22;
      ctx.strokeStyle = 'rgba(0,0,0,.9)';
      ctx.strokeText(l, W / 2, y);
      ctx.fillStyle = i % 2 ? edit.captions.accent : '#fff';
      ctx.fillText(l, W / 2, y);
    });
    ctx.restore();
  }
}

/** Mezcla todo el audio final: voz (con mejora y puerta de ruido) + música (con atenuación al hablar). */
async function renderAudio({ timeline, edit, musicBlob, lead, cache }) {
  const rate = 48000;
  const total = timeline.duration + lead;
  const ac = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * rate)), rate);
  const speech = speechOut(timeline).map(([a, b]) => [a + lead, b + lead]);

  // Cadena de voz
  const voiceIn = ac.createGain();
  voiceIn.gain.value = edit.voice.volume;
  let tail = voiceIn;
  const chain = (node) => {
    tail.connect(node);
    tail = node;
  };
  if (edit.voice.enhance) {
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 85;
    chain(hp);
    const mud = ac.createBiquadFilter();
    mud.type = 'peaking';
    mud.frequency.value = 300;
    mud.Q.value = 1;
    mud.gain.value = -2.5;
    chain(mud);
    const presence = ac.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 3200;
    presence.Q.value = 0.9;
    presence.gain.value = 3;
    chain(presence);
    const air = ac.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = 9000;
    air.gain.value = 2;
    chain(air);
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -26;
    comp.knee.value = 6;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.005;
    comp.release.value = 0.18;
    chain(comp);
    const makeup = ac.createGain();
    makeup.gain.value = 1.5;
    chain(makeup);
  }
  if (edit.voice.gate) {
    // Puerta de ruido: baja el fondo cuando no hablas.
    const gate = ac.createGain();
    const low = 0.18;
    gate.gain.setValueAtTime(low, 0);
    for (const [a, b] of speech) {
      gate.gain.setTargetAtTime(1, Math.max(0, a - 0.04), 0.012);
      gate.gain.setTargetAtTime(low, b + 0.08, 0.08);
    }
    chain(gate);
  }
  tail.connect(ac.destination);

  for (const piece of timeline.pieces) {
    const inp = await openTake(cache, piece.take);
    if (!inp.audio || !(await inp.audio.canDecode())) continue;
    const g = ac.createGain();
    const ps = lead + piece.outStart;
    const pe = lead + piece.outEnd;
    const fade = Math.min(0.01, (pe - ps) / 4);
    g.gain.setValueAtTime(0, ps);
    g.gain.linearRampToValueAtTime(1, ps + fade);
    g.gain.setValueAtTime(1, pe - fade);
    g.gain.linearRampToValueAtTime(0, pe);
    g.connect(voiceIn);
    const sink = new AudioBufferSink(inp.audio);
    for await (const { buffer, timestamp } of sink.buffers(inp.t0 + piece.srcStart, inp.t0 + piece.srcEnd)) {
      const rel = timestamp - inp.t0;
      const offset = Math.max(0, piece.srcStart - rel);
      const dur = Math.min(buffer.duration - offset, piece.srcEnd - (rel + offset));
      if (dur <= 0) continue;
      const src = ac.createBufferSource();
      src.buffer = buffer;
      src.connect(g);
      src.start(ps + (rel + offset - piece.srcStart), offset, dur);
    }
  }

  if (musicBlob) {
    const music = await ac.decodeAudioData(await musicBlob.arrayBuffer());
    const src = ac.createBufferSource();
    src.buffer = music;
    src.loop = true;
    const vol = ac.createGain();
    const base = edit.music.volume;
    vol.gain.setValueAtTime(base, 0);
    if (edit.music.duck) {
      // Atenuación: baja la música mientras hablas.
      const merged = [];
      for (const [a, b] of speech) {
        const last = merged[merged.length - 1];
        if (last && a - last[1] < 0.5) last[1] = b;
        else merged.push([a, b]);
      }
      for (const [a, b] of merged) {
        vol.gain.setTargetAtTime(base * 0.3, Math.max(0, a - 0.15), 0.07);
        vol.gain.setTargetAtTime(base, b + 0.2, 0.3);
      }
    }
    const fadeOut = ac.createGain();
    const fo = Math.min(1.5, total / 3);
    fadeOut.gain.setValueAtTime(1, Math.max(0, total - fo));
    fadeOut.gain.linearRampToValueAtTime(0, total);
    src.connect(vol);
    vol.connect(fadeOut);
    fadeOut.connect(ac.destination);
    src.start(0);
    src.stop(total);
  }
  return ac.startRendering();
}

/**
 * Exporta el vídeo final con toda la edición a MP4.
 * @param {{timeline, edit, images: Map, musicBlob: Blob|null, onProgress?: (p:number, stage:string)=>void}} o
 */
export async function exportEdited({ timeline, edit, images, musicBlob, onProgress }) {
  if (!timeline.pieces.length) throw new Error('No hay clips que exportar.');
  const cache = new Map();
  const first = await openTake(cache, timeline.pieces[0].take);
  const { width, height } = outputDims(first.video.displayWidth, first.video.displayHeight, edit.format, edit.resolution);
  const bitrate = Math.round(width * height * 30 * 0.15);
  const vCodec = await pickVideoCodec(width, height, bitrate);
  const aCodec = (await ensureAac()) ? 'aac' : (await canEncodeAudio('opus')) ? 'opus' : null;
  const lead = edit.cover.firstFrame ? 0.25 : 0;

  onProgress?.(0, 'audio');
  const audioBuffer = aCodec ? await renderAudio({ timeline, edit, musicBlob, lead, cache }) : null;

  const dest = await createTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: dest.fastStart }), target: dest.target });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  const vSource = new CanvasSource(canvas, { codec: vCodec, bitrate, keyFrameInterval: 2 });
  output.addVideoTrack(vSource);
  let aSource = null;
  if (audioBuffer) {
    aSource = new AudioSampleSource({ codec: aCodec, bitrate: 192_000 });
    output.addAudioTrack(aSource);
  }
  await output.start();

  const total = timeline.duration + lead;
  const audioJob = (async () => {
    if (!aSource) return;
    for (const sample of AudioSample.fromAudioBuffer(audioBuffer, 0)) {
      await aSource.add(sample);
      sample.close();
    }
  })();

  const videoJob = (async () => {
    let lastTs = -1;
    if (lead) {
      await renderCover(ctx, width, height, { timeline, edit, images, cache });
      await vSource.add(0, lead);
      lastTs = 0;
    }
    for (const piece of timeline.pieces) {
      const inp = await openTake(cache, piece.take);
      const sink = new CanvasSink(inp.video, { poolSize: 2 });
      for await (const frame of sink.canvases(inp.t0 + piece.srcStart, inp.t0 + piece.srcEnd)) {
        const rel = frame.timestamp - inp.t0;
        const tOut = piece.outStart + Math.max(0, rel - piece.srcStart);
        if (tOut >= piece.outEnd) break;
        drawFrame(ctx, width, height, {
          source: frame.canvas, srcW: frame.canvas.width, srcH: frame.canvas.height,
          t: tOut, piece, timeline, edit, images,
        });
        const ts = Math.max(lastTs + 1 / 240, lead + tOut);
        lastTs = ts;
        await vSource.add(ts, Math.min(frame.duration || 1 / 30, 0.1));
        onProgress?.(Math.min(1, ts / total), 'video');
      }
    }
  })();

  await Promise.all([videoJob, audioJob]);
  await output.finalize();
  const label = { avc: 'H.264', hevc: 'H.265', vp9: 'VP9', av1: 'AV1' }[vCodec];
  return done(dest, `${label}${aCodec ? ' + ' + aCodec.toUpperCase() : ''}`, width, height);
}
