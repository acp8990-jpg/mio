import {
  putClip, getClips, deleteClip, clearClips,
  loadJSON, saveJSON, loadText, saveText, requestPersistence,
} from './storage.js';
import { Camera, outputSize } from './camera.js';
import { ADJUST_DEFAULTS, PRESETS } from './grade.js';
import { tokenize, ScriptMatcher, SpeechFollower, LevelFollower, speechSupported } from './voice.js';

const $ = (id) => document.getElementById(id);
const SCRIPT_KEY = 'teleclip.script';
const SETTINGS_KEY = 'teleclip.settings';

const DEFAULTS = {
  splitMode: 'paragraphs',
  speed: 5,
  fontSize: 34,
  boxHeight: 38,
  bgOpacity: 55,
  countdown: 3,
  quality: 1080,
  orientation: 'vertical',
  fps: 30,
  bitrateLevel: 'high',
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  voiceMode: 'speech',
  voiceLang: 'es-ES',
  voiceSens: 50,
  adjust: {},
  preset: 'natural',
  bgBlur: 0,
  boxPos: {}, // posición del texto por orientación de pantalla: { portrait: {x,y,w}, landscape: {...} } en %
  exportRes: 1080,
  mirror: false,
  autoAdvance: true,
  autoStop: false,
  facing: 'user',
};

const state = {
  settings: loadJSON(SETTINGS_KEY, DEFAULTS),
  segments: [],
  clips: new Map(), // seg -> clip
  current: 0,
  recorder: null,
  words: [],
  spans: [],
  matcher: null,
  readPos: 0,
  following: false,
  activeVoice: 'off',
  voiceSpeaking: false,
  recording: false,
  recStart: 0,
  scrolling: false,
  countingDown: false,
  wakeLock: null,
  exportUrl: null,
  exportFile: null,
  clipUrls: [],
};

// ---------------------------------------------------------------- guion

export function splitScript(text, mode) {
  const t = text.replace(/\r\n?/g, '\n').trim();
  if (!t) return [];
  let parts;
  switch (mode) {
    case 'lines':
      parts = t.split('\n');
      break;
    case 'sentences':
      parts = t.replace(/\s*\n\s*/g, ' ').match(/[^.!?…]+(?:[.!?…]+["'»”)\]]*|$)/g) || [];
      break;
    case 'none':
      parts = [t];
      break;
    default:
      parts = t.split(/\n\s*\n/);
  }
  return parts.map((s) => s.trim()).filter(Boolean);
}

const scriptEl = $('script');
let saveTimer = 0;

function updateSegments() {
  state.segments = splitScript(scriptEl.value, state.settings.splitMode);
  const chars = scriptEl.value.length;
  const words = scriptEl.value.trim() ? scriptEl.value.trim().split(/\s+/).length : 0;
  $('charCount').textContent = `${chars.toLocaleString('es')} caracteres · ${words.toLocaleString('es')} palabras`;
  $('segCount').textContent = `(${state.segments.length})`;
  renderSegPreview();
  $('goRecord').disabled = state.segments.length === 0;
}

function renderSegPreview() {
  const list = $('segPreview');
  list.replaceChildren();
  state.segments.forEach((text, i) => {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'seg-num';
    num.textContent = i + 1;
    const body = document.createElement('span');
    body.className = 'seg-text';
    body.textContent = text;
    const st = document.createElement('span');
    const clip = state.clips.get(i);
    st.className = 'seg-state' + (clip ? ' done' : '');
    st.textContent = clip ? `✓ ${fmtTime(clip.duration)}` : '—';
    li.append(num, body, st);
    li.addEventListener('click', () => openRecorder(i));
    list.append(li);
  });
}

scriptEl.value = loadText(SCRIPT_KEY);
scriptEl.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!saveText(SCRIPT_KEY, scriptEl.value)) toast('No se pudo guardar el guion en este dispositivo');
    updateSegments();
  }, 250);
});

$('splitMode').value = state.settings.splitMode;
$('splitMode').addEventListener('change', (e) => {
  setSetting('splitMode', e.target.value);
  updateSegments();
});

$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  scriptEl.value = await file.text();
  saveText(SCRIPT_KEY, scriptEl.value);
  updateSegments();
  e.target.value = '';
  toast(`Guion importado: ${file.name}`);
});

$('goRecord').addEventListener('click', () => {
  const firstMissing = state.segments.findIndex((_, i) => !state.clips.has(i));
  openRecorder(firstMissing === -1 ? 0 : firstMissing);
});

// ---------------------------------------------------------------- navegación

function showView(name) {
  for (const v of ['script', 'record', 'clips']) $(`view-${v}`).hidden = v !== name;
  $('tabs').hidden = name === 'record';
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'clips') renderClips();
  if (name === 'script') renderSegPreview();
  window.scrollTo(0, 0);
}

document.querySelectorAll('#tabs button').forEach((b) =>
  b.addEventListener('click', () => showView(b.dataset.view)),
);

// ---------------------------------------------------------------- ajustes

function setSetting(key, value) {
  state.settings[key] = value;
  saveJSON(SETTINGS_KEY, state.settings);
  applySettings();
}

const voiceMode = () =>
  state.settings.voiceMode === 'speech' && !speechSupported() ? 'level' : state.settings.voiceMode;

function bitrates() {
  const s = state.settings;
  const { width, height } = outputSize(s.quality, s.orientation);
  const bpp = { standard: 0.08, high: 0.15, max: 0.25 }[s.bitrateLevel] ?? 0.15;
  return {
    video: Math.min(80_000_000, Math.round(width * height * s.fps * bpp)),
    audio: { standard: 128_000, high: 192_000, max: 256_000 }[s.bitrateLevel] ?? 192_000,
    width,
    height,
  };
}

