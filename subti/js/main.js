import {
  STYLES, SWATCHES, DEFAULT_SETTINGS, loadFonts, buildPages, pageAt, drawCaptions, resolveStyle, toSRT, retimeWords,
} from './captions.js';
import { extractAudio, transcribe, cancelTranscription } from './transcribe.js';
import { probe, exportVideo, thumbnail } from './render.js';
import { saveProject, getProject, deleteProject, listProjects, prefs, setPrefs } from './db.js';
import {
  isPro, proStatus, startTrial, trialUsed, markTrialUsed, PRICES, FREE, LEMON, paymentsReady, checkoutUrl,
  activateLicense, refreshLicense, unlinkLicense,
} from './plan.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};
const icon = (id) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', `#i-${id}`);
  s.append(u);
  return s;
};
const haptic = (ms = 8) => navigator.vibrate?.(ms);
const fmt = (s) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const fmtPrecise = (s) => `${fmt(s)}.${Math.floor(((s || 0) % 1) * 10)}`;
const DPR = Math.min(2, window.devicePixelRatio || 1);

// ================================================================ estado

const S = {
  project: null, // { id, name, file, words, settings, duration, width, height, peaks }
  url: null,
  pages: [],
  editLines: [],
};

// ================================================================ toast y hojas

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const sheetStack = [];
function openSheet(id) {
  const sh = $(id);
  sh.classList.remove('closing');
  sh.hidden = false;
  $('#scrim').hidden = false;
  if (!sheetStack.includes(sh)) sheetStack.push(sh);
  sh.scrollTop = 0;
}
function closeSheet(id) {
  const sh = typeof id === 'string' ? $(id) : id;
  if (!sh || sh.hidden) return;
  sh.classList.add('closing');
  const i = sheetStack.indexOf(sh);
  if (i >= 0) sheetStack.splice(i, 1);
  setTimeout(() => {
    sh.hidden = true;
    sh.classList.remove('closing');
  }, 240);
  if (!sheetStack.length) $('#scrim').hidden = true;
}
$('#scrim').addEventListener('click', () => {
  const top = sheetStack[sheetStack.length - 1];
  if (top && !top.dataset.locked) closeSheet(top);
});
$$('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet(b.closest('.sheet'))));

// Deslizar hacia abajo para cerrar una hoja (móvil)
for (const sh of $$('.sheet')) {
  let y0 = null;
  let dy = 0;
  sh.addEventListener('pointerdown', (e) => {
    if (sh.scrollTop > 0 || e.target.closest('input,button,video,.styles') || sh.dataset.locked) return;
    y0 = e.clientY;
    dy = 0;
  });
  sh.addEventListener('pointermove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    if (dy > 4) sh.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    sh.style.transition = 'transform .25s cubic-bezier(.2,.8,.2,1)';
    sh.style.transform = '';
    setTimeout(() => (sh.style.transition = ''), 260);
    if (dy > 110) closeSheet(sh);
  };
  sh.addEventListener('pointerup', end);
  sh.addEventListener('pointercancel', end);
}

function show(screen) {
  for (const s of ['#home', '#processing', '#editor']) $(s).hidden = s !== screen;
  if (screen !== '#home') stopDemo();
  else startDemo();
}

// ================================================================ Pro

let selectedPlan = 'yearly';
function openPro(reason, { keyMode = false } = {}) {
  const st = proStatus();
  const licensed = st.kind === 'license';
  $('#proBuy').hidden = licensed;
  $('#proHave').hidden = !licensed;
  if (licensed) {
    $('#proTitle').textContent = 'Ya eres Pro ✨';
    $('#proReason').textContent = 'Todos los estilos, sin marca de agua y en 4K. Gracias por apoyar Subti.';
    $('#haveTitle').textContent = `Subti Pro${st.plan ? ` · ${st.plan}` : ''}`;
    $('#haveSub').textContent = st.email || 'Licencia activa en este dispositivo';
    const portal = $('#portalBtn');
    portal.hidden = !LEMON.portal;
    if (LEMON.portal) portal.href = LEMON.portal;
    openSheet('#proSheet');
    return;
  }
  $('#proTitle').textContent = 'Vídeos que parecen de agencia';
  $('#proReason').textContent = reason || 'Desbloquea todos los estilos y exporta sin marca de agua.';
  renderPlans();
  $('#keyForm').hidden = !keyMode;
  $('#keyToggle').hidden = keyMode || !paymentsReady();
  $('#keyError').hidden = true;
  openSheet('#proSheet');
  if (keyMode) setTimeout(() => $('#keyInput').focus(), 350);
}

function renderPlans() {
  const plans = $('#plans');
  const ready = paymentsReady();
  plans.replaceChildren(
    ...Object.entries(PRICES).filter(([k]) => !ready || LEMON.checkout[k]).map(([k, p]) => {
      const b = el('button', { className: 'plan' });
      b.setAttribute('aria-pressed', String(k === selectedPlan));
      if (k === 'yearly') b.append(el('span', { className: 'tag', textContent: 'MEJOR PRECIO' }));
      b.append(el('small', { textContent: p.label }));
      const price = el('b', { textContent: p.price });
      price.append(el('span', { textContent: ` ${p.per}` }));
      b.append(price);
      if (p.note) b.append(el('em', { textContent: p.note }));
      b.onclick = () => {
        selectedPlan = k;
        haptic();
        renderPlans();
      };
      return b;
    }),
  );
  if (ready && !LEMON.checkout[selectedPlan]) selectedPlan = LEMON.checkout.yearly ? 'yearly' : 'monthly';
  const canTrial = !trialUsed();
  if (ready) {
    const p = PRICES[selectedPlan];
    $('#proGo').textContent = `Suscribirme · ${p.price}${p.per}`;
    $('#proTrial').hidden = !canTrial;
    $('#proFine').textContent = 'Pago seguro con Lemon Squeezy. IVA incluido. Cancela cuando quieras.';
  } else {
    $('#proGo').textContent = canTrial ? 'Probar 7 días gratis' : 'Avísame cuando esté';
    $('#proTrial').hidden = true;
    $('#proFine').textContent = canTrial ? 'Sin tarjeta. Al terminar la prueba vuelves al plan gratis.' : 'Los pagos llegan muy pronto.';
  }
}

function doTrial() {
  startTrial();
  markTrialUsed();
  haptic(20);
  closeSheet('#proSheet');
  refreshPro();
  toast('✨ Subti Pro activado durante 7 días');
}

$$('[data-open-pro]').forEach((b) => b.addEventListener('click', () => openPro()));
$('#proGo').addEventListener('click', () => {
  if (paymentsReady()) {
    const url = checkoutUrl(selectedPlan);
    // En una pestaña nueva: la app sigue abierta para pegar la clave al volver.
    const w = window.open(url, '_blank');
    if (w) w.opener = null;
    else location.href = url; // ventanas emergentes bloqueadas: vamos al pago en esta misma pestaña
    setPrefs('pendingCheckout', Date.now());
    $('#keyForm').hidden = false;
    $('#keyToggle').hidden = true;
    return;
  }
  if (!trialUsed()) return doTrial();
  toast('Los pagos llegan muy pronto. ¡Gracias por tu interés!');
});
$('#proTrial').addEventListener('click', doTrial);
$('#keyToggle').addEventListener('click', () => {
  $('#keyForm').hidden = false;
  $('#keyToggle').hidden = true;
  $('#keyInput').focus();
});
$('#keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#keyGo');
  const err = $('#keyError');
  err.hidden = true;
  btn.classList.add('loading');
  btn.textContent = 'Comprobando…';
  const res = await activateLicense($('#keyInput').value);
  btn.classList.remove('loading');
  btn.textContent = 'Activar';
  if (!res.ok) {
    err.textContent = res.error;
    err.hidden = false;
    haptic(40);
    return;
  }
  $('#keyInput').value = '';
  setPrefs('pendingCheckout', null);
  haptic(25);
  closeSheet('#proSheet');
  refreshPro();
  toast('🎉 ¡Bienvenido a Subti Pro!');
});
$('#unlinkKey').addEventListener('click', async () => {
  if (!confirm('¿Quitar Pro de este dispositivo? Podrás volver a activarlo con tu clave.')) return;
  await unlinkLicense();
  closeSheet('#proSheet');
  refreshPro();
  toast('Pro quitado de este dispositivo');
});

