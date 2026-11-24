// Saca el audio del vídeo (16 kHz, mono) y lo manda al worker de Whisper.

import { Input, BlobSource, ALL_FORMATS, AudioBufferSink } from 'mediabunny';

const SR = 16000;

/** Devuelve el audio del archivo como Float32Array a 16 kHz mono, o null si no tiene audio. */
export async function extractAudio(file, onProgress) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) return null;
  const duration = await input.computeDuration();
  const first = await input.getFirstTimestamp();
  const out = new Float32Array(Math.ceil((duration - Math.min(0, first) + 1) * SR));
  let written = 0;
  // Se remuestrea por bloques para no tener todo el audio original en memoria a la vez.
  let pending = [];
  let pendingLen = 0;
  let pendingRate = 0;
  let pendingStart = 0;
  const flush = async () => {
    if (!pendingLen) return;
    const mono = new Float32Array(pendingLen);
    let o = 0;
    for (const buf of pending) {
      const ch = buf.numberOfChannels;
      const data = [];
      for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
      for (let i = 0; i < buf.length; i++) {
        let v = 0;
        for (let c = 0; c < ch; c++) v += data[c][i];
        mono[o++] = v / ch;
      }
    }
    const len = Math.max(1, Math.round((pendingLen / pendingRate) * SR));
    const ctx = new OfflineAudioContext(1, len, SR);
    const src = ctx.createBuffer(1, pendingLen, pendingRate);
    src.copyToChannel(mono, 0);
    const node = ctx.createBufferSource();
    node.buffer = src;
    node.connect(ctx.destination);
    node.start();
    const res = (await ctx.startRendering()).getChannelData(0);
    const at = Math.max(0, Math.round((pendingStart - first) * SR));
    const n = Math.min(res.length, out.length - at);
    if (n > 0) out.set(res.subarray(0, n), at);
    written = Math.max(written, at + Math.max(0, n));
    pending = [];
    pendingLen = 0;
  };
  for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
    if (!pendingLen) {
      pendingRate = buffer.sampleRate;
      pendingStart = timestamp;
    }
    pending.push(buffer);
    pendingLen += buffer.length;
    if (pendingLen > pendingRate * 20) {
      await flush();
      onProgress?.(Math.min(1, (timestamp - first) / duration));
    }
  }
  await flush();
  onProgress?.(1);
  return out.subarray(0, written);
}

let worker = null;

/** Para la transcripción en curso (descarta el worker; el modelo sigue en la caché). */
export function cancelTranscription() {
  worker?.terminate();
  worker = null;
}

function getWorker() {
  worker ??= new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  return worker;
}

/**
 * @param {Float32Array} audio
 * @param {{language:string, quality:'fast'|'precise', onEvent:(e:object)=>void}} opts
 * @returns {Promise<Array<{w:string,s:number,e:number}>>}
 */
export function transcribe(audio, { language = 'es', quality = 'fast', onEvent } = {}) {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    w.onmessage = ({ data }) => {
      if (data.type === 'done') resolve(data.words);
      else if (data.type === 'error') reject(new Error(data.message));
      else onEvent?.(data);
    };
    w.onerror = (e) => reject(new Error(e.message || 'Error en el transcriptor'));
    const copy = audio.slice();
    w.postMessage({ type: 'transcribe', audio: copy, language, quality }, [copy.buffer]);
  });
}