function applySettings() {
  const s = state.settings;
  const p = $('prompter');
  p.style.setProperty('--font', `${s.fontSize}px`);
  p.style.setProperty('--box-h', `${s.boxHeight}vh`);
  p.style.setProperty('--bg-a', String(s.bgOpacity / 100));
  p.classList.toggle('mirror', s.mirror);
  $('speedVal').textContent = s.speed;
  $('fontVal').textContent = `${s.fontSize}px`;
  $('heightVal').textContent = `${s.boxHeight}%`;
  $('boxHeight').value = String(s.boxHeight);
  $('opacityVal').textContent = `${s.bgOpacity}%`;
  $('preview').classList.toggle('mirror', s.facing === 'user');

  const horizontal = s.orientation === 'horizontal';
  const ob = $('orientBtn');
  const icon = document.createElement('span');
  icon.className = `ar ${horizontal ? 'h' : 'v'}`;
  ob.replaceChildren(icon, horizontal ? '16:9' : '9:16');
  $('view-record').classList.toggle('horizontal', horizontal);
  document.querySelectorAll('#orientToggle button').forEach((b) =>
    b.classList.toggle('active', b.dataset.orient === s.orientation),
  );

  const vm = voiceMode();
  $('voiceBtn').textContent = { speech: '🎙 Voz', level: '🎙 Al hablar', off: '⏩ Fijo' }[vm];
  $('voiceBtn').classList.toggle('on', vm !== 'off');
  $('voiceMode').value = vm;
  $('voiceLangField').hidden = vm !== 'speech';
  $('sensField').hidden = vm !== 'level';
  $('micMeter').hidden = vm !== 'level';
  $('sensVal').textContent = `${s.voiceSens}%`;
  $('voiceHelp').textContent = {
    speech: 'El teleprompter escucha y va a la palabra que estás diciendo: si te paras, se para; si te saltas una frase, salta. Necesita conexión a internet.',
    level: 'El texto avanza a la velocidad elegida solo mientras hablas y se detiene en las pausas. Funciona sin conexión.',
    off: 'El texto avanza siempre a la velocidad elegida en la pestaña Texto.',
  }[vm] + (s.voiceMode === 'speech' && !speechSupported()
    ? ' (Este navegador no tiene reconocimiento de voz: usando «mientras hablo».)'
    : '');

  const br = bitrates();
  const mbMin = ((br.video + br.audio) * 60) / 8 / 1e6;
  $('recInfo').textContent =
    `Se grabará a ${br.width}×${br.height} · ${s.fps} fps · ${(br.video / 1e6).toFixed(0)} Mbps (≈${Math.round(mbMin)} MB por minuto).`;
  camera.setAdjust(s.adjust);
  updateRotateHint();
}

function bindRange(id, key) {
  const el = $(id);
  el.value = state.settings[key];
  el.addEventListener('input', () => setSetting(key, Number(el.value)));
}
bindRange('speed', 'speed');
bindRange('fontSize', 'fontSize');
bindRange('boxHeight', 'boxHeight');
bindRange('bgOpacity', 'bgOpacity');
bindRange('voiceSens', 'voiceSens');

function bindCheck(id, key, onChange) {
  const el = $(id);
  el.checked = !!state.settings[key];
  el.addEventListener('change', () => {
    setSetting(key, el.checked);
    onChange?.();
  });
}
const reopenCamera = () => !$('view-record').hidden && !state.recording && startCamera();
bindCheck('mirror', 'mirror');
bindCheck('autoAdvance', 'autoAdvance');
bindCheck('autoStop', 'autoStop');
bindCheck('noiseSuppression', 'noiseSuppression', reopenCamera);
bindCheck('echoCancellation', 'echoCancellation', reopenCamera);
bindCheck('autoGainControl', 'autoGainControl', reopenCamera);

function bindSelect(id, key, { numeric = false, onChange } = {}) {
  const el = $(id);
  el.value = String(state.settings[key]);
  el.addEventListener('change', () => {
    setSetting(key, numeric ? Number(el.value) : el.value);
    onChange?.();
  });
}
bindSelect('countdownSel', 'countdown', { numeric: true });
bindSelect('quality', 'quality', { numeric: true, onChange: reopenCamera });
bindSelect('fps', 'fps', { numeric: true, onChange: reopenCamera });
bindSelect('bitrateLevel', 'bitrateLevel');
bindSelect('voiceLang', 'voiceLang');
bindSelect('voiceMode', 'voiceMode', { onChange: restartVoiceIfActive });

$('exportRes').value = String(state.settings.exportRes);
$('exportRes').addEventListener('change', (e) => {
  const v = e.target.value;
  setSetting('exportRes', v === 'original' ? 'original' : Number(v));
});

function setOrientation(o) {
  if (state.recording || state.settings.orientation === o) return;
  setSetting('orientation', o);
  reopenCamera();
}
document.querySelectorAll('#orientToggle button').forEach((b) =>
  b.addEventListener('click', () => setOrientation(b.dataset.orient)),
);
$('orientBtn').addEventListener('click', () =>
  setOrientation(state.settings.orientation === 'horizontal' ? 'vertical' : 'horizontal'),
);

$('voiceBtn').addEventListener('click', () => {
  const order = speechSupported() ? ['speech', 'level', 'off'] : ['level', 'off'];
  const next = order[(order.indexOf(voiceMode()) + 1) % order.length];
  setSetting('voiceMode', next);
  toast({ speech: 'El texto sigue tus palabras', level: 'El texto avanza mientras hablas', off: 'Velocidad fija' }[next]);
  restartVoiceIfActive();
});