function refreshPro() {
  const st = proStatus();
  const pill = $('.pro-pill');
  pill.classList.toggle('is-pro', st.pro);
  $('#proPillLabel').textContent = st.pro ? (st.kind === 'trial' ? `Pro · ${Math.max(1, Math.ceil((st.until - Date.now()) / 864e5))} d` : 'Pro') : 'Pro';
  if (S.project) renderStyles();
}

// ================================================================ demo de la portada

const DEMO_WORDS = (() => {
  const txt = 'Así se ven tus vídeos con subtítulos que de verdad enganchan';
  let t = 0.2;
  return txt.split(' ').map((w) => {
    const d = 0.22 + w.length * 0.035;
    const wd = { w, s: t, e: t + d };
    t += d + 0.04;
    return wd;
  });
})();
const DEMO_LEN = DEMO_WORDS[DEMO_WORDS.length - 1].e + 0.9;
const DEMO_STYLES = ['pop', 'caja', 'karaoke', 'neon', 'titular', 'rotulador'];
let demoRaf = 0;
function paintBackdrop(ctx, W, H, t) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1d1638');
  g.addColorStop(0.55, '#26142c');
  g.addColorStop(1, '#3a1426');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // manchas de luz que se mueven despacio, como un vídeo desenfocado
  const blobs = [
    ['rgba(139,123,255,.55)', 0.3, 0.3, 0.55],
    ['rgba(255,77,141,.45)', 0.75, 0.55, 0.5],
    ['rgba(255,170,90,.28)', 0.45, 0.85, 0.45],
  ];
  blobs.forEach(([c, x, y, r], i) => {
    const cx = W * (x + 0.08 * Math.sin(t * 0.5 + i * 2));
    const cy = H * (y + 0.06 * Math.cos(t * 0.4 + i));
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, W * r);
    rg.addColorStop(0, c);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  });
}
function startDemo() {
  const c = $('#demoCanvas');
  if (!c || demoRaf) return;
  const ctx = c.getContext('2d');
  const t0 = performance.now();
  const loop = (now) => {
    const T = Math.max(0, (now - t0) / 1000);
    const k = Math.floor(T / DEMO_LEN);
    const t = T - k * DEMO_LEN;
    const style = DEMO_STYLES[k % DEMO_STYLES.length];
    paintBackdrop(ctx, c.width, c.height, T);
    const pages = buildPages(DEMO_WORDS, STYLES[style].words);
    drawCaptions(ctx, c.width, c.height, t, pages, { ...DEFAULT_SETTINGS, style, y: 0.42 });
    demoRaf = requestAnimationFrame(loop);
  };
  demoRaf = requestAnimationFrame(loop);
}
function stopDemo() {
  cancelAnimationFrame(demoRaf);
  demoRaf = 0;
}

// ================================================================ inicio

