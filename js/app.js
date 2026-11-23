import {
  putClip, getClips, deleteClip, clearClips,
  loadJSON, saveJSON, loadText, saveText, requestPersistence,
} from './storage.js';

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
  stream: null,
  recorder: null,
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
  $('opacityVal').textContent = `${s.bgOpacity}%`;
  $('preview').classList.toggle('mirror', s.facing === 'user');
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

function bindCheck(id, key) {
  const el = $(id);
  el.checked = !!state.settings[key];
  el.addEventListener('change', () => setSetting(key, el.checked));
}
bindCheck('mirror', 'mirror');
bindCheck('autoAdvance', 'autoAdvance');
bindCheck('autoStop', 'autoStop');

$('countdownSel').value = String(state.settings.countdown);
$('countdownSel').addEventListener('change', (e) => setSetting('countdown', Number(e.target.value)));
$('quality').value = String(state.settings.quality);
$('quality').addEventListener('change', async (e) => {
  setSetting('quality', Number(e.target.value));
  if (!$('view-record').hidden && !state.recording) await startCamera();
});

$('openSettings').addEventListener('click', () => {
  if (!state.recording) $('settings').hidden = false;
});
$('closeSettings').addEventListener('click', () => ($('settings').hidden = true));

// ---------------------------------------------------------------- cámara

function pickMime() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  $('preview').srcObject = null;
}

async function startCamera() {
  stopCamera();
  $('camError').hidden = true;
  const q = state.settings.quality === 720 ? [720, 1280] : [1080, 1920];
  const portrait = window.innerHeight >= window.innerWidth;
  const [w, h] = portrait ? q : [q[1], q[0]];
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: state.settings.facing,
        width: { ideal: w },
        height: { ideal: h },
        frameRate: { ideal: 30 },
      },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    $('preview').srcObject = state.stream;
    applySettings();
  } catch (err) {
    console.error(err);
    const el = $('camError');
    el.textContent =
      err?.name === 'NotAllowedError'
        ? 'Necesito permiso para usar la cámara y el micrófono. Actívalo en los ajustes del navegador.'
        : `No se pudo abrir la cámara (${err?.name || err}). La app necesita HTTPS o localhost.`;
    el.hidden = false;
  }
}

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

function loadSegment(i) {
  state.current = Math.max(0, Math.min(i, state.segments.length - 1));
  $('prompterText').textContent = state.segments[state.current] ?? '';
  scroller.scrollTop = 0;
  carry = 0;
  const has = state.clips.has(state.current);
  $('segLabel').textContent =
    `Clip ${state.current + 1} / ${state.segments.length}` + (has ? ' · ✓ grabado (se reemplazará)' : '');
  $('prevSeg').disabled = state.current === 0;
  $('nextSeg').disabled = state.current >= state.segments.length - 1;
}

function setScrolling(on) {
  state.scrolling = on;
  $('rehearse').textContent = on && !state.recording ? '⏸' : '▶';
  $('pausedBadge').hidden = on || !(state.recording || scroller.scrollTop > 0);
  if (on) {
    lastFrame = performance.now();
    requestAnimationFrame(tick);
  }
}

function tick(now) {
  if (!state.scrolling) return;
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  carry += state.settings.speed * 8 * dt;
  const whole = Math.floor(carry);
  if (whole > 0) {
    scroller.scrollTop += whole;
    carry -= whole;
  }
  const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  if (atEnd) {
    setScrolling(false);
    $('pausedBadge').hidden = true;
    if (state.recording && state.settings.autoStop) {
      clearTimeout(endTimer);
      endTimer = setTimeout(() => state.recording && stopRecording(), 1200);
    }
    return;
  }
  requestAnimationFrame(tick);
}

// Tocar el texto pausa / reanuda. Arrastrar lo mueve a mano.
let downY = null;
scroller.addEventListener('pointerdown', (e) => (downY = e.clientY));
scroller.addEventListener('pointerup', (e) => {
  if (downY !== null && Math.abs(e.clientY - downY) < 8 && !state.countingDown) {
    if (state.scrolling) setScrolling(false);
    else if (state.recording || scroller.scrollTop > 0) setScrolling(true);
  }
  downY = null;
});

$('rehearse').addEventListener('click', () => {
  if (state.recording || state.countingDown) return;
  if (state.scrolling) return setScrolling(false);
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) scroller.scrollTop = 0;
  setScrolling(true);
});

$('prevSeg').addEventListener('click', () => {
  if (state.recording) return;
  setScrolling(false);
  loadSegment(state.current - 1);
});
$('nextSeg').addEventListener('click', () => {
  if (state.recording) return;
  setScrolling(false);
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
  if (!state.stream) await startCamera();
  if (!state.stream) return;
  const mime = pickMime();
  if (mime === null) {
    toast('Este navegador no permite grabar vídeo');
    return;
  }
  $('settings').hidden = true;
  setScrolling(false);
  scroller.scrollTop = 0;
  carry = 0;
  $('recBtn').classList.add('recording');

  if (!(await runCountdown(state.settings.countdown))) {
    $('recBtn').classList.remove('recording');
    return;
  }

  const bitrate = state.settings.quality === 720 ? 5_000_000 : 8_000_000;
  const chunks = [];
  const rec = new MediaRecorder(state.stream, {
    ...(mime ? { mimeType: mime } : {}),
    videoBitsPerSecond: bitrate,
    audioBitsPerSecond: 128_000,
  });
  const seg = state.current;
  const text = state.segments[seg];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    const duration = (performance.now() - state.recStart) / 1000;
    const type = rec.mimeType || mime || 'video/webm';
    const blob = new Blob(chunks, { type });
    const clip = { seg, text, blob, mime: type, duration, createdAt: Date.now() };
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
  setScrolling(true);
}

function stopRecording() {
  clearTimeout(endTimer);
  clearInterval(timerInterval);
  setScrolling(false);
  $('pausedBadge').hidden = true;
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
  else startRecording();
});

async function openRecorder(i) {
  if (!state.segments.length) return;
  showView('record');
  applySettings();
  loadSegment(i);
  await startCamera();
  keepAwake(true);
}

function closeRecorder() {
  if (state.recording) stopRecording();
  state.countingDown = false;
  setScrolling(false);
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
    const result = await joinClips(
      clips.map((c) => c.blob),
      (p) => (bar.firstElementChild.style.width = `${Math.round(p * 100)}%`),
    );
    if (state.exportUrl) URL.revokeObjectURL(state.exportUrl);
    state.exportUrl = URL.createObjectURL(result.blob);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    state.exportFile = new File([result.blob], `teleclip-${stamp}.${result.ext}`, { type: result.mime });
    $('exportVideo').src = state.exportUrl;
    $('exportResult').hidden = false;
    $('shareExport').hidden = !(navigator.canShare && navigator.canShare({ files: [state.exportFile] }));
    const mb = (result.blob.size / 1048576).toFixed(1);
    status.textContent = `Listo: ${clips.length} clips · ${mb} MB · ${result.ext.toUpperCase()} (${result.mode}).`;
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
