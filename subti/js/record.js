// Grabar con teleprompter: guion sin límite, cámara con corrección de imagen y fondo, texto que sigue tu
// voz y tomas por partes (si te equivocas, repites solo esa parte). Al terminar, las tomas se unen y el
// vídeo pasa a Subti para ponerle subtítulos con el texto exacto del guion.
//
// Reutiliza los módulos de TeleClip (cámara, corrección de color, fondo y seguimiento de voz) con la
// interfaz de Subti.

import { Camera, outputSize } from '../../js/camera.js';
import { ADJUST_DEFAULTS, PRESETS } from '../../js/grade.js';
import { tokenize, ScriptMatcher, SpeechFollower, LevelFollower, speechSupported } from '../../js/voice.js';
import { prefs, setPrefs } from './db.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const haptic = (ms = 8) => navigator.vibrate?.(ms);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export const REC_DEFAULTS = {
  split: 'paragraphs',
  fontSize: 34,
  wpm: 140,
  boxH: 34,
  bgA: 55,
  boxPos: 'top',
  align: 'center',
  countdown: 3,
  mirror: false,
  autoAdvance: true,
  autoStop: false,
  voiceMode: 'speech',
  voiceLang: 'es-ES',
  sens: 50,
  preset: 'natural',
  adjust: {},
  bgMode: 'none',
  bgBlur: 60,
  bgColor: '#1d1b2e',
  orientation: 'vertical',
  quality: 1080,
  fps: 30,
  bitrate: 'high',
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  facing: 'user',
};

const ADJUST_LABELS = {
  exposure: ['Exposición', -2, 2], brightness: ['Brillo', -1, 1], contrast: ['Contraste', -1, 1],
  highlights: ['Luces', -1, 1], shadows: ['Sombras', -1, 1], saturation: ['Saturación', -1, 1],
  vibrance: ['Intensidad', -1, 1], temperature: ['Temperatura', -1, 1], tint: ['Tinte', -1, 1],
  sharpness: ['Nitidez', 0, 1], smoothing: ['Suavizar piel', 0, 1], vignette: ['Viñeta', 0, 1],
};
const VOICE_LANGS = [
  ['es-ES', 'Español (España)'], ['es-MX', 'Español (México)'], ['es-US', 'Español (EE. UU.)'], ['ca-ES', 'Català'],
  ['gl-ES', 'Galego'], ['eu-ES', 'Euskara'], ['en-US', 'English'], ['pt-BR', 'Português'], ['fr-FR', 'Français'], ['it-IT', 'Italiano'],
];

const S = {
  set: { ...REC_DEFAULTS, ...prefs('rec', {}) },
  parts: [], // [{ text, words: [{text,norm}] }]
  takes: new Map(), // índice de parte -> { blob, duration }
  cur: 0,
  camera: null,
  recorder: null,
  recording: false,
  rehearsing: false,
  counting: false,
  pos: 0, // posición de lectura (fraccional, en palabras)
  matcher: null,
  speech: null,
  level: null,
  speaking: false,
  bgImage: null,
  raf: 0,
  last: 0,
  t0: 0,
  onDone: null,
  toast: null,
  openSheet: null,
  closeSheet: null,
};

const save = () => setPrefs('rec', S.set);

// ================================================================ guion

const SPLITTERS = {
  paragraphs: (t) => t.split(/\n\s*\n/),
  sentences: (t) => t.replace(/\n+/g, ' ').match(/[^.!?…]+[.!?…]+["»”)]*|[^.!?…]+$/g) || [],
  none: (t) => [t],
};

function splitScript(text) {
  return (SPLITTERS[S.set.split] || SPLITTERS.paragraphs)(text)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ text: p, words: tokenize(p) }))
    .filter((p) => p.words.length);
}

function renderScriptStats() {
  const text = $('#scriptText').value;
  const words = tokenize(text).length;
  const parts = splitScript(text).length;
  const mins = words / S.set.wpm;
  $('#scriptStats').innerHTML = words
    ? `<span><b>${words.toLocaleString('es')}</b> palabras</span><span><b>${text.length.toLocaleString('es')}</b> caracteres</span><span>≈ <b>${mins < 1 ? `${Math.max(1, Math.round(mins * 60))} s` : `${mins.toFixed(1).replace('.', ',')} min`}</b> hablando</span><span><b>${parts}</b> ${parts === 1 ? 'toma' : 'tomas'}</span>`
    : '<span>Sin límite de texto. Puedes pegar un guion entero.</span>';
  for (const b of $$('#splitSeg button')) b.setAttribute('aria-pressed', String(b.dataset.split === S.set.split));
  $('#scriptGo').disabled = !words;
}