async function renderRecent() {
  let list = [];
  try {
    list = await listProjects();
  } catch {
    /* IndexedDB no disponible */
  }
  $('#recentWrap').hidden = !list.length;
  const grid = $('#recent');
  for (const u of grid.querySelectorAll('[data-url]')) URL.revokeObjectURL(u.dataset.url);
  grid.replaceChildren(
    ...list.map((p, i) => {
      const card = el('button', { className: 'proj' });
      card.style.animationDelay = `${i * 40}ms`;
      const th = el('div', { className: 'thumb' });
      if (p.thumb) {
        const u = URL.createObjectURL(p.thumb);
        th.dataset.url = u;
        th.style.backgroundImage = `url(${u})`;
      }
      const meta = el('div', { className: 'meta' }, el('b', { textContent: p.name }), el('span', { textContent: `${fmt(p.duration)} · ${relDate(p.updated)}` }));
      const del = el('span', { className: 'del', role: 'button', ariaLabel: 'Borrar proyecto' }, icon('trash'));
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`¿Borrar «${p.name}»?`)) return;
        await deleteProject(p.id);
        renderRecent();
      };
      card.append(th, meta, del);
      card.onclick = () => openProject(p.id);
      return card;
    }),
  );
}

function relDate(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'ahora';
  if (d < 3600) return `hace ${Math.floor(d / 60)} min`;
  if (d < 86400) return `hace ${Math.floor(d / 3600)} h`;
  if (d < 86400 * 7) return `hace ${Math.floor(d / 86400)} d`;
  return new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short' });
}

const fileInput = $('#fileInput');
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  fileInput.value = '';
  if (f) onFile(f);
});
const drop = $('#drop');
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|mkv)$/i.test(x.name));
  if (f) onFile(f);
  else toast('Eso no parece un vídeo');
});

// ================================================================ preparar

const LANGS = [
  ['es', 'Español'], ['auto', 'Detectar'], ['en', 'English'], ['ca', 'Català'], ['pt', 'Português'],
  ['fr', 'Français'], ['it', 'Italiano'], ['de', 'Deutsch'], ['gl', 'Galego'], ['eu', 'Euskara'],
];
let pending = null; // { file, info, thumb }

async function onFile(file) {
  haptic();
  let info;
  try {
    info = await probe(file);
  } catch (err) {
    console.error(err);
    toast('No puedo abrir este vídeo. Prueba con un MP4 o MOV.');
    return;
  }
  let thumb = null;
  try {
    thumb = await thumbnail(file, Math.min(1, info.duration / 2));
  } catch (err) {
    console.warn(err);
  }
  pending = { file, info, thumb };
  const box = $('#setupFile');
  const th = el('div', { className: 'thumb' });
  if (thumb) th.style.backgroundImage = `url(${URL.createObjectURL(thumb)})`;
  box.replaceChildren(th, el('div', {}, el('b', { textContent: file.name }), el('span', { textContent: `${fmt(info.duration)} · ${info.width}×${info.height} · ${(file.size / 1e6).toLocaleString('es', { maximumFractionDigits: 1 })} MB` })));
  renderSetup();
  openSheet('#setupSheet');
}

function renderSetup() {
  const lang = prefs('lang', 'es');
  $('#langChips').replaceChildren(
    ...LANGS.map(([code, name]) => {
      const b = el('button', { textContent: name });
      b.setAttribute('aria-pressed', String(code === lang));
      b.onclick = () => {
        setPrefs('lang', code);
        haptic();
        renderSetup();
      };
      return b;
    }),
  );
  let q = prefs('quality', 'fast');
  if (q === 'precise' && !isPro()) q = 'fast';
  for (const b of $$('#qualitySeg button')) {
    b.setAttribute('aria-pressed', String(b.dataset.q === q));
    const lbl = b.querySelector('b');
    lbl.dataset.l ??= lbl.textContent;
    lbl.textContent = lbl.dataset.l;
    if (b.dataset.q === 'precise' && !isPro()) lbl.append(' ', icon('lock'));
    b.onclick = () => {
      if (b.dataset.q === 'precise' && !isPro()) return openPro('La transcripción de máxima precisión es parte de Subti Pro.');
      setPrefs('quality', b.dataset.q);
      haptic();
      renderSetup();
    };
  }
  $('#setupNote').textContent = q === 'precise'
    ? 'La primera vez se descarga el modelo preciso (≈250 MB) y queda guardado en tu dispositivo.'
    : 'La primera vez se descarga el modelo de voz (≈80 MB) y queda guardado en tu dispositivo.';
}

$('#setupGo').addEventListener('click', () => {
  closeSheet('#setupSheet');
  if (pending) startTranscription(pending);
});

// ================================================================ transcribir

