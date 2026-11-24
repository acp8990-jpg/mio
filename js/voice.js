// El texto sigue tu voz.
// - Modo «palabras»: reconocimiento de voz (Web Speech API) y alineación con el guion: el teleprompter
//   va exactamente a la palabra que estás diciendo, se para si te paras y se salta lo que te saltas.
// - Modo «al hablar»: detecta si estás hablando por el nivel del micrófono (funciona sin conexión y en
//   cualquier navegador): avanza a la velocidad elegida mientras hablas y se para en los silencios.

export function normalize(word) {
  return word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ]/g, '');
}

/** Palabras del texto con su posición: [{ text, norm, start, end }] */
export function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(/\S+/g)) {
    const norm = normalize(m[0]);
    if (norm) out.push({ text: m[0], norm, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function lev1(a, b) {
  // ¿Distancia de edición <= 1? (rápido, sin matriz)
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export function similarity(a, b) {
  if (a === b) return 1;
  if (a.length >= 4 && b.length >= 4) {
    if (lev1(a, b)) return 0.8;
    if (a.startsWith(b) || b.startsWith(a)) return 0.7;
  }
  // Números dichos como palabras («dos» vs «2»): no se intenta, se tolera por el contexto.
  return 0;
}

/**
 * Alinea lo que se va diciendo con el guion y devuelve la posición de lectura (índice de la siguiente
 * palabra por leer). Solo avanza; tolera palabras mal reconocidas, añadidas o saltadas.
 */
export class ScriptMatcher {
  constructor(words) {
    this.words = words.map((w) => w.norm);
    this.pos = 0;
  }

  reset(pos = 0) {
    this.pos = pos;
  }

  /** @param {string[]} spoken últimas palabras reconocidas (normalizadas), en orden */
  update(spoken) {
    const W = this.words;
    if (!spoken.length || this.pos >= W.length) return this.pos;
    const tail = spoken.slice(-6);
    const from = Math.max(0, this.pos - 2);
    const to = Math.min(W.length - 1, this.pos + 40);
    let best = -1;
    let bestScore = 0;
    for (let j = from; j <= to; j++) {
      // Puntuación de que la última palabra dicha sea W[j], comparando hacia atrás.
      let score = 0;
      let wi = j;
      for (let t = tail.length - 1; t >= 0 && wi >= 0; t--) {
        const s = similarity(tail[t], W[wi]);
        if (s > 0) {
          score += s;
          wi--;
        } else if (wi - 1 >= 0 && similarity(tail[t], W[wi - 1]) > 0) {
          // el orador se saltó una palabra del guion
          score += similarity(tail[t], W[wi - 1]) * 0.7;
          wi -= 2;
        } else {
          // palabra dicha que no está en el guion (muletilla, error del reconocedor)
          score -= 0.25;
        }
      }
      // Preferimos avanzar poco: penalización suave por distancia.
      score -= Math.max(0, j - this.pos) * 0.02;
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    const needed = tail.length >= 2 ? 1.5 : 0.95;
    const near = best >= this.pos - 1 && best <= this.pos + 2;
    if (best >= 0 && (bestScore >= needed || (near && bestScore >= 0.95))) {
      this.pos = Math.max(this.pos, best + 1);
    }
    return this.pos;
  }
}

const getSR = () =>
  typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export const speechSupported = () => !!getSR();

/** Reconocimiento de voz continuo que se reinicia solo. Entrega las palabras normalizadas. */
export class SpeechFollower {
  constructor({ lang, onWords, onError }) {
    this.lang = lang;
    this.onWords = onWords;
    this.onError = onError;
    this.active = false;
    this.finals = [];
    this.rec = null;
    this.restarts = 0;
  }

  start() {
    if (!getSR()) {
      this.onError?.('unsupported');
      return;
    }
    this.active = true;
    this.finals = [];
    this.restarts = 0;
    this.netErrors = 0;
    this.#spawn();
  }

  #spawn() {
    const SR = getSR();
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finals.push(...r[0].transcript.split(/\s+/).map(normalize).filter(Boolean));
        else interim += ' ' + r[0].transcript;
      }
      if (this.finals.length > 60) this.finals = this.finals.slice(-30);
      const words = [...this.finals, ...interim.split(/\s+/).map(normalize).filter(Boolean)];
      this.restarts = 0;
      this.netErrors = 0;
      this.onWords?.(words);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      const fatal = ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'];
      // Sin conexión o servicio caído: tras dos fallos seguidos pasamos al plan B.
      if (fatal.includes(e.error) || (e.error === 'network' && ++this.netErrors >= 2)) {
        this.active = false;
        this.onError?.(e.error);
      }
    };
    rec.onend = () => {
      if (!this.active) return;
      // Chrome corta el reconocimiento tras silencios: lo relanzamos.
      if (++this.restarts > 20) {
        this.active = false;
        this.onError?.('stopped');
        return;
      }
      setTimeout(() => this.active && this.#spawn(), 150);
    };
    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      console.warn(err);
    }
  }

  stop() {
    this.active = false;
    try {
      this.rec?.abort();
    } catch {
      /* ya parado */
    }
    this.rec = null;
  }
}

/** Detector de voz por nivel del micrófono, con margen para no cortar entre palabras. */
export class LevelFollower {
  constructor({ sensitivity = 0.5, onSpeaking }) {
    this.sensitivity = sensitivity;
    this.onSpeaking = onSpeaking;
    this.ctx = null;
    this.speaking = false;
    this.level = 0;
  }

  /** Llamar desde el gesto del usuario (para que iOS permita el audio). */
  prime() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!this.ctx) this.ctx = new AC();
    this.ctx.resume?.();
  }

  start(stream) {
    this.stop();
    this.prime();
    if (!this.ctx || !stream?.getAudioTracks().length) return;
    const src = this.ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const an = this.ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    this.src = src;
    const buf = new Float32Array(an.fftSize);
    let lastVoice = 0;
    let noise = 0.005;
    this.timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      this.level = rms;
      // Suelo de ruido adaptativo: sube despacio, baja rápido.
      noise = rms < noise ? noise * 0.9 + rms * 0.1 : noise * 0.995 + rms * 0.005;
      const factor = 4.5 - this.sensitivity * 3; // sensibilidad alta = umbral bajo
      const threshold = Math.max(0.004, noise * factor);
      const now = performance.now();
      if (rms > threshold) lastVoice = now;
      const speaking = now - lastVoice < 450;
      if (speaking !== this.speaking) {
        this.speaking = speaking;
        this.onSpeaking?.(speaking);
      }
    }, 50);
  }

  stop() {
    clearInterval(this.timer);
    this.src?.disconnect();
    this.src = null;
    if (this.speaking) {
      this.speaking = false;
      this.onSpeaking?.(false);
    }
  }
}
