// Separación persona / fondo con MediaPipe (modelo «selfie segmenter», se ejecuta en el móvil).
// Se descarga solo la primera vez que se activa el desenfoque de fondo (~15 MB) y queda en caché.

let loading = null;

export function loadSegmenter() {
  loading ??= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import('../vendor/mediapipe/vision_bundle.mjs');
    const base = new URL('../vendor/mediapipe/', import.meta.url).href;
    const fileset = await FilesetResolver.forVisionTasks(base);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: `${base}selfie_segmenter.tflite`, delegate },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
    try {
      return await ImageSegmenter.createFromOptions(fileset, options('GPU'));
    } catch (err) {
      console.warn('Segmentación en GPU no disponible, uso CPU', err);
      return ImageSegmenter.createFromOptions(fileset, options('CPU'));
    }
  })();
  loading.catch(() => (loading = null));
  return loading;
}

/** Máscara de la persona (0 = fondo, 255 = persona), actualizada desde el vídeo de la cámara. */
export class PersonMask {
  constructor() {
    this.segmenter = null;
    this.data = null;
    this.width = 0;
    this.height = 0;
    this.version = 0;
    this.lastTs = 0;
    this.lastRun = 0;
  }

  get ready() {
    return !!this.segmenter;
  }

  async enable() {
    this.segmenter = await loadSegmenter();
  }

  /** Procesa un fotograma (como mucho ~30 veces por segundo). */
  process(video) {
    if (!this.segmenter || !video.videoWidth) return;
    const now = performance.now();
    if (now - this.lastRun < 30) return;
    this.lastRun = now;
    const ts = Math.max(this.lastTs + 1, Math.round(now));
    this.lastTs = ts;
    try {
      this.segmenter.segmentForVideo(video, ts, (result) => {
        const mask = result.confidenceMasks?.[0];
        if (!mask) return;
        const f = mask.getAsFloat32Array();
        if (!this.data || this.data.length !== f.length) this.data = new Uint8Array(f.length);
        for (let i = 0; i < f.length; i++) this.data[i] = f[i] * 255;
        this.width = mask.width;
        this.height = mask.height;
        this.version++;
      });
    } catch (err) {
      console.warn('Segmentación fallida', err);
    }
  }
}