let cancelled = false;
async function startTranscription({ file, info, thumb }) {
  cancelled = false;
  show('#processing');
  $('#procBg').style.backgroundImage = thumb ? `url(${URL.createObjectURL(thumb)})` : '';
  $('#ticker').replaceChildren();
  setRing(0, true);
  setProc('Preparando el audio…', 'Extrayendo la voz de tu vídeo');

  let audio = null;
  try {
    audio = await extractAudio(file, (p) => setRing(p * 0.999, false));
  } catch (err) {
    console.error(err);
  }
  if (cancelled) return;
  const peaks = audio ? computePeaks(audio) : [];
  let words = [];
  if (!audio || audio.length < 1600) {
    toast('Este vídeo no tiene audio: puedes escribir los subtítulos a mano.', 4000);
  } else {
    try {
      const t0 = performance.now();
      setProc('Preparando la IA…', 'Cargando el modelo de voz');
      setRing(0, true);
      words = await transcribe(audio, {
        language: prefs('lang', 'es'),
        quality: isPro() ? prefs('quality', 'fast') : 'fast',
        onEvent: (e) => {
          if (cancelled) return;
          if (e.type === 'download') {
            const p = e.total ? e.loaded / e.total : 0;
            setRing(p, false);
            setProc('Descargando la IA de voz…', `${(e.loaded / 1e6).toFixed(0)} de ${(e.total / 1e6).toFixed(0)} MB · solo la primera vez`);
          } else if (e.type === 'ready') {
            setProc('Escuchando tu vídeo…', `Transcribiendo en tu ${e.device === 'GPU' ? 'tarjeta gráfica' : 'dispositivo'}`);
            setRing(0, false);
          } else if (e.type === 'progress') {
            setRing(e.done / e.total, false);
            const el2 = (performance.now() - t0) / 1000;
            const rate = e.done / Math.max(1, el2);
            const left = (e.total - e.done) / Math.max(0.01, rate);
            setProc('Escuchando tu vídeo…', `${fmt(e.done)} de ${fmt(e.total)}${e.done < e.total ? ` · quedan ~${fmt(left)}` : ''}`);
          } else if (e.type === 'partial') {
            pushTicker(e.words);
          }
        },
      });
    } catch (err) {
      if (cancelled) return;
      console.error(err);
      toast('No he podido transcribir. Revisa tu conexión la primera vez y vuelve a intentarlo.', 4500);
      show('#home');
      return;
    }
  }
  if (cancelled) return;
  if (audio && !words.length) toast('No he oído voz en el vídeo: puedes escribir los subtítulos a mano.', 4000);
  setRing(1, false);
  const project = {
    id: crypto.randomUUID?.() || String(Date.now()),
    name: file.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Mi vídeo',
    file,
    thumb,
    words,
    peaks,
    settings: { ...DEFAULT_SETTINGS, ...prefs('lastSettings', {}) },
    duration: info.duration,
    width: info.width,
    height: info.height,
    created: Date.now(),
  };
  try {
    await saveProject(project);
  } catch (err) {
    console.warn('No se pudo guardar el proyecto', err);
  }
  haptic(25);
  openEditor(project);
}

$('#procCancel').addEventListener('click', () => {
  cancelled = true;
  cancelTranscription();
  show('#home');
});

function setProc(title, sub) {
  $('#procTitle').textContent = title;
  $('#procSub').textContent = sub;
}
function setRing(p, indeterminate) {
  const r = $('#ring');
  r.classList.toggle('indeterminate', !!indeterminate);
  r.style.setProperty('--p', String(Math.max(0, Math.min(1, p))));
  $('#ringPct').textContent = indeterminate ? '' : `${Math.round(p * 100)} %`;
}
function pushTicker(words) {
  const t = $('#ticker');
  for (const w of words) t.append(el('span', { textContent: w.w }));
  while (t.children.length > 40) t.firstChild.remove();
}

function computePeaks(audio, perSec = 40) {
  const step = Math.floor(16000 / perSec);
  const out = new Array(Math.ceil(audio.length / step));
  for (let i = 0; i < out.length; i++) {
    let m = 0;
    const end = Math.min(audio.length, (i + 1) * step);
    for (let k = i * step; k < end; k += 4) m = Math.max(m, Math.abs(audio[k]));
    out[i] = Math.round(Math.min(1, m) * 255);
  }
  return out;
}

// ================================================================ editor

const video = $('#video');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const stage = $('#stage');
const tlScroll = $('#tlScroll');
const PPS = 90; // píxeles por segundo en la línea de tiempo

async function openProject(id) {
  const p = await getProject(id);
  if (!p) return toast('No encuentro ese proyecto');
  openEditor(p);
}

function openEditor(p) {
  S.project = p;
  S.project.settings = { ...DEFAULT_SETTINGS, ...p.settings };
  if (S.url) URL.revokeObjectURL(S.url);
  S.url = URL.createObjectURL(p.file);
  video.src = S.url;
  video.currentTime = 0;
  stage.style.setProperty('--ar', `${p.width} / ${p.height}`);
  $('#edName').value = p.name;
  $('#tDur').textContent = fmt(p.duration);
  show('#editor');
  rebuild();
  renderStyles();
  renderSwatches();
  renderAdjust();
  buildTimeline();
  selectTab(prefs('tab', 'style'));
  requestAnimationFrame(() => {
    resizeOverlay();
    syncTimeline(0);
  });
}

function rebuild() {
  const st = resolveStyle(S.project.settings);
  S.pages = buildPages(S.project.words, st.words);
  S.editLines = buildPages(S.project.words, 8, 40);
  renderChips();
  renderLines();
  draw();
}

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!S.project) return;
    setPrefs('lastSettings', { ...S.project.settings });
    saveProject(S.project).catch((e) => console.warn(e));
  }, 500);
}

function setSetting(k, v) {
  S.project.settings[k] = v;
  if (k === 'words' || k === 'style') rebuild();
  else draw();
  persist();
}

$('#edName').addEventListener('change', (e) => {
  S.project.name = e.target.value.trim() || 'Mi vídeo';
  persist();
});
$('#edBack').addEventListener('click', () => {
  video.pause();
  persist();
  S.project = null;
  show('#home');
  renderRecent();
});

// ---------- vista previa

function resizeOverlay() {
  const r = stage.getBoundingClientRect();
  overlay.width = Math.max(2, Math.round(r.width * DPR));
  overlay.height = Math.max(2, Math.round(r.height * DPR));
  draw();
}
new ResizeObserver(() => S.project && resizeOverlay()).observe(stage);