export function initRecorder({ show, toast, openSheet, closeSheet, onDone }) {
  Object.assign(S, { show, toast, openSheet, closeSheet, onDone });
  const ta = $('#scriptText');
  try {
    ta.value = localStorage.getItem('subti.script') || '';
  } catch {
    /* sin almacenamiento */
  }
  ta.addEventListener('input', () => {
    try {
      localStorage.setItem('subti.script', ta.value);
    } catch {
      /* lleno */
    }
    renderScriptStats();
  });
  for (const b of $$('#splitSeg button')) b.addEventListener('click', () => {
    haptic();
    S.set.split = b.dataset.split;
    save();
    renderScriptStats();
  });
  $('#scriptImport').addEventListener('click', () => $('#scriptFile').click());
  $('#scriptFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    ta.value = await f.text();
    ta.dispatchEvent(new Event('input'));
    toast(`Guion importado: ${f.name}`);
  });
  $('#scriptBack').addEventListener('click', () => show('#home'));
  $('#scriptGo').addEventListener('click', openCamera);
  bindCameraUi();
  bindSettings();
}

export function openScript() {
  S.show('#script');
  renderScriptStats();
  const ta = $('#scriptText');
  if (!ta.value) setTimeout(() => ta.focus(), 300);
}

// ================================================================ cámara

async function openCamera() {
  const parts = splitScript($('#scriptText').value);
  if (!parts.length) return;
  // Si cambia el guion, las tomas anteriores ya no corresponden.
  const sig = parts.map((p) => p.text).join('\n§\n');
  if (sig !== S.sig) {
    S.takes.clear();
    S.cur = 0;
  }
  S.sig = sig;
  S.parts = parts;
  S.show('#rec');
  S.level ??= new LevelFollower({ sensitivity: S.set.sens / 100, onSpeaking: (v) => (S.speaking = v) });
  S.level.prime();
  applyLook();
  selectPart(Math.min(S.cur, parts.length - 1));
  await startCamera();
}

async function startCamera() {
  S.camera ??= new Camera($('#recCanvas'));
  const s = S.set;
  const { width, height } = outputSize(s.quality, s.orientation);
  const stage = $('#recStage');
  stage.style.setProperty('--rar', `${width} / ${height}`);
  stage.style.setProperty('--rk', String(width / height));
  $('#recRatio').replaceChildren(svgUse(s.orientation === 'vertical' ? 'ratio' : 'ratio-h'));
  try {
    await S.camera.open({
      facing: s.facing, orientation: s.orientation, quality: s.quality, fps: s.fps,
      audio: { noiseSuppression: s.noiseSuppression, echoCancellation: s.echoCancellation, autoGainControl: s.autoGainControl },
    });
  } catch (err) {
    console.error(err);
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    S.toast(denied ? 'Necesito permiso para usar la cámara y el micrófono. Actívalo en los ajustes del navegador.' : 'No se pudo abrir la cámara. Prueba con menos resolución.', 5000);
    if (s.quality > 1080) {
      s.quality = 1080;
      save();
    }
    return;
  }
  S.camera.setAdjust({ ...(PRESETS[s.preset]?.values || {}), ...s.adjust });
  applyBackground();
  S.level.start(S.camera.stream);
  renderHardware();
  startLoop();
}

function stopCamera() {
  stopRecording(true);
  S.speech?.stop();
  S.level?.stop();
  S.camera?.close();
  cancelAnimationFrame(S.raf);
  S.raf = 0;
}

async function applyBackground() {
  const s = S.set;
  if (!S.camera) return;
  try {
    await S.camera.setBackground({ mode: s.bgMode, blur: s.bgBlur / 100, color: s.bgColor, image: S.bgImage });
  } catch (err) {
    console.warn(err);
    S.toast('No se pudo separar el fondo en este dispositivo');
  }
}

function svgUse(id) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', `#i-${id}`);
  s.append(u);
  return s;
}

// ================================================================ teleprompter

