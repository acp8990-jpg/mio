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
    this.interval = 66; // ms entre cálculos; se adapta a lo que tarda este móvil
    this.ms = 0; // lo que tarda cada cálculo (media)
  }

  get ready() {
    return !!this.segmenter;
  }

  async enable() {
    this.segmenter = await loadSegmenter();
  }

  /**
   * Procesa un fotograma (como mucho ~15 veces por segundo). Leer la máscara de la GPU frena el dibujo,
   * así que no se hace en cada fotograma: entre medias se reutiliza la última (la silueta apenas cambia).
   */
  process(video) {
    if (!this.segmenter || !video.videoWidth) return;
    const now = performance.now();
    if (now - this.lastRun < this.interval) return;
    this.lastRun = now;
    const ts = Math.max(this.lastTs + 1, Math.round(now));
    this.lastTs = ts;
    try {
      this.segmenter.segmentForVideo(video, ts, (result) => {
        const mask = result.confidenceMasks?.[0];
        if (!mask) return;
        const f = mask.getAsFloat32Array();
        if (!this.data || this.data.length !== f.length) {
          this.data = new Uint8Array(f.length);
          for (let i = 0; i < f.length; i++) this.data[i] = f[i] * 255;
        } else {
          // Suavizado en el tiempo: el borde no «baila» entre fotogramas.
          const d = this.data;
          for (let i = 0; i < f.length; i++) d[i] = d[i] * 0.35 + f[i] * 165.75;
        }
        this.width = mask.width;
        this.height = mask.height;
        this.version++;
      });
    } catch (err) {
      console.warn('Segmentación fallida', err);
    }
    // Calcular la silueta bloquea el hilo principal: como mucho un ~20 % del tiempo, para que el dibujo
    // y la grabación no den tirones en móviles lentos (la silueta se actualiza menos veces, nada más).
    const took = performance.now() - now;
    this.ms = this.ms ? this.ms * 0.8 + took * 0.2 : took;
    this.interval = Math.max(66, Math.min(250, this.ms * 5));
  }
}