function draw() {
  if (!S.project) return;
  const W = overlay.width;
  const H = overlay.height;
  octx.clearRect(0, 0, W, H);
  const t = video.currentTime;
  drawCaptions(octx, W, H, t, S.pages, S.project.settings);
  if (dragging) return;
  updateActive(t);
}

let raf = 0;
function loop() {
  draw();
  syncTimeline(video.currentTime);
  $('#tCur').textContent = fmt(video.currentTime);
  if (!video.paused) raf = requestAnimationFrame(loop);
}
video.addEventListener('play', () => {
  stage.classList.add('playing');
  $('#playBtn').replaceChildren(icon('pause'));
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
});
video.addEventListener('pause', () => {
  stage.classList.remove('playing');
  $('#playBtn').replaceChildren(icon('play'));
  loop();
});
video.addEventListener('seeked', () => {
  draw();
  if (video.paused) syncTimeline(video.currentTime);
  $('#tCur').textContent = fmt(video.currentTime);
});
video.addEventListener('ended', () => video.pause());

function togglePlay() {
  haptic();
  if (video.paused) {
    if (video.currentTime >= S.project.duration - 0.05) video.currentTime = 0;
    video.play().catch(() => {});
  } else video.pause();
}
$('#playBtn').addEventListener('click', togglePlay);
$('#bigPlay').addEventListener('click', togglePlay);
document.addEventListener('keydown', (e) => {
  if ($('#editor').hidden || e.target.closest('input,textarea') || sheetStack.length) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    video.currentTime = Math.max(0, Math.min(S.project.duration, video.currentTime + (e.code === 'ArrowLeft' ? -1 : 1)));
    syncTimeline(video.currentTime);
  }
});

// Tocar = reproducir/pausar. Arrastrar en vertical = mover los subtítulos (con imán al centro y a la zona segura).
let dragging = false;
let dragStart = null;
const SNAPS = [0.5, 0.7];
stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.big-play')) return;
  dragStart = { x: e.clientX, y: e.clientY, moved: false };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!dragStart) return;
  if (!dragStart.moved && Math.abs(e.clientY - dragStart.y) < 8) return;
  dragStart.moved = true;
  dragging = true;
  const r = stage.getBoundingClientRect();
  let y = Math.max(0.08, Math.min(0.92, (e.clientY - r.top) / r.height));
  const snap = SNAPS.find((s) => Math.abs(s - y) < 0.018);
  if (snap) y = snap;
  const g = $('#dragGuide');
  g.hidden = false;
  g.style.top = `${y * 100}%`;
  if (snap && !g.classList.contains('snap')) haptic(6);
  g.classList.toggle('snap', !!snap);
  S.project.settings.y = y;
  if (!S.pages.length || pageAt(S.pages, video.currentTime) === null) {
    // sin subtítulo en este instante: enseña el primero para poder colocarlo
    const W = overlay.width;
    const H = overlay.height;
    octx.clearRect(0, 0, W, H);
    const p = S.pages[0];
    if (p) drawCaptions(octx, W, H, p.s + 0.3, S.pages, S.project.settings);
  } else draw();
});
const endDrag = () => {
  if (!dragStart) return;
  const moved = dragStart.moved;
  dragStart = null;
  dragging = false;
  $('#dragGuide').hidden = true;
  if (moved) {
    renderAdjust();
    persist();
    draw();
  } else togglePlay();
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

// ---------- línea de tiempo

let programmatic = false;
let userScrolling = false;
let lastActive = -1;

function buildTimeline() {
  const dur = S.project.duration;
  const inner = $('#tlInner');
  const half = () => tlScroll.clientWidth / 2;
  const setSize = () => {
    inner.style.width = `${dur * PPS + half() * 2}px`;
    for (const c of [$('#tlRuler'), $('#tlTrack'), $('.tl-wave')]) {
      c.style.left = `${half()}px`;
      c.style.right = `${half()}px`;
    }
    drawWave();
  };
  setSize();
  new ResizeObserver(setSize).observe(tlScroll);
  const ruler = $('#tlRuler');
  const step = dur > 120 ? 10 : dur > 40 ? 5 : 2;
  ruler.replaceChildren();
  for (let s = 0; s <= dur; s += step) {
    const m = el('span', { textContent: fmt(s) });
    m.style.left = `${s * PPS}px`;
    ruler.append(m);
  }
}

function drawWave() {
  const c = $('#tlWave');
  const peaks = S.project?.peaks || [];
  const w = S.project.duration * PPS;
  c.width = Math.min(32000, Math.round(w * DPR));
  c.height = Math.round(26 * DPR);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!peaks.length) return;
  const g = ctx.createLinearGradient(0, 0, c.width, 0);
  g.addColorStop(0, 'rgba(139,123,255,.75)');
  g.addColorStop(1, 'rgba(255,77,141,.75)');
  ctx.fillStyle = g;
  const bars = Math.floor(c.width / (3 * DPR));
  for (let i = 0; i < bars; i++) {
    const a = Math.floor((i / bars) * peaks.length);
    const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * peaks.length));
    let m = 0;
    for (let k = a; k < b; k++) m = Math.max(m, peaks[k]);
    const h = Math.max(1.5 * DPR, (m / 255) * c.height);
    ctx.fillRect(i * 3 * DPR, (c.height - h) / 2, 2 * DPR, h);
  }
}

