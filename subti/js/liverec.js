// Grabación con efectos sin tirones: en vez de MediaRecorder sobre el canvas (que copia cada fotograma de la
// GPU a la memoria y codifica como puede), los fotogramas del canvas van directos al codificador de vídeo
// del móvil (WebCodecs) y se empaquetan en MP4 con Mediabunny. El audio del micrófono se codifica aparte,
// sincronizado con el vídeo. Los vídeos largos se escriben en el almacenamiento privado del navegador.

import {
  Output, Mp4OutputFormat, BufferTarget, StreamTarget, CanvasSource, MediaStreamAudioTrackSource,
  canEncodeVideo, canEncodeAudio,
} from 'mediabunny';

/** ¿Se puede grabar así en este navegador, a este tamaño? */
export async function liveSupported(width, height, bitrate) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return false;
  try {
    return await canEncodeVideo('avc', { width, height, bitrate });
  } catch {
    return false;
  }
}

let aacReady = null;
async function audioCodec() {
  aacReady ??= (async () => {
    if (await canEncodeAudio('aac')) return 'aac';
    try {
      const { registerAacEncoder } = await import('../../vendor/mediabunny-aac-encoder.min.mjs');
      registerAacEncoder();
      if (await canEncodeAudio('aac')) return 'aac';
    } catch (err) {
      console.warn('Sin codificador AAC', err);
    }
    return (await canEncodeAudio('opus')) ? 'opus' : null;
  })();
  return aacReady;
}

async function target() {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (root && typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype) {
      const handle = await root.getFileHandle(`take-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp4`, { create: true });
      const writable = await handle.createWritable();
      return { target: new StreamTarget(writable, { chunked: true }), fastStart: false, result: () => handle.getFile(), handle };
    }
  } catch (err) {
    console.warn('OPFS no disponible: grabo en memoria', err);
  }
  const t = new BufferTarget();
  return { target: t, fastStart: 'in-memory', result: async () => new Blob([t.buffer], { type: 'video/mp4' }) };
}

/** Borra las tomas de sesiones anteriores guardadas en el almacenamiento privado. */
export async function clearOldTakes(keep = new Set()) {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return;
    for await (const name of root.keys()) if (name.startsWith('take-') && !keep.has(name)) await root.removeEntry(name).catch(() => {});
  } catch {
    /* sin OPFS */
  }
}

/**
 * Empieza a grabar el canvas. Hay que llamar a `frame()` justo después de dibujar cada fotograma.
 * Si el codificador va atrasado, ese fotograma se salta (mejor eso que acumular retraso y tirones).
 * Devuelve { frame(), stop(): Promise<Blob>, cancel(), failed: Promise<Error>, stats }.
 * @param {{canvas: HTMLCanvasElement, audioTrack?: MediaStreamTrack, fps: number, bitrate: number, audioBitrate: number}} o
 */
export async function startLive({ canvas, audioTrack, fps, bitrate, audioBitrate }) {
  const dest = await target();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: dest.fastStart }), target: dest.target });
  // El navegador elige el codificador por hardware cuando lo hay.
  const video = new CanvasSource(canvas, { codec: 'avc', bitrate, keyFrameInterval: 2, latencyMode: 'realtime' });
  output.addVideoTrack(video, { frameRate: fps });
  let audio = null;
  const aCodec = audioTrack ? await audioCodec() : null;
  if (aCodec) {
    audio = new MediaStreamAudioTrackSource(audioTrack, { codec: aCodec, bitrate: audioBitrate });
    output.addAudioTrack(audio);
  }
  let reject;
  const failed = new Promise((_, r) => (reject = r));
  failed.catch(() => {});
  audio?.errorPromise.catch((e) => reject(e));
  await output.start();
  const t0 = performance.now();
  const stats = { frames: 0, dropped: 0 };
  let busy = false;
  let last = -1;
  let closed = false;
  const minGap = 1 / (fps * 1.15);
  return {
    failed,
    stats,
    /** @param {number} [when] momento de captura del fotograma (reloj de performance.now) */
    frame(when) {
      if (closed) return;
      const now = performance.now();
      const at = typeof when === 'number' && Math.abs(now - when) < 500 ? when : now;
      const ts = (at - t0) / 1000;
      if (ts <= last) return;
      if (ts - last < minGap) return; // la cámara da más fotogramas de los pedidos
      if (busy) {
        stats.dropped++;
        return;
      }
      busy = true;
      last = ts;
      stats.frames++;
      video.add(ts, 1 / fps).then(() => (busy = false), (err) => {
        busy = false;
        reject(err);
      });
    },
    async stop() {
      closed = true;
      await Promise.race([output.finalize(), failed]);
      const f = await dest.result();
      return f.type === 'video/mp4' ? f : new Blob([f], { type: 'video/mp4' });
    },
    async cancel() {
      closed = true;
      await output.cancel().catch(() => {});
    },
  };
}
