// Cámara + compositor. La imagen de la cámara se dibuja en un canvas del tamaño y orientación exactos
// de salida (vertical 9:16 u horizontal 16:9), con la corrección de color aplicada en la GPU.
// Lo que se ve en pantalla es exactamente lo que se graba.

import { Grader, coverCrop } from './grade.js';
import { PersonMask } from './segment.js';

/** Tamaño de salida: el número es el lado corto (720, 1080, 2160). */
export function outputSize(quality, orientation) {
  const short = quality;
  const long = Math.round((quality * 16) / 9 / 2) * 2;
  return orientation === 'horizontal' ? { width: long, height: short } : { width: short, height: long };
}

/** Ajustes de la propia cámara (hardware) que se pueden exponer si el dispositivo los soporta. */
const HW_KEYS = ['zoom', 'exposureCompensation', 'colorTemperature', 'focusDistance', 'torch'];

export class Camera {
  constructor(canvas) {
    this.canvas = canvas;
    this.grader = new Grader(canvas);
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
    // En iOS el vídeo debe estar en el documento para que entregue fotogramas.
    Object.assign(this.video.style, {
      position: 'fixed', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none', left: '0', top: '0',
    });
    document.body.append(this.video);
    this.stream = null;
    this.fps = 30;
    this.running = false;
    this.frameCount = 0;
    this.mask = new PersonMask();
    this.bgBlur = 0;
  }

  /** Desenfoque de fondo 0..1. La primera vez descarga el modelo de segmentación. */
  async setBackgroundBlur(amount) {
    this.bgBlur = amount;
    if (amount > 0 && !this.mask.ready) await this.mask.enable();
  }

  get videoTrack() {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  get audioTrack() {
    return this.stream?.getAudioTracks()[0] ?? null;
  }

  /**
   * @param {{facing:string, orientation:'vertical'|'horizontal', quality:number, fps:number,
   *          audio:{noiseSuppression:boolean, echoCancellation:boolean, autoGainControl:boolean}}} opts
   */
  async open(opts) {
    this.close();
    const { width, height } = outputSize(opts.quality, opts.orientation);
    this.canvas.width = width;
    this.canvas.height = height;
    this.fps = opts.fps;
    // Pedimos a la cámara la resolución y orientación de salida; si entrega otra proporción,
    // el compositor recorta el centro (sin deformar).
    const video = {
      facingMode: opts.facing,
      width: { ideal: width },
      height: { ideal: height },
      aspectRatio: { ideal: width / height },
      frameRate: { ideal: opts.fps },
    };
    const audio = {
      noiseSuppression: opts.audio.noiseSuppression,
      echoCancellation: opts.audio.echoCancellation,
      autoGainControl: opts.audio.autoGainControl,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
    };
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await this.focusAuto();
    this.running = true;
    this.#loop();
  }

  #loop() {
    const v = this.video;
    const draw = () => {
      if (!this.running) return;
      if (v.readyState >= 2 && v.videoWidth) {
        const blur = this.bgBlur > 0 && this.mask.ready;
        if (blur) this.mask.process(v);
        this.grader.draw(v, v.videoWidth, v.videoHeight, blur ? this.mask : null, this.bgBlur);
        this.frameCount++;
      }
      schedule();
    };
    const schedule = () => {
      if (!this.running) return;
      if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(draw);
      else requestAnimationFrame(draw);
    };
    schedule();
  }

  close() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  setAdjust(values) {
    this.grader.set(values);
  }

  /** Stream para grabar: vídeo del canvas (ya corregido) + audio del micrófono. */
  recordStream() {
    const out = this.canvas.captureStream(this.fps);
    const audio = this.audioTrack;
    if (audio) out.addTrack(audio);
    return out;
  }

  /** Qué sabe hacer la cámara con el enfoque. */
  focusSupport() {
    const track = this.videoTrack;
    const caps = track?.getCapabilities?.() ?? {};
    const supported = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
    const modes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
    return {
      point: !!supported.pointsOfInterest && modes.length > 0,
      modes,
      exposureModes: Array.isArray(caps.exposureMode) ? caps.exposureMode : [],
      lock: modes.includes('manual') || modes.includes('single-shot'),
    };
  }