function applyLook() {
  const s = S.set;
  const p = $('#prompter');
  p.style.setProperty('--pf', `${s.fontSize}px`);
  p.style.setProperty('--ph', `${s.boxH}dvh`);
  p.style.setProperty('--pa', String(s.bgA / 100));
  p.style.setProperty('--palign', s.align);
  const top = { top: 'calc(64px + var(--safe-t))', middle: `calc(50dvh - ${s.boxH / 2}dvh)`, bottom: `calc(100dvh - ${s.boxH}dvh - 210px - var(--safe-b))` }[s.boxPos];
  p.style.setProperty('--pt', top);
  p.classList.toggle('mirror', s.mirror);
  $('#recVoice').classList.toggle('on', s.voiceMode !== 'fixed');
  scrollTo(S.pos, true);
}

function selectPart(i) {
  if (S.recording) return;
  S.cur = Math.max(0, Math.min(S.parts.length - 1, i));
  const part = S.parts[S.cur];
  const box = $('#prompterText');
  box.replaceChildren();
  part.words.forEach((w, k) => {
    const sp = document.createElement('span');
    sp.textContent = w.text;
    sp.dataset.k = k;
    box.append(sp, ' ');
  });
  S.matcher = new ScriptMatcher(part.words);
  S.pos = 0;
  S.lastShown = -1;
  scrollTo(0, true);
  renderPartNav();
}

function renderPartNav() {
  const n = S.parts.length;
  const pill = $('#partPill');
  pill.textContent = n > 1 ? `Parte ${S.cur + 1} de ${n}` : 'Toma única';
  if (S.takes.has(S.cur)) {
    const ok = document.createElement('span');
    ok.className = 'ok';
    ok.textContent = '✓';
    pill.append(ok);
  }
  $('#partPrev').disabled = S.cur === 0;
  $('#partNext').disabled = S.cur >= n - 1;
  $('#partPrev').style.visibility = n > 1 ? '' : 'hidden';
  $('#partNext').style.visibility = n > 1 ? '' : 'hidden';
  const done = S.takes.size;
  $('#recDoneLabel').textContent = done ? `Listo (${done}/${n})` : 'Listo';
  $('#recDone').style.opacity = done ? '1' : '.45';
}

/** Coloca la palabra `pos` (fraccional) a un tercio del cuadro. */
function scrollTo(pos, instant) {
  const box = $('#prompterText');
  const spans = box.children;
  if (!spans.length) return;
  const k = Math.min(spans.length - 1, Math.floor(pos));
  const a = spans[k];
  const b = spans[Math.min(spans.length - 1, k + 1)];
  const y = a.offsetTop + (b.offsetTop - a.offsetTop) * (pos - k);
  const h = $('#prompter').clientHeight;
  const ty = h * 0.3 - y;
  box.style.transition = instant ? 'none' : 'transform .35s cubic-bezier(.2,.8,.2,1)';
  box.style.setProperty('--ty', `${Math.round(ty)}px`);
  const now = Math.floor(pos);
  if (now !== S.lastShown) {
    for (let i = 0; i < spans.length; i++) {
      spans[i].classList.toggle('read', i < now);
      spans[i].classList.toggle('now', i === now && (S.recording || S.rehearsing));
    }
    S.lastShown = now;
  }
}

function mode() {
  return S.set.voiceMode === 'speech' && !speechSupported() ? 'level' : S.set.voiceMode;
}

function startFollowing() {
  S.pos = 0;
  S.matcher.reset(0);
  S.lastShown = -1;
  if (mode() === 'speech') {
    S.speech?.stop();
    S.speech = new SpeechFollower({
      lang: S.set.voiceLang,
      onWords: (w) => {
        const p = S.matcher.update(w);
        if (p > S.pos) S.pos = p;
      },
      onError: (e) => {
        if (e === 'not-allowed' || e === 'service-not-allowed' || e === 'network' || e === 'unsupported') {
          S.toast('El reconocimiento de voz no está disponible: el texto avanzará mientras hablas', 4000);
          S.set.voiceMode = 'level';
        }
      },
    });
    S.speech.start();
  }
}