// Pestañas del panel de ajustes
document.querySelectorAll('.tabs-inline button').forEach((b) =>
  b.addEventListener('click', () => showSettingsTab(b.dataset.tab)),
);
function showSettingsTab(tab) {
  document.querySelectorAll('.tabs-inline button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  $('settings').classList.toggle('compact', tab === 'image');
  if (tab === 'voice') startMeter();
  else stopMeter();
}

$('openSettings').addEventListener('click', () => {
  if (state.recording) return;
  $('settings').hidden = false;
  const active = document.querySelector('.tabs-inline button.active')?.dataset.tab ?? 'text';
  showSettingsTab(active);
});
$('closeSettings').addEventListener('click', () => {
  $('settings').hidden = true;
  stopMeter();
});

// ---------------------------------------------------------------- imagen

const ADJUSTERS = [
  ['exposure', 'Exposición', -2, 2],
  ['brightness', 'Brillo', -1, 1],
  ['contrast', 'Contraste', -1, 1],
  ['highlights', 'Luces', -1, 1],
  ['shadows', 'Sombras', -1, 1],
  ['saturation', 'Saturación', -1, 1],
  ['vibrance', 'Intensidad del color', -1, 1],
  ['temperature', 'Temperatura', -1, 1],
  ['tint', 'Tinte', -1, 1],
  ['sharpness', 'Nitidez', 0, 1],
  ['smoothing', 'Suavizar piel', 0, 1],
  ['vignette', 'Viñeta', 0, 1],
];

function buildImagePanel() {
  const chips = $('presets');
  for (const [key, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.preset = key;
    b.textContent = p.label;
    b.addEventListener('click', () => {
      setSetting('adjust', { ...ADJUST_DEFAULTS, ...p.values });
      setSetting('preset', key);
      syncImagePanel();
    });
    chips.append(b);
  }
  const box = $('adjustSliders');
  for (const [key, label, min, max] of ADJUSTERS) {
    const wrap = document.createElement('label');
    wrap.className = 'slider';
    const head = document.createElement('span');
    head.append(label + ' ');
    const val = document.createElement('b');
    val.id = `adj-${key}-val`;
    head.append(val);
    const input = document.createElement('input');
    input.type = 'range';
    input.id = `adj-${key}`;
    input.min = String(min * 100);
    input.max = String(max * 100);
    input.step = '1';
    input.addEventListener('input', () => {
      setSetting('adjust', { ...state.settings.adjust, [key]: Number(input.value) / 100 });
      setSetting('preset', null);
      syncImagePanel();
    });
    input.addEventListener('dblclick', () => {
      setSetting('adjust', { ...state.settings.adjust, [key]: 0 });
      syncImagePanel();
    });
    wrap.append(head, input);
    box.append(wrap);
  }
  const blur = $('bgBlur');
  blur.value = String(Math.round(state.settings.bgBlur * 100));
  blur.addEventListener('input', () => {
    setSetting('bgBlur', Number(blur.value) / 100);
    applyBackgroundBlur();
  });
  document.querySelectorAll('#focusToggle button').forEach((b) =>
    b.addEventListener('click', () => (b.dataset.focus === 'lock' ? lockFocus() : unlockFocus())),
  );
  $('resetAdjust').addEventListener('click', () => {
    setSetting('adjust', { ...ADJUST_DEFAULTS });
    setSetting('preset', 'natural');
    syncImagePanel();
  });
  syncImagePanel();
}

function syncImagePanel() {
  const a = { ...ADJUST_DEFAULTS, ...state.settings.adjust };
  for (const [key] of ADJUSTERS) {
    const v = Math.round(a[key] * 100);
    $(`adj-${key}`).value = String(v);
    $(`adj-${key}-val`).textContent = v > 0 && key !== 'sharpness' && key !== 'smoothing' && key !== 'vignette' ? `+${v}` : String(v);
  }
  document.querySelectorAll('#presets button').forEach((b) =>
    b.classList.toggle('active', b.dataset.preset === state.settings.preset),
  );
  const bb = Math.round(state.settings.bgBlur * 100);
  $('bgBlur').value = String(bb);
  $('bgBlurVal').textContent = bb ? String(bb) : 'No';
}

// ---------------------------------------------------------------- fondo desenfocado

let blurLoadToken = 0;
async function applyBackgroundBlur() {
  const amount = state.settings.bgBlur;
  $('bgBlurVal').textContent = amount ? String(Math.round(amount * 100)) : 'No';
  const status = $('bgBlurStatus');
  if (!camera.grader.usesGpu) {
    status.textContent = 'Este dispositivo no admite el desenfoque de fondo (necesita WebGL).';
    return;
  }
  if (amount > 0 && !camera.mask.ready) {
    const token = ++blurLoadToken;
    status.textContent = 'Preparando el desenfoque (solo la primera vez, ~15 MB)…';
    try {
      await camera.setBackgroundBlur(amount);
      if (token === blurLoadToken) status.textContent = 'Fondo desenfocado: detecta a la persona y difumina el resto.';
    } catch (err) {
      console.error(err);
      status.textContent = 'No se pudo activar el desenfoque de fondo en este dispositivo.';
      camera.bgBlur = 0;
    }
    return;
  }
  camera.setBackgroundBlur(amount);
  status.textContent = amount > 0 ? 'Fondo desenfocado: detecta a la persona y difumina el resto.' : '';
}

// ---------------------------------------------------------------- enfoque

state.focusLocked = false;
let focusWarned = false;

function showFocusRing(x, y, locked) {
  const ring = $('focusRing');
  ring.hidden = true;
  ring.classList.toggle('locked', locked);
  ring.style.left = `${x}px`;
  ring.style.top = `${y}px`;
  void ring.offsetWidth; // reinicia la animación
  ring.hidden = false;
  clearTimeout(showFocusRing.t);
  if (!locked) showFocusRing.t = setTimeout(() => (ring.hidden = true), 1400);
}

function syncFocusUi() {
  $('focusBadge').hidden = !state.focusLocked;
  document.querySelectorAll('#focusToggle button').forEach((b) =>
    b.classList.toggle('active', (b.dataset.focus === 'lock') === state.focusLocked),
  );
  const f = camera.focusSupport();
  $('focusHelp').textContent = !f.modes.length
    ? 'Este navegador no deja controlar el enfoque (en iPhone siempre es automático). Toca la imagen igualmente: en Android con Chrome sí funciona.'
    : f.point
      ? 'Toca la imagen para enfocar ahí. Mantén pulsado para bloquear el enfoque.'
      : 'Toca la imagen para volver a enfocar. Mantén pulsado para bloquear el enfoque.';
}

async function lockFocus(x, y) {
  if (await camera.lockFocus()) {
    state.focusLocked = true;
    if (x !== undefined) showFocusRing(x, y, true);
    toast('Enfoque y exposición bloqueados');
  } else toast('Esta cámara no permite bloquear el enfoque');
  syncFocusUi();
}

async function unlockFocus() {
  state.focusLocked = false;
  $('focusRing').hidden = true;
  await camera.focusAuto();
  syncFocusUi();
}

/** Convierte un toque en pantalla a coordenadas 0..1 del encuadre grabado (canvas con object-fit: contain). */
function tapToFrame(clientX, clientY) {
  const el = $('preview');
  const r = el.getBoundingClientRect();
  const cw = el.width;
  const ch = el.height;
  const scale = Math.min(r.width / cw, r.height / ch);
  const w = cw * scale;
  const h = ch * scale;
  let u = (clientX - r.left - (r.width - w) / 2) / w;
  const v = (clientY - r.top - (r.height - h) / 2) / h;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  if (state.settings.facing === 'user') u = 1 - u; // la vista previa frontal va en espejo
  return { u, v };
}

{
  const preview = $('preview');
  let pressTimer = 0;
  let start = null;
  preview.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, y: e.clientY, long: false };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      if (!start) return;
      start.long = true;
      const { x, y } = start;
      const p = tapToFrame(x, y);
      if (!p) return;
      // Enfoca en ese punto, deja que la cámara ajuste y bloquea.
      showFocusRing(x, y, false);
      camera.focusAt(p.u, p.v).then(() => setTimeout(() => lockFocus(x, y), 600));
    }, 600);
  });
  preview.addEventListener('pointerup', async (e) => {
    clearTimeout(pressTimer);
    if (!start || start.long || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12) {
      start = null;
      return;
    }
    start = null;
    if (!$('settings').hidden && !$('settings').classList.contains('compact')) return;
    const p = tapToFrame(e.clientX, e.clientY);
    if (!p) return;
    state.focusLocked = false;
    showFocusRing(e.clientX, e.clientY, false);
    const result = await camera.focusAt(p.u, p.v);
    syncFocusUi();
    if (result === 'unsupported' && !focusWarned) {
      focusWarned = true;
      toast('Tu navegador no deja elegir el punto de enfoque; la cámara enfoca sola');
    }
  });
  preview.addEventListener('pointercancel', () => {
    clearTimeout(pressTimer);
    start = null;
  });
}

