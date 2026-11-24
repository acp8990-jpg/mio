// Exporta el vídeo con los subtítulos «quemados» (y la marca de agua en la versión gratuita),
// en el propio dispositivo: decodifica cada fotograma, dibuja encima y recodifica a MP4.
// El audio se copia tal cual si ya es AAC/Opus; si no, se recodifica.

import {
  Input,
  Output,
  BlobSource,
  BufferTarget,
  StreamTarget,
  ALL_FORMATS,
  Mp4OutputFormat,
  CanvasSink,
  CanvasSource,
  EncodedPacketSink,
  EncodedAudioPacketSource,
  AudioBufferSink,
  AudioSample,
  AudioSampleSource,
  canEncodeVideo,
  canEncodeAudio,
  QUALITY_HIGH,
} from 'mediabunny';
import { drawCaptions, drawWatermark } from './captions.js';

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export async function probe(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error('Este archivo no tiene vídeo.');
  return {
    width: video.displayWidth,
    height: video.displayHeight,
    duration: await input.computeDuration(),
  };
}

/** Tamaño final: el lado corto es `short` (o el original si es más pequeño y no es Pro). */
export function outputSize(w, h, short) {
  if (!short) return { width: even(w), height: even(h) };
  const k = short / Math.min(w, h);
  return { width: even(w * k), height: even(h * k) };
}

async function createTarget() {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (root && typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype) {
      for await (const name of root.keys()) if (name.startsWith('subti-')) await root.removeEntry(name).catch(() => {});
      const handle = await root.getFileHandle(`subti-${Date.now()}.mp4`, { create: true });
      const writable = await handle.createWritable();
      return { target: new StreamTarget(writable, { chunked: true }), fastStart: false, result: () => handle.getFile() };
    }
  } catch (err) {
    console.warn('OPFS no disponible', err);
  }
  const target = new BufferTarget();
  return { target, fastStart: 'in-memory', result: async () => new Blob([target.buffer], { type: 'video/mp4' }) };
}

let aacReady = null;
function ensureAac() {
  aacReady ??= (async () => {
    if (await canEncodeAudio('aac')) return true;
    const { registerAacEncoder } = await import('../../vendor/mediabunny-aac-encoder.min.mjs');
    registerAacEncoder();
    return canEncodeAudio('aac');
  })().catch(() => false);
  return aacReady;
}

/**
 * @param {File|Blob} file
 * @param {{pages:any[], settings:object, watermark:boolean, short?:number, onProgress?:(p:number)=>void, signal?:AbortSignal}} o
 */
export async function exportVideo(file, { pages, settings, watermark, short, onProgress, signal }) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  const start = await input.getFirstTimestamp();
  const duration = (await input.computeDuration()) - start;
  const { width, height } = outputSize(video.displayWidth, video.displayHeight, short);

  const fps = Math.min(60, Math.max(24, Math.round((await video.computePacketStats(120)).averagePacketRate || 30)));
  const bitrate = Math.round(width * height * fps * 0.14);
  let vCodec = null;
  for (const c of ['avc', 'hevc', 'vp9', 'av1']) {
    if (await canEncodeVideo(c, { width, height, bitrate })) {
      vCodec = c;
      break;
    }
  }
  if (!vCodec) throw new Error(`Este dispositivo no puede codificar vídeo a ${width}×${height}. Prueba una resolución menor.`);

  const dest = await createTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: dest.fastStart }), target: dest.target });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  const vSource = new CanvasSource(canvas, { codec: vCodec, bitrate, keyFrameInterval: 2 });
  output.addVideoTrack(vSource, { frameRate: fps });

  // Audio: copia directa si el códec vale para MP4; si no, recodificar.
  let aCopy = null;
  let aEncode = null;
  if (audio) {
    if (['aac', 'opus', 'mp3'].includes(audio.codec)) {
      aCopy = new EncodedAudioPacketSource(audio.codec);
      output.addAudioTrack(aCopy);
    } else {
      const codec = (await ensureAac()) ? 'aac' : (await canEncodeAudio('opus')) ? 'opus' : null;
      if (codec) {
        aEncode = new AudioSampleSource({ codec, bitrate: QUALITY_HIGH });
        output.addAudioTrack(aEncode);
      }
    }
  }
  await output.start();

  const videoJob = (async () => {
    const sink = new CanvasSink(video, { width, height, fit: 'cover', poolSize: 2 });
    let last = -1;
    for await (const frame of sink.canvases()) {
      if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
      const t = frame.timestamp - start;
      ctx.drawImage(frame.canvas, 0, 0, width, height);
      drawCaptions(ctx, width, height, t, pages, settings);
      if (watermark) drawWatermark(ctx, width, height);
      const ts = Math.max(0, last + 1 / 240, t);
      last = ts;
      await vSource.add(ts, frame.duration || 1 / fps);
      onProgress?.(Math.min(0.999, ts / duration));
    }
  })();

  const audioJob = (async () => {
    if (aCopy) {
      const cfg = await audio.getDecoderConfig();
      let firstPacket = true;
      for await (const p of new EncodedPacketSink(audio).packets()) {
        if (signal?.aborted) return;
        const shifted = p.clone({ timestamp: Math.max(0, p.timestamp - start) });
        await aCopy.add(shifted, firstPacket ? { decoderConfig: cfg } : undefined);
        firstPacket = false;
      }
    } else if (aEncode) {
      for await (const { buffer, timestamp } of new AudioBufferSink(audio).buffers()) {
        if (signal?.aborted) return;
        for (const s of AudioSample.fromAudioBuffer(buffer, Math.max(0, timestamp - start))) {
          await aEncode.add(s);
          s.close();
        }
      }
    }
  })();

  try {
    await Promise.all([videoJob, audioJob]);
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  }
  await output.finalize();
  onProgress?.(1);
  const f = await dest.result();
  return { blob: f.type === 'video/mp4' ? f : new Blob([f], { type: 'video/mp4' }), width, height };
}

/** Miniatura (dataURL JPEG) del fotograma en el segundo t. */
export async function thumbnail(file, t = 0.5, size = 360) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  const k = size / Math.max(video.displayWidth, video.displayHeight);
  const sink = new CanvasSink(video, { width: even(video.displayWidth * k), height: even(video.displayHeight * k), fit: 'fill' });
  const start = await input.getFirstTimestamp();
  const frame = await sink.getCanvas(start + t);
  if (!frame) return null;
  const c = frame.canvas;
  if (c.convertToBlob) {
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    return blob;
  }
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
}