function startLoop() {
  cancelAnimationFrame(S.raf);
  S.last = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.1, (now - S.last) / 1000);
    S.last = now;
    const active = S.recording || S.rehearsing;
    if (active) {
      const m = mode();
      const total = S.parts[S.cur].words.length;
      if (m === 'fixed' || (m === 'level' && S.speaking)) S.pos = Math.min(total, S.pos + (S.set.wpm / 60) * dt);
      scrollTo(Math.min(S.pos, total - 0.001), false);
      if (S.recording) {
        $('#recTime').textContent = fmt((now - S.t0) / 1000);
        if (S.set.autoStop && S.pos >= total) {
          // termina la última palabra y para con un pequeño margen
          S.autoStopAt ??= now + 1200;
          if (now > S.autoStopAt) stopRecording();
        }
      }
    }
    if (!$('#recSheet').hidden) $('#micMeter').style.width = `${Math.min(100, (S.level?.level || 0) * 900)}%`;
    S.raf = requestAnimationFrame(loop);
  };
  S.raf = requestAnimationFrame(loop);
}

// ================================================================ grabar

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  return [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.4D401F,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

async function countdown() {
  const n = Number(S.set.countdown) || 0;
  if (!n) return true;
  S.counting = true;
  const el = $('#countdown');
  el.hidden = false;
  for (let i = n; i > 0; i--) {
    if (!S.counting) break;
    el.replaceChildren(Object.assign(document.createElement('span'), { textContent: i }));
    haptic(10);
    await new Promise((r) => setTimeout(r, 1000));
  }
  el.hidden = true;
  const ok = S.counting;
  S.counting = false;
  return ok;
}

async function startRecording() {
  if (!S.camera?.stream) return S.toast('La cámara no está lista');
  const mime = pickMime();
  if (mime === null) return S.toast('Este navegador no puede grabar vídeo');
  stopRehearse();
  if (!(await countdown())) return;
  const { width, height } = outputSize(S.set.quality, S.set.orientation);
  const bpp = { standard: 0.08, high: 0.15, max: 0.25 }[S.set.bitrate] ?? 0.15;
  const chunks = [];
  let rec;
  try {
    rec = new MediaRecorder(S.camera.recordStream(), {
      mimeType: mime || undefined,
      videoBitsPerSecond: Math.min(80e6, Math.round(width * height * S.set.fps * bpp)),
      audioBitsPerSecond: { standard: 128e3, high: 192e3, max: 256e3 }[S.set.bitrate] ?? 192e3,
    });
  } catch (err) {
    console.error(err);
    return S.toast('No se pudo empezar a grabar');
  }
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    if (rec.discard) return;
    const blob = new Blob(chunks, { type: (rec.mimeType || mime || 'video/webm').split(';')[0] });
    const duration = (performance.now() - S.t0) / 1000;
    S.takes.set(rec.part, { blob, duration });
    haptic(20);
    renderPartNav();
    const next = S.cur + 1;
    if (S.set.autoAdvance && next < S.parts.length) {
      selectPart(next);
      hint(`Toma guardada ✓ · ahora la parte ${next + 1}`);
    } else if (S.takes.size === S.parts.length) {
      openParts();
    } else hint('Toma guardada ✓');
  };
  rec.part = S.cur;
  S.recorder = rec;
  S.recording = true;
  S.autoStopAt = null;
  S.t0 = performance.now();
  $('#rec').classList.add('recording');
  startFollowing();
  rec.start(1000);
  haptic(15);
}

function stopRecording(discard = false) {
  S.counting = false;
  if (!S.recording) return;
  S.recording = false;
  S.speech?.stop();
  $('#rec').classList.remove('recording');
  if (S.recorder) {
    S.recorder.discard = discard;
    if (S.recorder.state !== 'inactive') S.recorder.stop();
  }
  S.recorder = null;
}

function startRehearse() {
  S.rehearsing = true;
  $('#rehearse').classList.add('on');
  startFollowing();
}
function stopRehearse() {
  if (!S.rehearsing) return;
  S.rehearsing = false;
  S.speech?.stop();
  $('#rehearse').classList.remove('on');
  S.pos = 0;
  S.lastShown = -1;
  scrollTo(0, true);
}

let hintTimer = 0;
function hint(text) {
  const h = $('#recHint');
  h.textContent = text;
  h.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => (h.hidden = true), 2200);
}

// ================================================================ tomas

