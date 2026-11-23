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
  // ≈0,1 bits por píxel a 30 fps: ~6 Mbps en 1080p, ~25 Mbps en 4K.
  const bitrate = Math.round(width * height * 30 * 0.1);
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