/** Controles propios de la cámara del móvil (solo los que el dispositivo admite). */
function renderHardware() {
  const box = $('hwControls');
  box.replaceChildren();
  const hw = camera.hardware();
  const rows = [];
  const slider = (key, label, cfg, fmt = (v) => v.toFixed(1)) => {
    const wrap = document.createElement('label');
    wrap.className = 'slider';
    const head = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = fmt(cfg.value);
    head.append(label + ' ', b);
    const input = document.createElement('input');
    input.type = 'range';
    Object.assign(input, { min: cfg.min, max: cfg.max, step: cfg.step, value: cfg.value });
    input.addEventListener('input', () => {
      b.textContent = fmt(Number(input.value));
      camera.setHardware(key, Number(input.value));
    });
    wrap.append(head, input);
    rows.push(wrap);
    return input;
  };
  const autoToggle = (label, onAuto) => {
    const l = document.createElement('label');
    l.className = 'check';
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = true;
    l.append(c, ` ${label}`);
    rows.push(l);
    return c;
  };
  if (hw.zoom) slider('zoom', 'Zoom', hw.zoom, (v) => `${v.toFixed(1)}×`);
  if (hw.exposureCompensation) slider('exposureCompensation', 'Exposición de la cámara', hw.exposureCompensation);
  if (hw.colorTemperature) {
    const auto = autoToggle('Balance de blancos automático');
    const input = slider('colorTemperature', 'Balance de blancos', hw.colorTemperature, (v) => `${Math.round(v)} K`);
    input.disabled = true;
    auto.addEventListener('change', () => {
      input.disabled = auto.checked;
      camera.setHardware('colorTemperature', auto.checked ? 0 : Number(input.value));
    });
  }
  if (hw.focusDistance) {
    const auto = autoToggle('Enfoque automático');
    const input = slider('focusDistance', 'Enfoque manual', hw.focusDistance, (v) => v.toFixed(2));
    input.disabled = true;
    auto.addEventListener('change', () => {
      input.disabled = auto.checked;
      camera.setHardware('focusDistance', auto.checked ? 0 : Number(input.value));
    });
  }
  if (hw.torch) {
    const l = document.createElement('label');
    l.className = 'check';
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = hw.torch.value;
    c.addEventListener('change', () => camera.setHardware('torch', c.checked));
    l.append(c, ' Linterna / luz');
    rows.push(l);
  }
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Este navegador no deja ajustar la cámara directamente. Usa los ajustes de imagen de arriba.';
    rows.push(p);
  }
  box.append(...rows);
}

// ---------------------------------------------------------------- cámara

const camera = new Camera($('preview'));