function openParts() {
  const list = $('#partsList');
  list.replaceChildren(
    ...S.parts.map((p, i) => {
      const t = S.takes.get(i);
      const row = document.createElement('button');
      row.className = `part-row${t ? ' ok' : ''}${i === S.cur ? ' cur' : ''}`;
      row.innerHTML = '<span class="n"></span><p></p><time></time>';
      row.querySelector('.n').textContent = t ? '✓' : String(i + 1);
      row.querySelector('p').textContent = p.text;
      row.querySelector('time').textContent = t ? fmt(t.duration) : 'Sin grabar';
      row.onclick = () => {
        haptic();
        selectPart(i);
        S.closeSheet('#partsSheet');
      };
      return row;
    }),
  );
  const missing = S.parts.length - S.takes.size;
  $('#partsGo').disabled = !S.takes.size;
  $('#partsFine').textContent = missing
    ? `${missing === 1 ? 'Falta 1 parte' : `Faltan ${missing} partes`}: se unirán solo las grabadas. Toca una para grabarla.`
    : 'Toca una parte para repetirla.';
  S.openSheet('#partsSheet');
}

async function finish() {
  const order = [...S.takes.keys()].sort((a, b) => a - b);
  if (!order.length) return;
  S.closeSheet('#partsSheet');
  const blobs = order.map((i) => S.takes.get(i).blob);
  const script = order.map((i) => S.parts[i].text).join('\n\n');
  stopCamera();
  const segs = order.map((i) => ({ text: S.parts[i].text, duration: S.takes.get(i).duration }));
  await S.onDone({ blobs, script, segs, lang: S.set.voiceLang.split('-')[0] });
}

// ================================================================ eventos

function bindCameraUi() {
  $('#recBtn').addEventListener('click', () => {
    if (S.counting) {
      S.counting = false;
      return;
    }
    if (S.recording) stopRecording();
    else startRecording();
  });
  $('#rehearse').addEventListener('click', () => {
    haptic();
    if (S.rehearsing) stopRehearse();
    else startRehearse();
  });
  $('#recDone').addEventListener('click', () => {
    if (!S.takes.size) return hint('Graba al menos una toma');
    haptic();
    openParts();
  });
  $('#partsGo').addEventListener('click', finish);
  $('#partPill').addEventListener('click', openParts);
  $('#partPrev').addEventListener('click', () => {
    haptic();
    stopRehearse();
    selectPart(S.cur - 1);
  });
  $('#partNext').addEventListener('click', () => {
    haptic();
    stopRehearse();
    selectPart(S.cur + 1);
  });
  $('#recClose').addEventListener('click', () => {
    if (S.takes.size && !confirm('¿Salir? Las tomas grabadas se mantienen mientras no cambies el guion.')) return;
    stopRehearse();
    stopCamera();
    S.show('#script');
  });
  $('#recFlip').addEventListener('click', () => {
    haptic();
    S.set.facing = S.set.facing === 'user' ? 'environment' : 'user';
    save();
    startCamera();
  });
  $('#recRatio').addEventListener('click', () => {
    haptic();
    if (S.takes.size && !confirm('Cambiar el formato borra las tomas grabadas. ¿Seguir?')) return;
    S.takes.clear();
    renderPartNav();
    S.set.orientation = S.set.orientation === 'vertical' ? 'horizontal' : 'vertical';
    save();
    renderSettings();
    startCamera();
  });
  $('#recVoice').addEventListener('click', () => {
    haptic();
    const order = ['speech', 'level', 'fixed'];
    S.set.voiceMode = order[(order.indexOf(S.set.voiceMode) + 1) % order.length];
    if (S.set.voiceMode === 'speech' && !speechSupported()) S.set.voiceMode = 'level';
    save();
    applyLook();
    hint({ speech: '🎙 El texto sigue tus palabras', level: '🎙 El texto avanza mientras hablas', fixed: '⏱ Velocidad fija' }[S.set.voiceMode]);
  });
  $('#recGear').addEventListener('click', () => {
    haptic();
    renderSettings();
    S.openSheet('#recSheet');
  });

  // Tocar el texto: pausa/reanuda el ensayo. Tocar la imagen: enfocar. Mantener: bloquear enfoque.
  $('#prompter').addEventListener('click', (e) => {
    if (e.target.closest('#prompterHandle') || S.recording) return;
    if (S.rehearsing) stopRehearse();
    else startRehearse();
  });
  let press = null;
  const stage = $('#recStage');
  $('#rec').addEventListener('pointerdown', (e) => {
    if (e.target.closest('button,.prompter,.sheet')) return;
    const r = stage.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    press = { x: e.clientX, y: e.clientY, u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height, t: setTimeout(() => focus(press, true), 600) };
  });
  const up = () => {
    if (!press) return;
    clearTimeout(press.t);
    if (!press.done) focus(press, false);
    press = null;
  };
  $('#rec').addEventListener('pointerup', up);
  $('#rec').addEventListener('pointercancel', () => {
    if (press) clearTimeout(press.t);
    press = null;
  });

  // Arrastrar la barrita del cuadro de texto = cambiar su alto
  const handle = $('#prompterHandle');
  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    drag = { y: e.clientY, h: $('#prompter').clientHeight };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const vh = window.innerHeight / 100;
    S.set.boxH = Math.round(Math.max(18, Math.min(80, (drag.h + e.clientY - drag.y) / vh)));
    applyLook();
  });
  handle.addEventListener('pointerup', () => {
    drag = null;
    save();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.recording) stopRecording();
  });
  window.addEventListener('resize', () => !$('#rec').hidden && scrollTo(S.pos, true));
}

