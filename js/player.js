// Vista previa del vídeo editado: reproduce los trozos de cada toma en orden y dibuja encima
// (con el mismo código que la exportación) subtítulos, zoom, transiciones y elementos.

import { drawFrame, outputDims } from './render.js';
import { pieceAt, speechOut } from './timeline.js';

export class Preview {
  constructor(canvas, { onTime, onEnd } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onTime = onTime;
    this.onEnd = onEnd;
    this.videos = new Map(); // takeId -> { el, url }
    this.timeline = null;
    this.edit = null;
    this.images = new Map();
    this.music = null; // <audio>
    this.musicUrl = null;
    this.playing = false;
    this.t = 0;
    this.piece = null;
    this.raf = 0;
  }

  /** Carga (o actualiza) la línea de tiempo y la edición sin perder la posición. */
  load(timeline, edit, images, musicBlob) {
    this.timeline = timeline;
    this.edit = edit;
    this.images = images;
    this.speech = speechOut(timeline);
    const used = new Set(timeline.pieces.map((p) => p.take.id));
    for (const [id, v] of this.videos) {
      if (!used.has(id)) {
        v.el.pause();
        v.el.removeAttribute('src');
        v.el.load();
        URL.revokeObjectURL(v.url);
        this.videos.delete(id);
      }
    }
    for (const p of timeline.pieces) this.#video(p.take);
    this.#setMusic(musicBlob);
    this.#resize();
    this.t = Math.min(this.t, Math.max(0, timeline.duration - 0.01));
    if (!this.playing) this.seek(this.t);
  }

  #setMusic(blob) {
    if (this.musicBlob === blob) return;
    this.musicBlob = blob;
    this.music?.pause();
    if (this.musicUrl) URL.revokeObjectURL(this.musicUrl);
    this.music = null;
    this.musicUrl = null;
    if (blob) {
      this.musicUrl = URL.createObjectURL(blob);
      this.music = new Audio(this.musicUrl);
      this.music.loop = true;
    }
  }

  #resize() {
    const first = this.timeline.pieces[0]?.take;
    const srcW = first?.analysis?.width || first?.width || 1080;
    const srcH = first?.analysis?.height || first?.height || 1920;
    const { width, height } = outputDims(srcW, srcH, this.edit.format, 720);
    // Vista previa ligera: lado largo de 960 px como máximo.
    const k = Math.min(1, 960 / Math.max(width, height));
    const w = Math.round(width * k);
    const h = Math.round(height * k);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  #video(take) {
    let v = this.videos.get(take.id);
    if (!v) {
      const el = document.createElement('video');
      el.playsInline = true;
      el.setAttribute('playsinline', '');
      el.preload = 'auto';
      const url = URL.createObjectURL(take.blob);
      el.src = url;
      v = { el, url };
      this.videos.set(take.id, v);
      el.addEventListener('seeked', () => !this.playing && this.draw());
      el.addEventListener('loadeddata', () => !this.playing && this.draw());
    }
    return v.el;
  }

  /** Tiempo de reproducción del vídeo de una toma para un instante de salida. */
  #mediaTime(piece, t) {
    return (piece.take.analysis?.t0 ?? 0) + piece.srcStart + Math.max(0, t - piece.outStart);
  }

  seek(t) {
    if (!this.timeline?.pieces.length) {
      this.draw();
      return;
    }
    this.t = Math.max(0, Math.min(t, this.timeline.duration - 0.001));
    const piece = pieceAt(this.timeline, this.t);
    this.#activate(piece, false);
    const el = this.#video(piece.take);
    el.currentTime = this.#mediaTime(piece, this.t);
    if (this.music) this.music.currentTime = this.t % (this.music.duration || Infinity);
    this.onTime?.(this.t);
    this.draw();
  }

  #activate(piece, play) {
    if (this.piece && this.piece.take.id !== piece.take.id) this.#video(this.piece.take).pause();
    this.piece = piece;
    const el = this.#video(piece.take);
    if (play) el.play().catch(() => {});
  }

  play() {
    if (!this.timeline?.pieces.length) return;
    if (this.t >= this.timeline.duration - 0.05) this.t = 0;
    this.playing = true;
    const piece = pieceAt(this.timeline, this.t);
    const el = this.#video(piece.take);
    el.currentTime = this.#mediaTime(piece, this.t);
    this.#activate(piece, true);
    if (this.music) {
      this.music.currentTime = this.t % (this.music.duration || Infinity);
      this.music.play().catch(() => {});
    }
    this.lastClock = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.#tick());
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const v of this.videos.values()) v.el.pause();
    this.music?.pause();
  }

  #tick() {
    if (!this.playing) return;
    const piece = this.piece;
    const el = this.#video(piece.take);
    const now = performance.now();
    // El reloj lo marca el propio vídeo; si aún está cargando, avanzamos con el reloj del sistema.
    const mt = el.currentTime - (piece.take.analysis?.t0 ?? 0);
    if (!el.paused && !el.seeking && el.readyState >= 2) this.t = piece.outStart + Math.max(0, mt - piece.srcStart);
    else this.t += (now - this.lastClock) / 1000;
    this.lastClock = now;
    if (this.t >= piece.outEnd - 0.01 || el.ended) {
      const next = this.timeline.pieces[piece.index + 1];
      if (!next) {
        this.pause();
        this.t = this.timeline.duration;
        this.draw();
        this.onTime?.(this.t);
        this.onEnd?.();
        return;
      }
      this.t = next.outStart;
      const nel = this.#video(next.take);
      nel.currentTime = this.#mediaTime(next, this.t);
      this.#activate(next, true);
    }
    this.#duck();
    this.draw();
    this.onTime?.(this.t);
    this.raf = requestAnimationFrame(() => this.#tick());
  }

  #duck() {
    if (!this.music) return;
    const m = this.edit.music;
    const talking = m.duck && this.speech.some(([a, b]) => this.t >= a - 0.15 && this.t <= b + 0.2);
    const target = m.volume * (talking ? 0.3 : 1);
    const cur = this.music.volume;
    this.music.volume = Math.min(1, Math.max(0, cur + (target - cur) * 0.15));
  }

  draw() {
    const { canvas, ctx } = this;
    const W = canvas.width;
    const H = canvas.height;
    if (!this.timeline?.pieces.length) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      return;
    }
    const piece = this.piece || pieceAt(this.timeline, this.t);
    const el = this.#video(piece.take);
    drawFrame(ctx, W, H, {
      source: el.readyState >= 2 ? el : null,
      srcW: el.videoWidth,
      srcH: el.videoHeight,
      t: this.t,
      piece,
      timeline: this.timeline,
      edit: this.edit,
      images: this.images,
    });
  }

  destroy() {
    this.pause();
    for (const v of this.videos.values()) {
      v.el.removeAttribute('src');
      v.el.load();
      URL.revokeObjectURL(v.url);
    }
    this.videos.clear();
    if (this.musicUrl) URL.revokeObjectURL(this.musicUrl);
  }
}