function pickMime() {
  // MP4 solo si es H.264 de verdad (se une sin recodificar). Un «video/mp4» genérico en Chrome puede
  // salir como VP9-en-MP4 con metadatos que luego no se pueden decodificar, así que va al final (Safari).
  const candidates = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.4D401F,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

function stopCamera() {
  camera.close();
}

async function startCamera() {
  $('camError').hidden = true;
  const s = state.settings;
  try {
    await camera.open({
      facing: s.facing,
      orientation: s.orientation,
      quality: s.quality,
      fps: s.fps,
      audio: {
        noiseSuppression: s.noiseSuppression,
        echoCancellation: s.echoCancellation,
        autoGainControl: s.autoGainControl,
      },
    });
    camera.setAdjust(s.adjust);
    renderHardware();
    state.focusLocked = false;
    syncFocusUi();
    if (s.bgBlur > 0) applyBackgroundBlur();
  } catch (err) {
    console.error(err);
    const el = $('camError');
    el.textContent =
      err?.name === 'NotAllowedError'
        ? 'Necesito permiso para usar la cámara y el micrófono. Actívalo en los ajustes del navegador.'
        : `No se pudo abrir la cámara (${err?.name || err}). La app necesita HTTPS o localhost.`;
    el.hidden = false;
  }
  updateRotateHint();
}

function updateRotateHint() {
  const touch = matchMedia('(pointer: coarse)').matches;
  const portraitScreen = innerHeight >= innerWidth;
  const wantH = state.settings.orientation === 'horizontal';
  const hint = $('rotateHint');
  hint.hidden = !touch || $('view-record').hidden || portraitScreen !== wantH;
  hint.textContent = wantH
    ? 'Gira el móvil para grabar en horizontal con toda la calidad'
    : 'Pon el móvil en vertical para grabar en 9:16 con toda la calidad';
}
addEventListener('resize', updateRotateHint);

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => (state.wakeLock = null));
    } else if (!on && state.wakeLock) {
      await state.wakeLock.release();
      state.wakeLock = null;
    }
  } catch {
    /* sin wake lock */
  }
}

$('flipCam').addEventListener('click', async () => {
  if (state.recording) return;
  setSetting('facing', state.settings.facing === 'user' ? 'environment' : 'user');
  await startCamera();
});

// ---------------------------------------------------------------- teleprompter

const scroller = $('prompterScroll');
let lastFrame = 0;
let carry = 0;
let endTimer = 0;

/** Pinta el fragmento palabra a palabra para poder resaltar y seguir la lectura. */
function renderPrompterText(text) {
  const el = $('prompterText');
  el.replaceChildren();
  state.words = tokenize(text);
  state.spans = [];
  let last = 0;
  for (const w of state.words) {
    if (w.start > last) el.append(text.slice(last, w.start));
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = text.slice(w.start, w.end);
    el.append(span);
    state.spans.push(span);
    last = w.end;
  }
  if (last < text.length) el.append(text.slice(last));
  state.matcher = new ScriptMatcher(state.words);
  state.readPos = 0;
  scroller.scrollTop = 0;
  carry = 0;
}

function setReadPos(pos) {
  const spans = state.spans;
  const old = state.readPos;
  pos = Math.max(0, Math.min(pos, spans.length));
  if (pos === old) return;
  if (pos > old) for (let i = old; i < pos; i++) spans[i].classList.add('read');
  else for (let i = pos; i < old; i++) spans[i].classList.remove('read');
  spans[old]?.classList.remove('cur');
  spans[pos]?.classList.add('cur');
  state.readPos = pos;
  if (pos >= spans.length) onTextEnd();
}

function onTextEnd() {
  if (state.recording && state.settings.autoStop) {
    clearTimeout(endTimer);
    endTimer = setTimeout(() => state.recording && stopRecording(), 1200);
  }
}

function loadSegment(i) {
  stopFollowing();
  state.current = Math.max(0, Math.min(i, state.segments.length - 1));
  renderPrompterText(state.segments[state.current] ?? '');
  const has = state.clips.has(state.current);
  $('segLabel').textContent =
    `Clip ${state.current + 1} / ${state.segments.length}` + (has ? ' · ✓ grabado (se reemplazará)' : '');
  $('prevSeg').disabled = state.current === 0;
  $('nextSeg').disabled = state.current >= state.segments.length - 1;
}

/** Posición de scroll que deja la palabra `i` sobre la línea de lectura. */
function scrollTargetFor(i) {
  const span = state.spans[Math.min(i, state.spans.length - 1)];
  if (!span) return 0;
  return span.offsetTop + span.offsetHeight / 2 - scroller.clientHeight * 0.3;
}

function setScrolling(on) {
  state.scrolling = on;
  $('rehearse').textContent = state.following && !state.recording ? '⏸' : '▶';
  $('pausedBadge').hidden = on || !state.following;
  if (on) {
    lastFrame = performance.now();
    requestAnimationFrame(tick);
  }
}

function tick(now) {
  if (!state.scrolling) return;
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const mode = state.activeVoice;
  const atEnd = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;

  if (mode === 'speech') {
    // Desplazamiento suave hacia la palabra que se está diciendo.
    const target = Math.max(0, scrollTargetFor(state.readPos));
    const diff = target - scroller.scrollTop;
    if (Math.abs(diff) > 0.5) {
      carry += diff * Math.min(1, dt * 5);
      const whole = Math.trunc(carry);
      if (whole) {
        scroller.scrollTop += whole;
        carry -= whole;
      }
    }
  } else {
    const moving = mode !== 'level' || state.voiceSpeaking;
    if (moving) {
      carry += state.settings.speed * 8 * dt;
      const whole = Math.floor(carry);
      if (whole > 0) {
        scroller.scrollTop += whole;
        carry -= whole;
      }
      // Resaltado aproximado de lo ya leído en los modos sin reconocimiento.
      const line = scroller.scrollTop + scroller.clientHeight * 0.3;
      let p = state.readPos;
      while (p < state.spans.length && state.spans[p].offsetTop + state.spans[p].offsetHeight / 2 < line) p++;
      if (p !== state.readPos) setReadPos(p);
    }
    if (atEnd()) {
      setReadPos(state.spans.length);
      setScrolling(false);
      $('pausedBadge').hidden = true;
      return;
    }
  }
  requestAnimationFrame(tick);
}