async function focus(p, lock) {
  if (!p || !S.camera) return;
  p.done = true;
  const ring = $('#focusRing');
  const r = $('#recStage').getBoundingClientRect();
  ring.style.left = `${p.x - r.left}px`;
  ring.style.top = `${p.y - r.top}px`;
  ring.hidden = false;
  ring.classList.toggle('locked', lock);
  ring.style.animation = 'none';
  void ring.offsetWidth;
  ring.style.animation = '';
  const res = await S.camera.focusAt(p.u, p.v);
  if (res === 'unsupported') hint('Este móvil no permite elegir el punto de enfoque desde el navegador');
  if (lock) {
    haptic(25);
    setTimeout(() => S.camera.lockFocus(), 500);
  } else setTimeout(() => (ring.hidden = true), 1200);
}

// ================================================================ ajustes

function bindSettings() {
  for (const b of $$('[data-rtab]')) b.addEventListener('click', () => {
    haptic();
    for (const x of $$('[data-rtab]')) x.setAttribute('aria-selected', String(x === b));
    for (const t of $$('[data-rbody]')) t.hidden = t.dataset.rbody !== b.dataset.rtab;
  });
  for (const r of $$('#recSheet input[type="range"][data-set]')) {
    r.addEventListener('input', () => {
      const k = r.dataset.set;
      S.set[k] = Number(r.value);
      save();
      onChange(k);
      renderSettings();
    });
  }
  for (const seg of $$('#recSheet [data-seg]')) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      haptic();
      const k = seg.dataset.seg;
      let v = b.dataset.v;
      if (['countdown', 'quality', 'fps'].includes(k)) v = Number(v);
      if (k === 'orientation' && v !== S.set.orientation && S.takes.size && !confirm('Cambiar el formato borra las tomas grabadas. ¿Seguir?')) return;
      if (k === 'voiceMode' && v === 'speech' && !speechSupported()) {
        S.toast('Este navegador no reconoce la voz: usa «Mientras hablo» (en Android, Chrome sí lo permite)', 4500);
        v = 'level';
      }
      S.set[k] = v;
      save();
      onChange(k);
      renderSettings();
    });
  }
  for (const sw of $$('#recSheet [data-sw]')) {
    sw.addEventListener('click', () => {
      haptic();
      const k = sw.dataset.sw;
      S.set[k] = !S.set[k];
      save();
      onChange(k);
      renderSettings();
    });
  }
  $('#bgColor').addEventListener('input', (e) => {
    S.set.bgColor = e.target.value;
    save();
    applyBackground();
  });
  $('#bgImage').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    S.bgImage = await createImageBitmap(f);
    S.set.bgMode = 'image';
    save();
    applyBackground();
    renderSettings();
  });
  $('#resetAdjust').addEventListener('click', () => {
    S.set.adjust = {};
    S.set.preset = 'natural';
    save();
    onChange('adjust');
    renderSettings();
  });
}

function onChange(k) {
  if (['fontSize', 'boxH', 'bgA', 'boxPos', 'align', 'mirror', 'voiceMode'].includes(k)) applyLook();
  if (k === 'sens' && S.level) S.level.sensitivity = S.set.sens / 100;
  if (['bgMode', 'bgBlur'].includes(k)) {
    if (S.set.bgMode === 'image' && !S.bgImage) $('#bgImage').click();
    applyBackground();
  }
  if (['preset', 'adjust'].includes(k)) S.camera?.setAdjust({ ...(PRESETS[S.set.preset]?.values || {}), ...S.set.adjust });
  if (['orientation', 'quality', 'fps', 'noiseSuppression', 'echoCancellation', 'autoGainControl'].includes(k)) {
    if (k === 'orientation') {
      S.takes.clear();
      renderPartNav();
    }
    startCamera();
  }
}