function renderChips() {
  const track = $('#tlTrack');
  track.replaceChildren(
    ...S.pages.map((p, i) => {
      const c = el('button', { className: 'chip', textContent: p.words.map((w) => w.w).join(' ') });
      c.style.left = `${p.s * PPS}px`;
      c.style.width = `${Math.max(18, (p.e - p.s) * PPS - 3)}px`;
      c.dataset.i = i;
      c.onclick = () => {
        seek(p.s + 0.01);
        selectTab('text');
        const li = S.editLines.findIndex((l) => l.words.some((w) => w.i === p.words[0].i));
        const inp = $(`.line[data-i="${li}"] textarea`);
        inp?.focus({ preventScroll: true });
        inp?.closest('.line')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };
      return c;
    }),
  );
  lastActive = -1;
}

function seek(t) {
  video.currentTime = Math.max(0, Math.min(S.project.duration, t));
  syncTimeline(video.currentTime);
  draw();
}

function syncTimeline(t) {
  if (userScrolling) return;
  programmatic = true;
  tlScroll.scrollLeft = t * PPS;
  requestAnimationFrame(() => (programmatic = false));
}

const startUser = () => {
  userScrolling = true;
  if (!video.paused) video.pause();
};
tlScroll.addEventListener('pointerdown', startUser);
tlScroll.addEventListener('touchstart', startUser, { passive: true });
tlScroll.addEventListener('wheel', startUser, { passive: true });
let scrollEndTimer = 0;
tlScroll.addEventListener('scroll', () => {
  if (programmatic || !userScrolling) return;
  const t = Math.max(0, Math.min(S.project.duration, tlScroll.scrollLeft / PPS));
  if (!video.seeking) video.currentTime = t;
  $('#tCur').textContent = fmt(t);
  draw();
  clearTimeout(scrollEndTimer);
  scrollEndTimer = setTimeout(() => (userScrolling = false), 180);
});
const endUser = () => {
  clearTimeout(scrollEndTimer);
  scrollEndTimer = setTimeout(() => (userScrolling = false), 180);
};
tlScroll.addEventListener('pointerup', endUser);
tlScroll.addEventListener('touchend', endUser);

function updateActive(t) {
  const i = pageAt(S.pages, t) ?? -1;
  if (i !== lastActive) {
    $$('.chip.on').forEach((c) => c.classList.remove('on'));
    if (i >= 0) $(`.chip[data-i="${i}"]`)?.classList.add('on');
    lastActive = i;
  }
  const li = S.editLines.findIndex((l) => t >= l.s && t < l.e);
  const cur = $('.line.on');
  const next = li >= 0 ? $(`.line[data-i="${li}"]`) : null;
  if (cur !== next) {
    cur?.classList.remove('on');
    next?.classList.add('on');
    if (next && !video.paused && !$('[data-body="text"]').hidden && !next.contains(document.activeElement)) {
      next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}

// ---------- pestañas

function selectTab(name) {
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const b of $$('.tab-body')) b.hidden = b.dataset.body !== name;
  setPrefs('tab', name);
  if (name === 'style') startStyleAnim();
  else stopStyleAnim();
}
for (const b of $$('.tabs button')) b.addEventListener('click', () => {
  haptic();
  selectTab(b.dataset.tab);
});

// ---------- estilo

const SAMPLE = (() => {
  let t = 0;
  return 'Hola esto queda genial'.split(' ').map((w) => {
    const d = 0.3 + w.length * 0.03;
    const wd = { w, s: t, e: t + d };
    t += d + 0.05;
    return wd;
  });
})();
const SAMPLE_LEN = SAMPLE[SAMPLE.length - 1].e + 0.7;
let styleRaf = 0;

function renderStyles() {
  const wrap = $('#styles');
  const cur = S.project.settings.style;
  const pro = isPro();
  wrap.replaceChildren(
    ...Object.entries(STYLES).map(([key, st]) => {
      const card = el('button', { className: 'style-card' });
      card.setAttribute('aria-pressed', String(key === cur));
      const pv = el('div', { className: 'pv' });
      const cv = el('canvas', { width: 184, height: 232 });
      cv.dataset.style = key;
      pv.append(cv);
      if (st.pro && !pro) pv.append(el('span', { className: 'lock' }, icon('lock')));
      card.append(pv, el('span', { textContent: st.name }));
      card.onclick = () => {
        haptic();
        const s = S.project.settings;
        if (s.style !== key) {
          s.style = key;
          s.words = null;
          s.upper = null;
          setSetting('style', key);
          renderStyles();
          renderSwatches();
          renderAdjust();
        }
        if (st.pro && !pro) toast(`«${st.name}» es Pro: pruébalo gratis 7 días ✨`);
      };
      return card;
    }),
  );
  if (!$('[data-body="style"]').hidden) startStyleAnim();
}

function startStyleAnim() {
  if (styleRaf) return;
  const t0 = performance.now();
  const loop = (now) => {
    const cvs = $$('#styles canvas');
    if (!cvs.length || $('#editor').hidden) {
      styleRaf = 0;
      return;
    }
    const t = (Math.max(0, now - t0) / 1000) % SAMPLE_LEN;
    for (const c of cvs) {
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      const key = c.dataset.style;
      const settings = { ...DEFAULT_SETTINGS, style: key, y: 0.5, color: S.project?.settings.color ?? null, size: 1.25 };
      drawCaptions(ctx, c.width, c.height, t, buildPages(SAMPLE, STYLES[key].words), settings);
    }
    styleRaf = requestAnimationFrame(loop);
  };
  styleRaf = requestAnimationFrame(loop);
}
function stopStyleAnim() {
  cancelAnimationFrame(styleRaf);
  styleRaf = 0;
}

function renderSwatches() {
  const s = S.project.settings;
  const st = STYLES[s.style];
  const box = $('#swatches');
  const show2 = st.active !== null;
  box.hidden = !show2;
  box.previousElementSibling.hidden = !show2;
  if (!show2) return;
  const auto = el('button', { className: 'sw auto', ariaLabel: 'Color del estilo' });
  auto.setAttribute('aria-pressed', String(!s.color));
  auto.onclick = () => {
    haptic();
    setSetting('color', null);
    renderSwatches();
  };
  box.replaceChildren(
    auto,
    ...SWATCHES.map((c) => {
      const b = el('button', { className: 'sw', ariaLabel: c });
      b.style.background = c;
      b.setAttribute('aria-pressed', String(s.color === c));
      b.onclick = () => {
        haptic();
        setSetting('color', c);
        renderSwatches();
      };
      return b;
    }),
  );
}

// ---------- texto

function renderLines() {
  const box = $('#lines');
  if (!S.editLines.length) {
    const add = el('button', { className: 'btn btn-soft', textContent: 'Escribir subtítulos a mano' });
    add.onclick = () => {
      const d = S.project.duration;
      const t = video.currentTime < d - 1 ? video.currentTime : 0;
      S.project.words = [{ w: 'Escribe', s: t, e: t + 0.5 }, { w: 'aquí', s: t + 0.5, e: t + 1.2 }];
      rebuild();
      persist();
      $('.line textarea')?.focus();
    };
    box.replaceChildren(el('div', { className: 'empty' }, el('p', { textContent: 'No hay subtítulos todavía.' }), add));
    return;
  }
  box.replaceChildren(
    ...S.editLines.map((l, i) => {
      const time = el('time', { textContent: fmtPrecise(l.s) });
      time.onclick = () => {
        haptic();
        seek(l.s + 0.01);
      };
      const inp = el('textarea', { value: l.words.map((w) => w.w).join(' '), spellcheck: true, enterKeyHint: 'done', rows: 1 });
      const fit = () => {
        inp.style.height = 'auto';
        inp.style.height = `${inp.scrollHeight}px`;
      };
      inp.addEventListener('input', fit);
      requestAnimationFrame(fit);
      inp.addEventListener('focus', () => {
        if (!video.paused) video.pause();
        seek(l.s + 0.01);
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          inp.blur();
        }
      });
      inp.addEventListener('change', () => editLine(i, inp.value));
      const row = el('div', { className: 'line' }, time, inp);
      row.dataset.i = i;
      return row;
    }),
  );
}