// Tocar el texto pausa / reanuda. Arrastrarlo lo mueve a mano (y la lectura se resincroniza).
let downY = null;
scroller.addEventListener('pointerdown', (e) => (downY = e.clientY));
scroller.addEventListener('pointerup', (e) => {
  if (downY === null || state.countingDown) return;
  const moved = Math.abs(e.clientY - downY) >= 8;
  downY = null;
  if (!moved) {
    if (state.following) setScrolling(!state.scrolling);
    return;
  }
  // Tras arrastrar: la palabra que queda en la línea de lectura pasa a ser la actual.
  setTimeout(() => {
    const line = scroller.scrollTop + scroller.clientHeight * 0.3;
    let idx = state.spans.findIndex((s) => s.offsetTop + s.offsetHeight / 2 >= line);
    if (idx < 0) idx = state.spans.length;
    state.matcher?.reset(idx);
    setReadPos(idx);
    carry = 0;
  }, 120);
});

// ---------------------------------------------------------------- mover / redimensionar el texto

const prompterEl = $('prompter');
const screenKey = () => (innerHeight >= innerWidth ? 'portrait' : 'landscape');
const clamp = (v, min, max) => Math.min(Math.max(v, min), Math.max(min, max));

/** Coloca el cuadro según lo guardado para esta orientación de pantalla (o la posición por defecto). */
function applyBoxPos() {
  const pos = state.settings.boxPos?.[screenKey()];
  const st = prompterEl.style;
  if (!pos) {
    st.left = st.top = st.width = st.right = '';
    return;
  }
  const W = innerWidth;
  const H = innerHeight;
  const w = clamp((pos.w / 100) * W, 140, W);
  const h = prompterEl.offsetHeight;
  st.right = 'auto';
  st.width = `${w}px`;
  st.left = `${clamp((pos.x / 100) * W, 0, W - w)}px`;
  st.top = `${clamp((pos.y / 100) * H, 0, H - Math.min(h, H))}px`;
}

function saveBoxPos() {
  const r = prompterEl.getBoundingClientRect();
  const W = innerWidth;
  const H = innerHeight;
  setSetting('boxPos', {
    ...state.settings.boxPos,
    [screenKey()]: { x: (r.left / W) * 100, y: (r.top / H) * 100, w: (r.width / W) * 100 },
  });
}