function renderSettings() {
  const s = S.set;
  const out = {
    fontSize: `${s.fontSize} px`, wpm: `${s.wpm} palabras/min`, boxH: `${s.boxH} %`, bgA: `${s.bgA} %`,
    sens: `${s.sens} %`, bgBlur: `${s.bgBlur} %`,
  };
  for (const r of $$('#recSheet input[type="range"][data-set]')) {
    r.value = s[r.dataset.set];
    r.style.setProperty('--fill', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
    const o = $(`#o-${r.dataset.set}`);
    if (o) o.textContent = out[r.dataset.set] ?? r.value;
  }
  for (const seg of $$('#recSheet [data-seg]')) {
    for (const b of $$('button', seg)) b.setAttribute('aria-pressed', String(String(s[seg.dataset.seg]) === b.dataset.v));
  }
  for (const sw of $$('#recSheet [data-sw]')) sw.setAttribute('aria-checked', String(!!s[sw.dataset.sw]));
  $('#bgBlurCtl').hidden = s.bgMode !== 'blur';
  $('#bgColorCtl').hidden = s.bgMode !== 'color';
  $('#bgImageCtl').hidden = s.bgMode !== 'image';
  $('#bgNote').hidden = s.bgMode === 'none';
  $('#bgColor').value = s.bgColor;
  $('#voiceNote').textContent = s.voiceMode === 'speech'
    ? speechSupported() ? 'Reconoce lo que dices y va a esa palabra: si te paras, se para; si te saltas una frase, salta. Necesita internet.' : 'Este navegador no reconoce la voz: se usará «Mientras hablo».'
    : s.voiceMode === 'level' ? 'Avanza a la velocidad elegida solo mientras hablas. Funciona sin internet.' : 'Avanza siempre a la velocidad elegida (pestaña Texto).';

  const langs = $('#voiceLangs');
  langs.replaceChildren(...VOICE_LANGS.map(([code, name]) => {
    const b = document.createElement('button');
    b.textContent = name;
    b.setAttribute('aria-pressed', String(code === s.voiceLang));
    b.onclick = () => {
      haptic();
      s.voiceLang = code;
      save();
      renderSettings();
    };
    return b;
  }));
  const chips = $('#presetChips');
  chips.replaceChildren(...Object.entries(PRESETS).map(([k, p]) => {
    const b = document.createElement('button');
    b.textContent = p.label;
    b.setAttribute('aria-pressed', String(k === s.preset));
    b.onclick = () => {
      haptic();
      s.preset = k;
      s.adjust = {};
      save();
      onChange('preset');
      renderSettings();
    };
    return b;
  }));
  const adj = $('#adjusts');
  if (!adj.children.length) {
    adj.className = 'adj-grid';
    for (const [k, [label, min, max]] of Object.entries(ADJUST_LABELS)) {
      const l = document.createElement('label');
      l.className = 'ctl';
      l.innerHTML = `<span>${label} <output></output></span><input type="range" min="${min}" max="${max}" step="0.01">`;
      const r = l.querySelector('input');
      r.dataset.adj = k;
      r.addEventListener('input', () => {
        s.adjust = { ...s.adjust, [k]: Number(r.value) };
        save();
        onChange('adjust');
        paintAdj();
      });
      r.addEventListener('dblclick', () => {
        const { [k]: _, ...rest } = s.adjust;
        s.adjust = rest;
        save();
        onChange('adjust');
        paintAdj();
      });
      adj.append(l);
    }
  }
  paintAdj();
}

function paintAdj() {
  const s = S.set;
  const base = { ...ADJUST_DEFAULTS, ...(PRESETS[s.preset]?.values || {}), ...s.adjust };
  for (const r of $$('#adjusts input')) {
    const v = base[r.dataset.adj] ?? 0;
    r.value = v;
    r.style.setProperty('--fill', `${((v - r.min) / (r.max - r.min)) * 100}%`);
    r.previousElementSibling.querySelector('output').textContent = `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
  }
}

const HW_LABELS = { zoom: 'Zoom', exposureCompensation: 'Compensación de exposición', colorTemperature: 'Balance de blancos (K)', focusDistance: 'Enfoque manual' };
function renderHardware() {
  const box = $('#hardware');
  box.replaceChildren();
  const hw = S.camera?.hardware?.() || {};
  for (const [k, label] of Object.entries(HW_LABELS)) {
    const c = hw[k];
    if (!c) continue;
    const l = document.createElement('label');
    l.className = 'ctl';
    l.innerHTML = `<span>${label} <output></output></span><input type="range">`;
    const r = l.querySelector('input');
    Object.assign(r, { min: c.min, max: c.max, step: c.step, value: c.value });
    const paint = () => {
      r.style.setProperty('--fill', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
      l.querySelector('output').textContent = k === 'zoom' ? `${Number(r.value).toFixed(1)}×` : Number(r.value).toFixed(k === 'colorTemperature' ? 0 : 1);
    };
    paint();
    r.addEventListener('input', () => {
      paint();
      S.camera.setHardware(k, Number(r.value));
    });
    box.append(l);
  }
  if (hw.torch) {
    const row = document.createElement('div');
    row.className = 'ctl ctl-row';
    row.innerHTML = '<span>Linterna</span><button class="switch" role="switch"><i></i></button>';
    const sw = row.querySelector('button');
    sw.setAttribute('aria-checked', String(!!hw.torch.value));
    sw.onclick = () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(on));
      S.camera.setHardware('torch', on);
    };
    box.append(row);
  }
}

// ================================================================ subtítulos con el texto del guion

const norm = (w) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]/g, '');
function sim(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  // distancia de edición normalizada
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/**
 * Alinea las palabras transcritas (con sus tiempos) con el guion y usa la escritura del guion:
 * ortografía, tildes, mayúsculas y puntuación exactas. Lo que se dijo fuera del guion se conserva.
 */
export function alignToScript(words, script) {
  const ref = tokenize(script).map((t) => ({ text: t.text, n: t.norm }));
  const hyp = words.map((w) => norm(w.w));
  const R = ref.length;
  const H = hyp.length;
  if (!R || !H || R * H > 2.5e6) return words;
  // Needleman-Wunsch con puntuación por parecido
  const GAP = -0.6;
  const score = new Float32Array((R + 1) * (H + 1));
  const dir = new Uint8Array((R + 1) * (H + 1));
  const at = (i, j) => i * (H + 1) + j;
  for (let i = 1; i <= R; i++) { score[at(i, 0)] = i * GAP; dir[at(i, 0)] = 1; }
  for (let j = 1; j <= H; j++) { score[at(0, j)] = j * GAP; dir[at(0, j)] = 2; }
  for (let i = 1; i <= R; i++) {
    for (let j = 1; j <= H; j++) {
      const s = sim(ref[i - 1].n, hyp[j - 1]);
      const d = score[at(i - 1, j - 1)] + (s >= 0.5 ? s * 2 - 0.5 : -1);
      const u = score[at(i - 1, j)] + GAP;
      const l = score[at(i, j - 1)] + GAP;
      if (d >= u && d >= l) { score[at(i, j)] = d; dir[at(i, j)] = 0; }
      else if (u >= l) { score[at(i, j)] = u; dir[at(i, j)] = 1; }
      else { score[at(i, j)] = l; dir[at(i, j)] = 2; }
    }
  }
  const out = words.map((w) => ({ ...w }));
  let i = R;
  let j = H;
  while (i > 0 && j > 0) {
    const d = dir[at(i, j)];
    if (d === 0) {
      if (sim(ref[i - 1].n, hyp[j - 1]) >= 0.5) out[j - 1].w = ref[i - 1].text;
      i--;
      j--;
    } else if (d === 1) i--;
    else j--;
  }
  return out;
}

/**
 * Subtítulos a partir del guion cuando no se puede transcribir: cada toma reparte su texto en su duración,
 * con un pequeño margen al principio y al final, según la longitud de cada palabra.
 */
export function scriptTiming(segs) {
  const out = [];
  let offset = 0;
  for (const { text, duration } of segs) {
    const toks = tokenize(text);
    const start = offset + Math.min(0.4, duration * 0.08);
    const end = offset + Math.max(start - offset + 0.2, duration - Math.min(0.5, duration * 0.08));
    const total = toks.reduce((a, w) => a + w.text.length + 2, 0) || 1;
    let t = start;
    for (const w of toks) {
      const d = ((w.text.length + 2) / total) * (end - start);
      out.push({ w: w.text, s: t, e: t + d });
      t += d;
    }
    offset += duration;
  }
  out.fromScript = true;
  return out;
}

export function closeRecorder() {
  stopCamera();
}