function editLine(i, text) {
  const l = S.editLines[i];
  if (!l) return;
  const first = l.words[0].i;
  const last = l.words[l.words.length - 1].i;
  const old = S.project.words.slice(first, last + 1);
  const fresh = retimeWords(old, text);
  S.project.words.splice(first, last - first + 1, ...fresh);
  const focusedIndex = i;
  rebuild();
  persist();
  if (!fresh.length) toast('Línea borrada');
  // conservar el foco en la siguiente línea si se estaba tabulando
  const next = $(`.line[data-i="${focusedIndex + 1}"] textarea`);
  if (document.activeElement === document.body && next && fresh.length) next.focus({ preventScroll: true });
}

// ---------- ajustes

function paintRange(r) {
  const p = ((r.value - r.min) / (r.max - r.min)) * 100;
  r.style.setProperty('--fill', `${p}%`);
}

function renderAdjust() {
  const s = S.project.settings;
  const st = resolveStyle(s);
  const size = $('#size');
  size.value = s.size;
  $('#sizeOut').textContent = `${Math.round(s.size * 100)} %`;
  paintRange(size);
  const pos = $('#pos');
  pos.value = s.y;
  $('#posOut').textContent = s.y < 0.34 ? 'Arriba' : s.y > 0.62 ? 'Abajo' : 'Centro';
  paintRange(pos);
  $('#wordsSeg').replaceChildren(
    ...[1, 2, 3, 4, 5, 6].map((n) => {
      const b = el('button', { textContent: String(n) });
      b.setAttribute('aria-pressed', String(st.words === n));
      b.onclick = () => {
        haptic();
        setSetting('words', n);
        renderAdjust();
      };
      return b;
    }),
  );
  $('#upper').setAttribute('aria-checked', String(st.upper));
}
$('#size').addEventListener('input', (e) => {
  setSetting('size', Number(e.target.value));
  $('#sizeOut').textContent = `${Math.round(e.target.value * 100)} %`;
  paintRange(e.target);
});
$('#pos').addEventListener('input', (e) => {
  setSetting('y', Number(e.target.value));
  renderAdjust();
});
$('#upper').addEventListener('click', () => {
  haptic();
  const st = resolveStyle(S.project.settings);
  setSetting('upper', !st.upper);
  renderAdjust();
});
$('#srtBtn').addEventListener('click', () => {
  if (!S.project.words.length) return toast('Todavía no hay subtítulos');
  download(new Blob([toSRT(S.project.words)], { type: 'application/x-subrip' }), `${S.project.name}.srt`);
  toast('Subtítulos .srt descargados');
});