function dragBehaviour(handle, onMove) {
  let start = null;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const r = prompterEl.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height };
    prompterEl.classList.add('moving');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    onMove(start, e.clientX - start.x, e.clientY - start.y);
  });
  const end = () => {
    if (!start) return;
    start = null;
    prompterEl.classList.remove('moving');
    saveBoxPos();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// Asa superior: mover a cualquier sitio de la pantalla.
dragBehaviour($('dragHandle'), (s, dx, dy) => {
  const st = prompterEl.style;
  st.right = 'auto';
  st.width = `${s.w}px`;
  st.left = `${clamp(s.left + dx, 0, innerWidth - s.w)}px`;
  st.top = `${clamp(s.top + dy, 0, innerHeight - s.h)}px`;
});

// Esquina inferior derecha: ancho y alto.
dragBehaviour($('resizeHandle'), (s, dx, dy) => {
  const st = prompterEl.style;
  st.right = 'auto';
  st.left = `${s.left}px`;
  st.top = `${s.top}px`;
  st.width = `${clamp(s.w + dx, 140, innerWidth - s.left)}px`;
  const h = clamp(s.h + dy, innerHeight * 0.12, Math.min(innerHeight * 0.95, innerHeight - s.top));
  state.settings.boxHeight = Math.round((h / innerHeight) * 100);
  prompterEl.style.setProperty('--box-h', `${state.settings.boxHeight}vh`);
  $('heightVal').textContent = `${state.settings.boxHeight}%`;
});

$('resetBox').addEventListener('click', () => {
  setSetting('boxPos', { ...state.settings.boxPos, [screenKey()]: undefined });
  setSetting('boxHeight', DEFAULTS.boxHeight);
  applyBoxPos();
  toast('Texto colocado en su sitio de siempre');
});

addEventListener('resize', applyBoxPos);

// ---------------------------------------------------------------- seguir la voz

const level = new LevelFollower({
  onSpeaking: (on) => {
    state.voiceSpeaking = on;
    $('voiceBadge').classList.toggle('live', on);
  },
});
let speech = null;

/** Empieza a mover el texto (ensayo o grabación) con el modo de voz elegido. */
function startFollowing() {
  state.following = true;
  state.voiceSpeaking = false;
  state.activeVoice = voiceMode();
  const badge = $('voiceBadge');
  badge.hidden = state.activeVoice === 'off';
  badge.classList.remove('live', 'error');
  $('voiceBadgeText').textContent = state.activeVoice === 'speech' ? 'Escuchando…' : 'Avanza al hablar';
  level.sensitivity = state.settings.voiceSens / 100;

  if (state.activeVoice === 'speech') {
    speech = new SpeechFollower({
      lang: state.settings.voiceLang,
      onWords: (words) => {
        $('voiceBadge').classList.add('live');
        setReadPos(state.matcher.update(words));
      },
      onError: (code) => {
        console.warn('Reconocimiento de voz:', code);
        if (!state.following) return;
        // Plan B sin cortar la toma: avanzar mientras hablas.
        state.activeVoice = 'level';
        $('voiceBadgeText').textContent = 'Avanza al hablar';
        level.start(camera.stream);
        toast(
          code === 'not-allowed' || code === 'service-not-allowed'
            ? 'Sin permiso de reconocimiento de voz: el texto avanzará mientras hablas'
            : 'El reconocimiento de voz no está disponible ahora: el texto avanzará mientras hablas',
        );
      },
    });
    speech.start();
  } else if (state.activeVoice === 'level') {
    level.start(camera.stream);
  }
  setScrolling(true);
}

function stopFollowing() {
  state.following = false;
  speech?.stop();
  speech = null;
  if (!meterOn) level.stop();
  setScrolling(false);
  $('voiceBadge').hidden = true;
  $('pausedBadge').hidden = true;
  $('rehearse').textContent = '▶';
}

function restartVoiceIfActive() {
  if (!state.following) return;
  const pos = state.readPos;
  speech?.stop();
  speech = null;
  level.stop();
  startFollowing();
  state.matcher.reset(pos);
}

// Medidor del micrófono en la pestaña «Voz»
let meterOn = false;
let meterTimer = 0;
function startMeter() {
  if (meterOn || !camera.stream) return;
  meterOn = true;
  level.prime();
  if (!state.following) level.start(camera.stream);
  meterTimer = setInterval(() => {
    const bar = $('micMeter').firstElementChild;
    bar.style.width = `${Math.min(100, Math.sqrt(level.level) * 220)}%`;
    bar.classList.toggle('on', level.speaking);
  }, 80);
}
function stopMeter() {
  if (!meterOn) return;
  meterOn = false;
  clearInterval(meterTimer);
  if (!state.following || state.activeVoice !== 'level') level.stop();
}

$('rehearse').addEventListener('click', () => {
  if (state.recording || state.countingDown) return;
  if (state.following) return stopFollowing();
  level.prime();
  if (state.readPos >= state.spans.length) renderPrompterText(state.segments[state.current] ?? '');
  startFollowing();
  $('rehearse').textContent = '⏸';
});

$('prevSeg').addEventListener('click', () => {
  if (state.recording) return;
  loadSegment(state.current - 1);
});
$('nextSeg').addEventListener('click', () => {
  if (state.recording) return;
  loadSegment(state.current + 1);
});

// ---------------------------------------------------------------- grabación

let timerInterval = 0;

async function runCountdown(seconds) {
  if (!seconds) return true;
  state.countingDown = true;
  const el = $('countdown');
  el.hidden = false;
  for (let n = seconds; n > 0; n--) {
    el.textContent = n;
    await new Promise((r) => setTimeout(r, 1000));
    if (!state.countingDown) break;
  }
  el.hidden = true;
  const ok = state.countingDown;
  state.countingDown = false;
  return ok;
}

async function startRecording() {
  if (!camera.stream) await startCamera();
  if (!camera.stream) return;
  const mime = pickMime();
  if (mime === null) {
    toast('Este navegador no permite grabar vídeo');
    return;
  }
  $('settings').hidden = true;
  stopMeter();
  stopFollowing();
  renderPrompterText(state.segments[state.current] ?? '');
  $('recBtn').classList.add('recording');

  if (!(await runCountdown(state.settings.countdown))) {
    $('recBtn').classList.remove('recording');
    return;
  }

  const br = bitrates();
  const chunks = [];
  const rec = new MediaRecorder(camera.recordStream(), {
    ...(mime ? { mimeType: mime } : {}),
    videoBitsPerSecond: br.video,
    audioBitsPerSecond: br.audio,
  });
  const seg = state.current;
  const text = state.segments[seg];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    const duration = (performance.now() - state.recStart) / 1000;
    const type = rec.mimeType || mime || 'video/webm';
    const blob = new Blob(chunks, { type });
    const clip = { seg, text, blob, mime: type, duration, createdAt: Date.now(), width: br.width, height: br.height };
    try {
      await putClip(clip);
      state.clips.set(seg, clip);
      updateBadge();
      afterClipSaved(seg);
    } catch (err) {
      console.error(err);
      toast('No se pudo guardar el clip (¿almacenamiento lleno?)');
    }
  };
  state.recorder = rec;
  rec.start(1000);
  state.recording = true;
  state.recStart = performance.now();
  $('recTimer').hidden = false;
  $('recTimer').textContent = '00:00';
  timerInterval = setInterval(() => {
    $('recTimer').textContent = fmtTime((performance.now() - state.recStart) / 1000);
  }, 250);
  startFollowing();
}

function stopRecording() {
  clearTimeout(endTimer);
  clearInterval(timerInterval);
  stopFollowing();
  state.recording = false;
  $('recBtn').classList.remove('recording');
  $('recTimer').hidden = true;
  if (state.recorder?.state !== 'inactive') state.recorder?.stop();
  state.recorder = null;
}

function afterClipSaved(seg) {
  const isLast = seg >= state.segments.length - 1;
  if (isLast) {
    const missing = state.segments.findIndex((_, i) => !state.clips.has(i));
    toast(missing === -1 ? '¡Todos los clips grabados! Ve a «Clips» para unirlos' : `Clip ${seg + 1} guardado`);
    loadSegment(seg);
    return;
  }
  toast(`Clip ${seg + 1} guardado`);
  if (state.settings.autoAdvance && !$('view-record').hidden) loadSegment(seg + 1);
  else loadSegment(seg);
}

$('recBtn').addEventListener('click', () => {
  if (state.countingDown) {
    state.countingDown = false;
    return;
  }
  if (state.recording) stopRecording();
  else {
    level.prime(); // el audio debe activarse dentro del toque (iOS)
    startRecording();
  }
});

async function openRecorder(i) {
  if (!state.segments.length) return;
  showView('record');
  applySettings();
  applyBoxPos();
  loadSegment(i);
  try {
    if (!localStorage.getItem('teleclip.hint.box')) {
      localStorage.setItem('teleclip.hint.box', '1');
      toast('Arrastra la barrita de arriba del texto para moverlo, y la esquina para cambiar su tamaño');
    }
  } catch {
    /* sin almacenamiento */
  }
  await startCamera();
  keepAwake(true);
}

function closeRecorder() {
  if (state.recording) stopRecording();
  state.countingDown = false;
  stopMeter();
  stopFollowing();
  $('settings').hidden = true;
  // Esperamos un instante para que el último clip termine de escribirse antes de soltar la cámara.
  setTimeout(stopCamera, 300);
  keepAwake(false);
}

