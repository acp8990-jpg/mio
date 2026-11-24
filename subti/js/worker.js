// Transcripción en el propio dispositivo con Whisper (Transformers.js + ONNX Runtime Web).
// El modelo se descarga una sola vez y queda en la caché del navegador.
// El audio se procesa en ventanas de ≤30 s cortadas en silencios: así hay progreso real, el texto
// aparece mientras se transcribe y se evita el troceado interno, que estropea los tiempos por palabra.

// Versión fija de Transformers.js (licencia Apache-2.0) servida por jsDelivr; sw.js la guarda para usarla sin conexión.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

export const MODELS = {
  fast: 'onnx-community/whisper-base_timestamped',
  precise: 'onnx-community/whisper-small_timestamped',
};

const SR = 16000;
const WINDOW = 28; // segundos
let asr = null;
let loadedKey = null;

async function hasWebGPU() {
  try {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function load(quality) {
  const id = MODELS[quality] || MODELS.fast;
  const webgpu = await hasWebGPU();
  const key = `${id}|${webgpu}`;
  if (asr && loadedKey === key) return;
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      postMessage({ type: 'download', loaded, total });
    }
  };
  const opts = webgpu
    ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback }
    : { device: 'wasm', dtype: 'q8', progress_callback };
  try {
    asr = await pipeline('automatic-speech-recognition', id, opts);
  } catch (err) {
    if (!webgpu) throw err;
    // Algunas GPU fallan con WebGPU: se reintenta en CPU.
    asr = await pipeline('automatic-speech-recognition', id, { device: 'wasm', dtype: 'q8', progress_callback });
  }
  loadedKey = key;
  postMessage({ type: 'ready', device: webgpu ? 'GPU' : 'CPU' });
}

/** Corta el audio en ventanas de hasta WINDOW s, buscando el punto más silencioso cerca del final. */
function windows(audio) {
  const out = [];
  let start = 0;
  const hop = Math.round(0.02 * SR);
  while (start < audio.length) {
    let end = Math.min(audio.length, start + WINDOW * SR);
    if (end < audio.length) {
      // busca en los últimos 6 s el tramo de 20 ms con menos energía
      let best = end;
      let bestE = Infinity;
      for (let p = end - 6 * SR; p < end - hop; p += hop) {
        let e = 0;
        for (let k = p; k < p + hop; k++) e += audio[k] * audio[k];
        if (e < bestE) {
          bestE = e;
          best = p + (hop >> 1);
        }
      }
      end = best;
    }
    out.push([start, end]);
    start = end;
  }
  return out;
}

function rms(a) {
  let e = 0;
  for (let i = 0; i < a.length; i++) e += a[i] * a[i];
  return Math.sqrt(e / Math.max(1, a.length));
}

// Whisper a veces «alucina» frases típicas en silencios o música.
const HALLUCINATIONS = /^(gracias por ver( el vídeo)?|suscríbete|subtítulos (realizados )?por|amara\.org|¡?gracias!?\.?)$/i;

async function run(audio, language) {
  const wins = windows(audio);
  const total = audio.length / SR;
  const words = [];
  for (let n = 0; n < wins.length; n++) {
    const [a, b] = wins[n];
    const slice = audio.subarray(a, b);
    const offset = a / SR;
    if (rms(slice) > 0.004) {
      const res = await asr(slice, {
        return_timestamps: 'word',
        language: language === 'auto' ? undefined : language,
        task: 'transcribe',
      });
      const merged = [];
      for (const c of res.chunks || []) {
        const raw = c.text || '';
        const w = raw.trim();
        let [s, e] = c.timestamp || [];
        if (!w || s == null) continue;
        if (e == null || e < s) e = s + 0.3;
        const wd = { w, s: offset + s, e: offset + Math.min(e, (b - a) / SR) };
        // Whisper parte a veces una palabra en dos fichas («ca» + «sa»): si no hay espacio, se unen.
        if (merged.length && !/^\s/.test(raw) && !/^[¿¡"«(]/.test(w)) {
          const prev = merged[merged.length - 1];
          prev.w += wd.w;
          prev.e = wd.e;
        } else merged.push(wd);
      }
      const text = merged.map((m) => m.w).join(' ');
      if (!HALLUCINATIONS.test(text.trim())) words.push(...merged);
      postMessage({ type: 'partial', words: merged });
    }
    postMessage({ type: 'progress', done: b / SR, total });
  }
  // tiempos siempre crecientes y sin solapes
  for (let i = 1; i < words.length; i++) {
    if (words[i].s < words[i - 1].s) words[i].s = words[i - 1].s;
    if (words[i - 1].e > words[i].s) words[i - 1].e = words[i].s;
    if (words[i].e <= words[i].s) words[i].e = words[i].s + 0.08;
  }
  return words;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'transcribe') {
      await load(data.quality);
      const words = await run(data.audio, data.language);
      postMessage({ type: 'done', words });
    }
  } catch (err) {
    console.error(err);
    postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