function download(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ================================================================ exportar

let exportRes = 1080;
let exportWm = true;
let exportAbort = null;
let lastExport = null;

$('#edExport').addEventListener('click', () => {
  video.pause();
  const st = STYLES[S.project.settings.style];
  if (st.pro && !isPro()) return openPro(`El estilo «${st.name}» es parte de Subti Pro. Pruébalo gratis y expórtalo ya.`);
  const pro = isPro();
  exportWm = !pro;
  if (!pro && exportRes > FREE.maxShort) exportRes = FREE.maxShort;
  renderExportSetup();
  $('#exportSetup').hidden = false;
  $('#exportRun').hidden = true;
  $('#exportDone').hidden = true;
  openSheet('#exportSheet');
});

function renderExportSetup() {
  const pro = isPro();
  const opts = [
    [720, '720p', 'Más ligero'],
    [1080, '1080p', 'Recomendado'],
    [2160, '4K', 'Máxima calidad'],
  ];
  $('#resSeg').replaceChildren(
    ...opts.map(([v, label, sub]) => {
      const b = el('button');
      const t = el('b', { textContent: label });
      if (v > FREE.maxShort && !pro) t.append(' ', icon('lock'));
      b.append(t, el('small', { textContent: sub }));
      b.setAttribute('aria-pressed', String(v === exportRes));
      b.onclick = () => {
        if (v > FREE.maxShort && !pro) return openPro('Exportar en 4K es parte de Subti Pro.');
        haptic();
        exportRes = v;
        renderExportSetup();
      };
      return b;
    }),
  );
  const sw = $('#wmSwitch');
  sw.setAttribute('aria-checked', String(exportWm));
  sw.onclick = () => {
    if (exportWm && !pro) return openPro('Exporta sin marca de agua con Subti Pro.');
    haptic();
    exportWm = !exportWm;
    renderExportSetup();
  };
}

$('#exportGo').addEventListener('click', async () => {
  const sheet = $('#exportSheet');
  sheet.dataset.locked = '1';
  $('#exportSetup').hidden = true;
  $('#exportRun').hidden = false;
  const bar = $('#exportBar');
  const info = $('#exportInfo');
  bar.style.width = '0%';
  info.textContent = 'Preparando…';
  exportAbort = new AbortController();
  const t0 = performance.now();
  try {
    await loadFonts();
    const res = await exportVideo(S.project.file, {
      pages: S.pages,
      settings: S.project.settings,
      watermark: exportWm || !isPro(),
      short: exportRes,
      signal: exportAbort.signal,
      onProgress: (p) => {
        bar.style.width = `${(p * 100).toFixed(1)}%`;
        const el2 = (performance.now() - t0) / 1000;
        const left = p > 0.03 ? (el2 / p) * (1 - p) : null;
        info.textContent = `${Math.round(p * 100)} %${left != null ? ` · quedan ~${fmt(left)}` : ''}`;
      },
    });
    lastExport = res;
    const rv = $('#resultVideo');
    if (rv.src) URL.revokeObjectURL(rv.src);
    rv.src = URL.createObjectURL(res.blob);
    $('#doneInfo').textContent = `${res.width}×${res.height} · ${(res.blob.size / 1e6).toLocaleString('es', { maximumFractionDigits: 1 })} MB · MP4`;
    $('#exportRun').hidden = true;
    $('#exportDone').hidden = false;
    haptic(30);
  } catch (err) {
    if (err?.name !== 'AbortError') {
      console.error(err);
      toast(err?.message?.startsWith('Este dispositivo') ? err.message : 'No se pudo exportar. Prueba en 720p.', 4500);
    }
    closeSheet(sheet);
  } finally {
    delete sheet.dataset.locked;
    exportAbort = null;
  }
});
$('#exportCancel').addEventListener('click', () => exportAbort?.abort());

const exportName = () => `${S.project.name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'subti'}.mp4`;
$('#shareBtn').addEventListener('click', async () => {
  if (!lastExport) return;
  const file = new File([lastExport.blob], exportName(), { type: 'video/mp4' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: S.project.name });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  download(lastExport.blob, exportName());
  toast('Vídeo guardado en Descargas');
});
$('#saveBtn').addEventListener('click', () => {
  if (!lastExport) return;
  download(lastExport.blob, exportName());
  toast('Vídeo guardado en Descargas');
});

// ================================================================ arranque

window.addEventListener('resize', () => S.project && resizeOverlay());
loadFonts().then(() => {
  if (S.project) draw();
});
refreshPro();
renderRecent();
refreshLicense().then(refreshPro);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  refreshLicense().then(refreshPro);
  // vuelve del pago en otra pestaña: abre directamente el campo de la clave
  const pend = prefs('pendingCheckout', null);
  if (pend && Date.now() - pend < 3600e3 && !isPro() && !sheetStack.includes($('#proSheet'))) openPro('', { keyMode: true });
});
if (new URLSearchParams(location.search).has('compra')) {
  history.replaceState(null, '', location.pathname);
  setTimeout(() => {
    openPro('', { keyMode: true });
    toast('¡Gracias por suscribirte! Pega la clave que te ha llegado por email.', 5000);
  }, 400);
}
show('#home');
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Gancho para pruebas automáticas: abre el editor con un vídeo y palabras dadas (sin IA).
window.__subti = {
  async openWith(file, words) {
    const info = await probe(file);
    const thumb = await thumbnail(file, 0.5).catch(() => null);
    const p = {
      id: String(Date.now()), name: file.name.replace(/\.[^.]+$/, ''), file, thumb, words, peaks: [],
      settings: { ...DEFAULT_SETTINGS }, duration: info.duration, width: info.width, height: info.height, created: Date.now(),
    };
    await saveProject(p);
    openEditor(p);
  },
  startTrial: () => {
    startTrial();
    refreshPro();
  },
};

// Vídeo recibido con «Compartir → Subti» (ver sw.js)
if (new URLSearchParams(location.search).has('shared')) {
  history.replaceState(null, '', location.pathname);
  caches.open('subti-share').then(async (c) => {
    const res = await c.match('shared-video');
    if (!res) return;
    await c.delete('shared-video');
    const blob = await res.blob();
    const name = decodeURIComponent(res.headers.get('X-Name') || 'video.mp4');
    onFile(new File([blob], name, { type: blob.type || 'video/mp4' }));
  }).catch(() => {});
}