$('recBack').addEventListener('click', () => {
  closeRecorder();
  showView('script');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.recording) stopRecording();
  if (!document.hidden && !$('view-record').hidden) keepAwake(true);
});

// ---------------------------------------------------------------- clips

function updateBadge() {
  const n = state.clips.size;
  $('clipBadge').hidden = n === 0;
  $('clipBadge').textContent = n;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const extOf = (mime) => (mime?.includes('mp4') ? 'mp4' : 'webm');

function orderedClips() {
  return [...state.clips.values()].sort((a, b) => a.seg - b.seg);
}

function renderClips() {
  state.clipUrls.forEach((u) => URL.revokeObjectURL(u));
  state.clipUrls = [];
  const list = $('clipList');
  list.replaceChildren();
  const total = Math.max(state.segments.length, ...[...state.clips.keys()].map((k) => k + 1), 0);

  if (total === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Todavía no hay guion ni clips. Escribe tu guion en la pestaña «Guion».';
    list.append(li);
  }

  for (let i = 0; i < total; i++) {
    const clip = state.clips.get(i);
    const segText = state.segments[i];
    const li = document.createElement('li');
    li.className = 'clip';

    const head = document.createElement('div');
    head.className = 'clip-head';
    const num = document.createElement('span');
    num.className = 'seg-num';
    num.textContent = i + 1;
    const txt = document.createElement('span');
    txt.className = 'seg-text';
    txt.textContent = segText ?? clip?.text ?? '';
    head.append(num, txt);
    li.append(head);

    if (clip) {
      if (segText === undefined || segText !== clip.text) {
        const w = document.createElement('div');
        w.className = 'warn';
        w.textContent = segText === undefined
          ? 'Este fragmento ya no existe en el guion.'
          : 'El texto del guion cambió desde esta toma.';
        li.append(w);
      }
      const url = URL.createObjectURL(clip.blob);
      state.clipUrls.push(url);
      const v = document.createElement('video');
      v.src = url;
      v.controls = true;
      v.playsInline = true;
      v.preload = 'metadata';
      li.append(v);
    }

    const row = document.createElement('div');
    row.className = 'row';
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = clip ? fmtTime(clip.duration) : 'Sin grabar';
    row.append(meta);
    if (segText !== undefined) {
      row.append(button(clip ? 'Regrabar' : '● Grabar', clip ? 'ghost' : 'primary', () => openRecorder(i)));
    }
    if (clip) {
      row.append(
        button('Descargar', 'ghost', () =>
          download(clip.blob, `teleclip-clip-${String(i + 1).padStart(2, '0')}.${extOf(clip.mime)}`),
        ),
        button('Borrar', 'ghost danger', async () => {
          if (!confirm(`¿Borrar el clip ${i + 1}?`)) return;
          await deleteClip(i);
          state.clips.delete(i);
          updateBadge();
          renderClips();
        }),
      );
    }
    li.append(row);
    list.append(li);
  }

  const n = state.clips.size;
  $('exportBtn').disabled = n === 0;
  $('exportBtn').textContent = n ? `Unir ${n} clip${n > 1 ? 's' : ''} y exportar` : 'Unir clips y exportar';
  $('clearAll').disabled = n === 0;
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

$('clearAll').addEventListener('click', async () => {
  if (!confirm('¿Borrar todos los clips grabados? No se puede deshacer.')) return;
  await clearClips();
  state.clips.clear();
  updateBadge();
  renderClips();
});

$('exportBtn').addEventListener('click', async () => {
  const clips = orderedClips();
  if (!clips.length) return;
  const bar = $('exportProgress');
  const status = $('exportStatus');
  $('exportBtn').disabled = true;
  $('exportResult').hidden = true;
  bar.hidden = false;
  bar.firstElementChild.style.width = '0%';
  status.textContent = 'Uniendo clips en tu dispositivo…';
  try {
    const { joinClips } = await import('./export.js');
    const resolution = state.settings.exportRes;
    if (resolution !== 'original') status.textContent = `Reescalando a ${resolution}p y codificando MP4…`;
    const result = await joinClips(
      clips.map((c) => c.blob),
      {
        resolution,
        onProgress: (p) => (bar.firstElementChild.style.width = `${Math.round(p * 100)}%`),
      },
    );
    if (state.exportUrl) URL.revokeObjectURL(state.exportUrl);
    state.exportUrl = URL.createObjectURL(result.blob);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    state.exportFile = new File([result.blob], `teleclip-${stamp}.${result.ext}`, { type: result.mime });
    $('exportVideo').src = state.exportUrl;
    $('exportResult').hidden = false;
    $('shareExport').hidden = !(navigator.canShare && navigator.canShare({ files: [state.exportFile] }));
    const mb = (result.blob.size / 1048576).toFixed(1);
    status.textContent =
      `Listo: ${clips.length} clips · ${result.width}×${result.height} · ${mb} MB · MP4 (${result.mode}).`;
    bar.firstElementChild.style.width = '100%';
  } catch (err) {
    console.error(err);
    status.textContent = `No se pudo unir: ${err?.message || err}. Puedes descargar los clips por separado.`;
  } finally {
    $('exportBtn').disabled = false;
    setTimeout(() => (bar.hidden = true), 800);
  }
});

$('downloadExport').addEventListener('click', () => {
  if (state.exportFile) download(state.exportFile, state.exportFile.name);
});
$('shareExport').addEventListener('click', async () => {
  try {
    await navigator.share({ files: [state.exportFile], title: 'Vídeo TeleClip' });
  } catch {
    /* cancelado */
  }
});

// ---------------------------------------------------------------- utilidades

function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

// ---------------------------------------------------------------- arranque

async function init() {
  buildImagePanel();
  applySettings();
  try {
    for (const c of await getClips()) state.clips.set(c.seg, c);
  } catch (err) {
    console.error(err);
    toast('No se pudo abrir el almacenamiento local');
  }
  updateBadge();
  updateSegments();
  requestPersistence();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
