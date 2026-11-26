// Separación persona / fondo con MediaPipe (modelo «selfie segmenter», se ejecuta en el móvil).
// Va en un hilo aparte (Web Worker) para que el dibujo y la grabación no den tirones; si el navegador
// no lo permite, se usa el hilo principal a menor frecuencia.
// El modelo se descarga solo la primera vez que se activa (~15 MB) y queda en caché.

const BASE = new URL('../vendor/mediapipe/', import.meta.url).href;
const INPUT = 256; // lado del modelo: no hace falta mandarle más píxeles

let mainLoading = null;
function loadMainThread() {
  mainLoading ??= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import('../vendor/mediapipe/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks(BASE);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: `${BASE}selfie_segmenter.tflite`, delegate },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
    try {
      return await ImageSegmenter.createFromOptions(fileset, options('GPU'));
    } catch {
      return ImageSegmenter.createFromOptions(fileset, options('CPU'));
    }
  })();
  mainLoading.catch(() => (mainLoading = null));
  return mainLoading;
}

/** Máscara de la persona (0 = fondo, 255 = persona), actualizada desde el vídeo de la cámara. */
export class PersonMask {
  constructor() {
    this.worker = null;
    this.segmenter = null; // modo hilo principal
    this.data = null;
    this.width = 0;
    this.height = 0;
    this.version = 0;
    this.inFlight = false;
    this.lastRun = 0;
    this.lastTs = 0;
    this.mode = null; // 'worker' | 'main'
    this.interval = 0; // ms entre siluetas (para el medidor)
    this.ms = 0; // ms que tarda cada silueta (media)
    this.sentAt = 0;
    this.lastMaskAt = 0;
    this.enabling = null;
  }

  get ready() {
    return this.mode !== null;
  }

  enable() {
    this.enabling ??= this.#enable().catch((err) => {
      this.enabling = null;
      throw err;
    });
    return this.enabling;
  }

  async #enable() {
    try {
      const worker = new Worker(new URL('./segment-worker.js', import.meta.url));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('El hilo de detección no respondió')), 60000);
        worker.onmessage = (e) => {
          if (e.data.type === 'ready') {
            clearTimeout(timer);
            resolve();
          } else if (e.data.type === 'error') {
            clearTimeout(timer);
            reject(new Error(e.data.message));
          }
        };
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(new Error(e.message || 'worker'));
        };
        worker.postMessage({ type: 'init', base: BASE });
      });
      worker.onmessage = (e) => this.#onWorker(e.data);
      this.worker = worker;
      this.mode = 'worker';
    } catch (err) {
      console.warn('Detección en hilo aparte no disponible, uso el principal', err);
      this.segmenter = await loadMainThread();
      this.mode = 'main';
    }
  }

  #onWorker(msg) {
    if (msg.type === 'mask') {
      const now = performance.now();
      const took = now - this.sentAt;
      this.ms = this.ms ? this.ms * 0.8 + took * 0.2 : took;
      if (this.lastMaskAt) this.interval = this.interval ? this.interval * 0.8 + (now - this.lastMaskAt) * 0.2 : now - this.lastMaskAt;
      this.lastMaskAt = now;
      this.#store(msg.data, msg.width, msg.height);
    }
    if (msg.type === 'mask' || msg.type === 'skip' || msg.type === 'error') this.inFlight = false;
  }

  /** Guarda la máscara nueva suavizándola con la anterior (menos parpadeo en los bordes). */
  #store(data, width, height) {
    if (this.data && this.data.length === data.length) {
      const old = this.data;
      for (let i = 0; i < data.length; i++) data[i] = (data[i] * 3 + old[i] * 2) / 5;
    }
    this.data = data;
    this.width = width;
    this.height = height;
    this.version++;
  }

  /** Pide procesar un fotograma. Nunca bloquea: si el anterior sigue en marcha, se salta. */
  process(video) {
    if (!this.ready || !video.videoWidth || this.inFlight) return;
    const now = performance.now();
    if (this.mode === 'main') {
      // Sin hilo aparte: como mucho ~12 veces por segundo para no frenar el dibujo.
      if (now - this.lastRun < Math.max(80, this.interval)) return;
      this.lastRun = now;
      const ts = Math.max(this.lastTs + 1, Math.round(now));
      this.lastTs = ts;
      try {
        this.segmenter.segmentForVideo(video, ts, (result) => {
          const mask = result.confidenceMasks?.[0];
          if (!mask) return;
          const f = mask.getAsFloat32Array();
          const data = new Uint8Array(f.length);
          for (let i = 0; i < f.length; i++) data[i] = f[i] * 255;
          this.#store(data, mask.width, mask.height);
        });
      } catch (err) {
        console.warn('Segmentación fallida', err);
      }
      // Como mucho ~20 % del hilo principal: en móviles lentos la silueta se actualiza menos veces.
      const took = performance.now() - now;
      this.ms = this.ms ? this.ms * 0.8 + took * 0.2 : took;
      this.interval = Math.max(80, Math.min(250, this.ms * 5));
      return;
    }
    this.inFlight = true;
    this.sentAt = now;
    const k = INPUT / Math.max(video.videoWidth, video.videoHeight);
    const w = Math.max(1, Math.round(video.videoWidth * k));
    const h = Math.max(1, Math.round(video.videoHeight * k));
    createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' })
      .catch(() => createImageBitmap(video))
      .then((bitmap) => this.worker.postMessage({ type: 'frame', bitmap, ts: now }, [bitmap]))
      .catch(() => (this.inFlight = false));
  }
}