  /** Enfoque automático continuo (por defecto: es lo mejor para vídeo). */
  async focusAuto() {
    const f = this.focusSupport();
    const c = {};
    if (f.modes.includes('continuous')) c.focusMode = 'continuous';
    if (f.exposureModes.includes('continuous')) c.exposureMode = 'continuous';
    if (f.point) c.pointsOfInterest = [{ x: 0.5, y: 0.5 }];
    if (Object.keys(c).length) await this.#apply(c);
  }

  /**
   * Enfoca (y expone) en el punto tocado. `u`,`v` van de 0 a 1 sobre el encuadre grabado.
   * @returns {Promise<'point'|'refocus'|'unsupported'>}
   */
  async focusAt(u, v) {
    const f = this.focusSupport();
    const vid = this.video;
    if (!f.modes.length) return 'unsupported';
    const [cx, cy, cw, ch] = coverCrop(vid.videoWidth, vid.videoHeight, this.canvas.width, this.canvas.height);
    const point = { x: Math.min(1, Math.max(0, cx + u * cw)), y: Math.min(1, Math.max(0, cy + v * ch)) };
    const c = {};
    if (f.point) c.pointsOfInterest = [point];
    // Enfoque continuo sobre el punto: sigue el foco si te mueves un poco. Si no hay, un enfoque puntual.
    if (f.modes.includes('continuous')) c.focusMode = 'continuous';
    else if (f.modes.includes('single-shot')) c.focusMode = 'single-shot';
    if (f.exposureModes.includes('continuous')) c.exposureMode = 'continuous';
    if (!f.point && f.modes.includes('single-shot')) {
      // Sin elegir punto: forzar un nuevo enfoque (puntual y luego continuo).
      await this.#apply({ focusMode: 'single-shot' });
      await this.#apply(c);
      return 'refocus';
    }
    await this.#apply(c);
    return f.point ? 'point' : 'refocus';
  }

  /** Bloquea enfoque y exposición donde están ahora (para que no «busque» mientras grabas). */
  async lockFocus() {
    const track = this.videoTrack;
    const f = this.focusSupport();
    if (!track || !f.lock) return false;
    const settings = track.getSettings?.() ?? {};
    const c = {};
    if (f.modes.includes('manual') && settings.focusDistance !== undefined) {
      c.focusMode = 'manual';
      c.focusDistance = settings.focusDistance;
    } else c.focusMode = f.modes.includes('manual') ? 'manual' : 'single-shot';
    if (f.exposureModes.includes('manual')) c.exposureMode = 'manual';
    await this.#apply(c);
    return true;
  }

  async #apply(c) {
    try {
      await this.videoTrack?.applyConstraints({ advanced: [c] });
    } catch (err) {
      console.warn('Restricción de cámara no aplicada', c, err);
    }
  }

  /** Controles de hardware disponibles: { zoom: {min,max,step,value}, torch: {value}, … } */
  hardware() {
    const track = this.videoTrack;
    if (!track?.getCapabilities) return {};
    const caps = track.getCapabilities();
    const settings = track.getSettings?.() ?? {};
    const out = {};
    for (const key of HW_KEYS) {
      const c = caps[key];
      if (c === undefined) continue;
      if (key === 'torch') {
        if (c === true || (Array.isArray(c) && c.includes(true))) out.torch = { value: !!settings.torch };
      } else if (typeof c === 'object' && c.max > c.min) {
        out[key] = { min: c.min, max: c.max, step: c.step || (c.max - c.min) / 100, value: settings[key] ?? c.min };
      }
    }
    const modes = (k) => (Array.isArray(caps[k]) ? caps[k] : []);
    if (modes('whiteBalanceMode').includes('manual') && out.colorTemperature) out.whiteBalanceManual = true;
    else delete out.colorTemperature;
    if (!modes('focusMode').includes('manual')) delete out.focusDistance;
    out.focusModes = modes('focusMode');
    return out;
  }

  async setHardware(key, value) {
    const track = this.videoTrack;
    if (!track) return;
    const c = {};
    if (key === 'colorTemperature') {
      c.whiteBalanceMode = value ? 'manual' : 'continuous';
      if (value) c.colorTemperature = value;
    } else if (key === 'focusDistance') {
      c.focusMode = value ? 'manual' : 'continuous';
      if (value) c.focusDistance = value;
    } else if (key === 'exposureCompensation') {
      c.exposureMode = 'continuous';
      c.exposureCompensation = value;
    } else {
      c[key] = value;
    }
    try {
      await track.applyConstraints({ advanced: [c] });
    } catch (err) {
      console.warn('No se pudo aplicar', key, err);
    }
  }
}
