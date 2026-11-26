// Editor: vista previa con efectos, clips (tomas, recortes, orden, texto), subtítulos, efectos,
// audio, elementos encima del vídeo, portada y exportación.

import { analyzeTake, buildTimeline, withDefaults, orderOf, selectedTake } from './timeline.js';
import { Preview } from './player.js';
import { putTake, putAsset, getAsset, deleteAsset, uid } from './storage.js';

const $ = (id) => document.getElementById(id);
const EMOJIS = ['🔥', '👉', '✅', '❌', '💡', '⭐', '😂', '😍', '🤯', '👀', '🚀', '💰', '❤️', '👍', '⚠️', '🎯'];

export function createEditor(app) {
  const preview = new Preview($('edCanvas'), {
    onTime: (t) => syncTransport(t),
    onEnd: () => ($('edPlay').textContent = '▶'),
  });
  let edit = withDefaults();
  let timeline = { clips: [], pieces: [], duration: 0 };
  const images = new Map(); // assetId -> ImageBitmap
  let musicBlob = null;
  let rebuildTimer = 0;
  let saveTimer = 0;
  let visible = false;
  const analyzing = new Map(); // takeId -> promesa del análisis en curso
  let selectedOverlay = null;

  // ---------------------------------------------------------------- utilidades

  const project = () => app.getProject();
  const fmt = (s) => app.fmtTime(s);

  function save() {
    const p = project();
    p.edit = edit;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => app.saveProject(), 400);
  }

  function setEdit(path, value) {
    const keys = path.split('.');
    if (keys.length === 1) edit[keys[0]] = value;
    else edit[keys[0]] = { ...edit[keys[0]], [keys[1]]: value };
    save();
    scheduleRebuild();
  }

  function scheduleRebuild(delay = 120) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, delay);
  }

  function rebuild() {
    timeline = buildTimeline(project(), app.segments(), app.takes(), edit);
    preview.load(timeline, edit, images, musicBlob);
    $('edEmpty').hidden = timeline.pieces.length > 0;
    $('edDuration').textContent = timeline.duration ? `${fmt(timeline.duration)} · ${timeline.clips.length} clips` : '';
    $('exportBtn').disabled = !timeline.pieces.length;
    $('coverDownload').disabled = !timeline.pieces.length;
    syncTransport(preview.t);
  }

  function syncTransport(t) {
    const d = timeline.duration || 0;
    $('edTime').textContent = `${fmt(t)} / ${fmt(d)}`;
    if (!seeking) $('edSeek').value = String(d ? Math.round((t / d) * 1000) : 0);
  }

  // ---------------------------------------------------------------- análisis de tomas

  /** Analiza una toma una sola vez, aunque se pida desde varios sitios a la vez. */
  function analyze(t) {
    if (t.analysis) return Promise.resolve();
    if (!analyzing.has(t.id)) {
      const job = (async () => {
        try {
          t.analysis = await analyzeTake(t.blob);
          await putTake(t);
        } catch (err) {
          console.error('Análisis fallido', err);
          t.analysis = { t0: 0, duration: t.duration || 1, speech: [], wave: [], width: t.width, height: t.height };
        } finally {
          analyzing.delete(t.id);
        }
      })();
      analyzing.set(t.id, job);
    }
    return analyzing.get(t.id);
  }

  async function ensureAnalysis() {
    const pending = [];
    for (const list of app.takes().values()) for (const t of list) if (!t.analysis) pending.push(t);
    if (!pending.length) return;
    const busy = $('edBusy');
    busy.hidden = false;
    let n = 0;
    // También espera a las tomas que ya se estaban analizando en segundo plano.
    for (const t of pending) {
      busy.textContent = `Analizando el audio de los clips… ${++n}/${pending.length}`;
      await analyze(t);
    }
    busy.hidden = true;
    if (visible) {
      renderClipList();
      rebuild();
    }
  }

  // ---------------------------------------------------------------- transporte

  let seeking = false;
  $('edPlay').addEventListener('click', () => {
    if (preview.playing) {
      preview.pause();
      $('edPlay').textContent = '▶';
    } else {
      preview.play();
      $('edPlay').textContent = '⏸';
    }
  });
  $('edSeek').addEventListener('input', () => {
    seeking = true;
    preview.pause();
    $('edPlay').textContent = '▶';
    preview.seek((Number($('edSeek').value) / 1000) * timeline.duration);
  });
  $('edSeek').addEventListener('change', () => (seeking = false));

  document.querySelectorAll('.ed-tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.ed-tabs button').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.ed-panel').forEach((p) => (p.hidden = p.dataset.epanel !== b.dataset.etab));
    }),
  );

  // ---------------------------------------------------------------- clips

  function clipCfg(seg) {
    const p = project();
    p.clips ??= {};
    p.clips[seg] ??= {};
    return p.clips[seg];
  }

  function updateClip(seg, patch, rerender = false) {
    Object.assign(clipCfg(seg), patch);
    app.saveProject();
    scheduleRebuild();
    if (rerender) renderClipList();
  }

  function drawWave(canvas, take, from, to) {
    const a = take.analysis;
    const ctx = canvas.getContext('2d');
    const W = (canvas.width = canvas.clientWidth * devicePixelRatio || 300);
    const H = (canvas.height = 44 * devicePixelRatio);
    ctx.clearRect(0, 0, W, H);
    if (!a?.wave?.length) return;
    const bw = W / a.wave.length;
    a.wave.forEach((v, i) => {
      const x = i * bw;
      const tt = (i / a.wave.length) * a.duration;
      const inside = tt >= from && tt <= to;
      const speaking = a.speech.some(([s, e]) => tt >= s && tt <= e);
      ctx.fillStyle = inside ? (speaking ? '#2ee6c5' : '#5b8f86') : '#3a3d48';
      const h = Math.max(2, v * H * 0.9);
      ctx.fillRect(x, (H - h) / 2, Math.max(1, bw - 1), h);
    });
  }

  function renderClipList() {
    const list = $('clipList');
    list.replaceChildren();
    const p = project();
    const segs = app.segments();
    const takes = app.takes();
    const order = orderOf(p, segs, takes);
    if (!order.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Todavía no hay guion ni clips. Escribe tu guion en la pestaña «Guion».';
      list.append(li);
    }
    order.forEach((seg, pos) => {
      const li = document.createElement('li');
      li.className = 'clip';
      const segText = segs[seg];
      const list2 = takes.get(seg) || [];
      const take = selectedTake(p, seg, takes);
      const cfg = p.clips?.[seg] || {};

      const head = document.createElement('div');
      head.className = 'clip-head';
      const num = document.createElement('span');
      num.className = 'seg-num';
      num.textContent = pos + 1;
      const txt = document.createElement('span');
      txt.className = 'seg-text';
      txt.textContent = cfg.text ?? segText ?? '(fragmento eliminado del guion)';
      const moves = document.createElement('span');
      moves.className = 'moves';
      moves.append(
        btn('↑', 'icon-sm', () => move(order, pos, -1), pos === 0),
        btn('↓', 'icon-sm', () => move(order, pos, 1), pos === order.length - 1),
      );
      head.append(num, txt, moves);
      li.append(head);

      if (list2.length) {
        // Tomas
        const chips = document.createElement('div');
        chips.className = 'chips takes';
        list2.forEach((t, i) => {
          const c = btn(`Toma ${i + 1}`, t === take ? 'active' : '', () => updateClip(seg, { take: t.id }, true));
          chips.append(c);
        });
        if (take) {
          chips.append(
            btn('✕ Borrar toma', 'ghost danger small-btn', async () => {
              if (!confirm('¿Borrar esta toma? No se puede deshacer.')) return;
              await app.deleteTake(take);
              renderClipList();
              scheduleRebuild(0);
            }),
          );
        }
        li.append(chips);

        // Recorte con forma de onda
        if (take?.analysis) {
          const a = take.analysis;
          const tl = timeline.clips.find((c) => c.seg === seg);
          const from = tl ? tl.pieces[0].srcStart : cfg.trimIn ?? 0;
          const to = tl ? tl.pieces[tl.pieces.length - 1].srcEnd : cfg.trimOut ?? a.duration;
          const wave = document.createElement('canvas');
          wave.className = 'wave';
          li.append(wave);
          requestAnimationFrame(() => drawWave(wave, take, from, to));
          const trim = document.createElement('div');
          trim.className = 'trim';
          const mk = (label, value, key) => {
            const l = document.createElement('label');
            l.className = 'slider';
            const sp = document.createElement('span');
            const b = document.createElement('b');
            b.textContent = `${value.toFixed(1)} s`;
            sp.append(label + ' ', b);
            const r = document.createElement('input');
            r.type = 'range';
            r.min = '0';
            r.max = String(a.duration.toFixed(2));
            r.step = '0.05';
            r.value = String(value);
            r.addEventListener('input', () => {
              const v = Number(r.value);
              b.textContent = `${v.toFixed(1)} s`;
              const other = key === 'trimIn' ? clipCfg(seg).trimOut ?? to : clipCfg(seg).trimIn ?? from;
              const patch = key === 'trimIn' ? { trimIn: Math.min(v, other - 0.2) } : { trimOut: Math.max(v, other + 0.2) };
              if (clipCfg(seg)[key === 'trimIn' ? 'trimOut' : 'trimIn'] == null) {
                patch[key === 'trimIn' ? 'trimOut' : 'trimIn'] = other;
              }
              updateClip(seg, patch);
              drawWave(wave, take, patch.trimIn ?? clipCfg(seg).trimIn, patch.trimOut ?? clipCfg(seg).trimOut);
            });
            l.append(sp, r);
            return l;
          };
          trim.append(mk('Empieza en', from, 'trimIn'), mk('Termina en', to, 'trimOut'));
          li.append(trim);
          const meta = document.createElement('div');
          meta.className = 'row wrap clip-actions';
          const info = document.createElement('span');
          info.className = 'muted';
          info.textContent = `Toma de ${fmt(a.duration)}`;
          meta.append(
            info,
            btn('Ver', 'ghost', () => {
              const c = timeline.clips.find((x) => x.seg === seg);
              if (c) preview.seek(c.outStart + 0.01);
              $('edCanvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
            }),
            btn('Recorte auto', 'ghost', () => updateClip(seg, { trimIn: null, trimOut: null }, true)),
          );
          li.append(meta);
        } else {
          const wait = document.createElement('p');
          wait.className = 'muted';
          wait.textContent = 'Analizando…';
          li.append(wait);
        }

        // Texto de los subtítulos
        const det = document.createElement('details');
        const sum = document.createElement('summary');
        sum.textContent = 'Texto de los subtítulos';
        const ta = document.createElement('textarea');
        ta.rows = 3;
        ta.value = cfg.text ?? segText ?? '';
        ta.addEventListener('input', () => updateClip(seg, { text: ta.value === segText ? null : ta.value }));
        det.append(sum, ta);
        li.append(det);
      }

      const actions = document.createElement('div');
      actions.className = 'row wrap clip-actions';
      if (segText !== undefined) {
        actions.append(btn(list2.length ? '● Nueva toma' : '● Grabar', list2.length ? 'ghost' : 'primary', () => app.openRecorder(seg)));
      }
      if (take) {
        actions.append(btn('Descargar toma', 'ghost', () => app.download(take.blob, `teleclip-clip-${String(pos + 1).padStart(2, '0')}.${take.mime?.includes('mp4') ? 'mp4' : 'webm'}`)));
      }
      li.append(actions);
      list.append(li);
    });
    const n = [...takes.values()].reduce((s, l) => s + l.length, 0);
    $('clearAll').disabled = n === 0;
  }

  function move(order, pos, dir) {
    const o = [...order];
    const [x] = o.splice(pos, 1);
    o.splice(pos + dir, 0, x);
    project().order = o;
    app.saveProject();
    renderClipList();
    scheduleRebuild(0);
  }

  function btn(label, cls, onClick, disabled = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  $('edAutoTrim').addEventListener('change', (e) => setEdit('autoTrim', e.target.checked));
  $('edSilence').addEventListener('change', (e) => setEdit('silence', e.target.value));
  $('clearAll').addEventListener('click', async () => {
    if (!confirm('¿Borrar todas las tomas de este vídeo? No se puede deshacer.')) return;
    for (const list of [...app.takes().values()]) for (const t of [...list]) await app.deleteTake(t);
    renderClipList();
    scheduleRebuild(0);
  });

  // ---------------------------------------------------------------- subtítulos

  const capUi = () => {
    const c = edit.captions;
    $('capOn').checked = c.on;
    document.querySelectorAll('#capStyles button').forEach((b) => b.classList.toggle('active', b.dataset.style === c.style));
    $('capFont').value = c.font;
    $('capSize').value = String(Math.round(c.size * 100));
    $('capSizeVal').textContent = `${Math.round(c.size * 100)}%`;
    $('capPos').value = String(Math.round(c.position * 100));
    $('capPosVal').textContent = c.position < 0.35 ? 'arriba' : c.position > 0.65 ? 'abajo' : 'centro';
    $('capWords').value = String(c.maxWords);
    $('capWordsVal').textContent = String(c.maxWords);
    $('capUpper').checked = c.upper;
    $('capColor').value = c.color;
    $('capAccent').value = c.accent;
  };
  const setCap = (k, v) => {
    setEdit(`captions.${k}`, v);
    capUi();
  };
  $('capOn').addEventListener('change', (e) => setCap('on', e.target.checked));
  document.querySelectorAll('#capStyles button').forEach((b) =>
    b.addEventListener('click', () => {
      setCap('style', b.dataset.style);
      if (!edit.captions.on) setCap('on', true);
    }),
  );
  $('capFont').addEventListener('change', (e) => setCap('font', e.target.value));
  $('capSize').addEventListener('input', (e) => setCap('size', Number(e.target.value) / 100));
  $('capPos').addEventListener('input', (e) => setCap('position', Number(e.target.value) / 100));
  $('capWords').addEventListener('input', (e) => setCap('maxWords', Number(e.target.value)));
  $('capUpper').addEventListener('change', (e) => setCap('upper', e.target.checked));
  $('capColor').addEventListener('input', (e) => setCap('color', e.target.value));
  $('capAccent').addEventListener('input', (e) => setCap('accent', e.target.value));

  // ---------------------------------------------------------------- efectos

  const fxUi = () => {
    $('fxZoom').value = edit.zoom;
    $('fxTransition').value = edit.transition;
    $('fxFormat').value = edit.format;
    $('fxReframe').value = String(Math.round(edit.reframe * 100));
    $('fxReframeVal').textContent = edit.reframe < 0.35 ? 'arriba' : edit.reframe > 0.65 ? 'abajo' : 'centro';
    $('fxReframeField').hidden = edit.format === 'auto';
  };
  $('fxZoom').addEventListener('change', (e) => setEdit('zoom', e.target.value));
  $('fxTransition').addEventListener('change', (e) => setEdit('transition', e.target.value));
  $('fxFormat').addEventListener('change', (e) => {
    setEdit('format', e.target.value);
    fxUi();
  });
  $('fxReframe').addEventListener('input', (e) => {
    setEdit('reframe', Number(e.target.value) / 100);
    fxUi();
  });

  // ---------------------------------------------------------------- audio

  const audioUi = () => {
    const m = edit.music;
    $('musicName').textContent = m.assetId ? m.name || 'Canción' : 'Sin música';
    $('musicRemove').hidden = !m.assetId;
    $('musicVol').value = String(Math.round(m.volume * 100));
    $('musicVolVal').textContent = `${Math.round(m.volume * 100)}%`;
    $('musicDuck').checked = m.duck;
    $('voiceEnhance').checked = edit.voice.enhance;
    $('voiceGate').checked = edit.voice.gate;
    $('voiceVol').value = String(Math.round(edit.voice.volume * 100));
    $('voiceVolVal').textContent = `${Math.round(edit.voice.volume * 100)}%`;
  };
  $('musicPick').addEventListener('click', () => $('musicFile').click());
  $('musicFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (edit.music.assetId) await deleteAsset(edit.music.assetId);
    const id = uid();
    await putAsset({ id, projectId: project().id, kind: 'music', name: file.name, blob: file });
    musicBlob = file;
    setEdit('music', { ...edit.music, assetId: id, name: file.name.replace(/\.[^.]+$/, '') });
    audioUi();
    app.toast('Música añadida');
  });
  $('musicRemove').addEventListener('click', async () => {
    if (edit.music.assetId) await deleteAsset(edit.music.assetId);
    musicBlob = null;
    setEdit('music', { ...edit.music, assetId: null, name: '' });
    audioUi();
  });
  $('musicVol').addEventListener('input', (e) => {
    setEdit('music.volume', Number(e.target.value) / 100);
    audioUi();
  });
  $('musicDuck').addEventListener('change', (e) => setEdit('music.duck', e.target.checked));
  $('voiceEnhance').addEventListener('change', (e) => setEdit('voice.enhance', e.target.checked));
  $('voiceGate').addEventListener('change', (e) => setEdit('voice.gate', e.target.checked));
  $('voiceVol').addEventListener('input', (e) => {
    setEdit('voice.volume', Number(e.target.value) / 100);
    audioUi();
  });

  // ---------------------------------------------------------------- elementos

  async function loadImage(assetId) {
    if (!assetId || images.has(assetId)) return;
    const a = await getAsset(assetId);
    if (a?.blob) images.set(assetId, await createImageBitmap(a.blob));
  }

  function addOverlay(ov) {
    const t = preview.t;
    const o = { id: uid(), x: 0.5, y: 0.3, size: 1, color: '#ffffff', bg: '', start: t, end: Math.min(timeline.duration, t + 3), ...ov };
    setEdit('overlays', [...edit.overlays, o]);
    selectedOverlay = o.id;
    renderOverlays();
  }

  function updateOverlay(id, patch, rerender = false) {
    setEdit('overlays', edit.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)));
    if (rerender) renderOverlays();
    if (!preview.playing) preview.draw();
  }

  function renderOverlays() {
    const list = $('overlayList');
    list.replaceChildren();
    for (const o of edit.overlays) {
      const li = document.createElement('li');
      li.className = 'clip overlay' + (o.id === selectedOverlay ? ' selected' : '');
      li.addEventListener('click', () => {
        if (selectedOverlay !== o.id) {
          selectedOverlay = o.id;
          document.querySelectorAll('.overlay').forEach((x) => x.classList.toggle('selected', x === li));
        }
      });
      const head = document.createElement('div');
      head.className = 'row wrap';
      if (o.type === 'image') {
        const s = document.createElement('span');
        s.textContent = '🖼 Imagen';
        head.append(s);
      } else {
        const inp = document.createElement(o.type === 'text' ? 'textarea' : 'input');
        inp.value = o.text;
        if (o.type === 'text') inp.rows = 2;
        inp.className = o.type === 'emoji' ? 'emoji-input' : '';
        inp.addEventListener('input', () => updateOverlay(o.id, { text: inp.value }));
        head.append(inp);
      }
      if (o.type === 'text') {
        const c = document.createElement('label');
        c.className = 'color';
        const ci = document.createElement('input');
        ci.type = 'color';
        ci.value = o.color;
        ci.addEventListener('input', () => updateOverlay(o.id, { color: ci.value }));
        c.append(ci, ' Color');
        const bgL = document.createElement('label');
        bgL.className = 'check';
        const bgI = document.createElement('input');
        bgI.type = 'checkbox';
        bgI.checked = !!o.bg;
        bgI.addEventListener('change', () => updateOverlay(o.id, { bg: bgI.checked ? 'rgba(0,0,0,.6)' : '' }));
        bgL.append(bgI, ' Fondo');
        head.append(c, bgL);
      }
      li.append(head);
      if (o.type === 'emoji') {
        const pal = document.createElement('div');
        pal.className = 'chips';
        for (const e of EMOJIS) pal.append(btn(e, 'emoji-chip', () => updateOverlay(o.id, { text: e }, true)));
        li.append(pal);
      }
      const size = document.createElement('label');
      size.className = 'slider';
      const ss = document.createElement('span');
      ss.textContent = 'Tamaño';
      const sr = document.createElement('input');
      sr.type = 'range';
      sr.min = '30';
      sr.max = o.type === 'image' ? '90' : '300';
      sr.value = String(Math.round((o.type === 'image' ? o.size * 100 : o.size * 100)));
      sr.addEventListener('input', () => updateOverlay(o.id, { size: Number(sr.value) / 100 }));
      size.append(ss, sr);
      li.append(size);
      const times = document.createElement('div');
      times.className = 'row wrap';
      const tinfo = document.createElement('span');
      tinfo.className = 'muted';
      const showTimes = () => (tinfo.textContent = `${fmt(o.start)} → ${o.end == null ? 'final' : fmt(o.end)}`);
      showTimes();
      times.append(
        tinfo,
        btn('Empieza aquí', 'ghost small-btn', () => updateOverlay(o.id, { start: preview.t, end: o.end != null && o.end <= preview.t ? preview.t + 2 : o.end }, true)),
        btn('Acaba aquí', 'ghost small-btn', () => updateOverlay(o.id, { end: Math.max(preview.t, o.start + 0.3) }, true)),
        btn('Todo el vídeo', 'ghost small-btn', () => updateOverlay(o.id, { start: 0, end: null }, true)),
        btn('Borrar', 'ghost danger small-btn', () => {
          setEdit('overlays', edit.overlays.filter((x) => x.id !== o.id));
          renderOverlays();
        }),
      );
      li.append(times);
      list.append(li);
    }
  }

  $('addText').addEventListener('click', () => addOverlay({ type: 'text', text: 'Escribe aquí', bg: 'rgba(0,0,0,.6)' }));
  $('addEmoji').addEventListener('click', () => addOverlay({ type: 'emoji', text: '🔥', y: 0.2 }));
  $('addImage').addEventListener('click', () => $('imageFile').click());
  $('imageFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const id = uid();
    await putAsset({ id, projectId: project().id, kind: 'image', name: file.name, blob: file });
    await loadImage(id);
    addOverlay({ type: 'image', assetId: id, size: 0.4, y: 0.35 });
  });

  // Arrastrar elementos sobre la vista previa
  {
    const cv = $('edCanvas');
    let drag = null;
    const toUnit = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    cv.addEventListener('pointerdown', (e) => {
      const visibleNow = edit.overlays.filter((o) => preview.t >= (o.start ?? 0) && preview.t <= (o.end ?? Infinity));
      if (!visibleNow.length) return;
      const p = toUnit(e);
      let best = null;
      let bestD = 0.18;
      for (const o of visibleNow) {
        const d = Math.hypot(o.x - p.x, (o.y - p.y) * (cv.height / cv.width));
        if (d < bestD) {
          bestD = d;
          best = o;
        }
      }
      if (!best) return;
      e.preventDefault();
      cv.setPointerCapture(e.pointerId);
      selectedOverlay = best.id;
      drag = { id: best.id, dx: best.x - p.x, dy: best.y - p.y };
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = toUnit(e);
      const o = edit.overlays.find((x) => x.id === drag.id);
      if (!o) return;
      o.x = Math.min(0.98, Math.max(0.02, p.x + drag.dx));
      o.y = Math.min(0.98, Math.max(0.02, p.y + drag.dy));
      if (!preview.playing) preview.draw();
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      save();
      renderOverlays();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }

  const logoUi = () => {
    const l = edit.logo;
    $('logoRemove').hidden = !l.assetId;
    $('logoOpts').hidden = !l.assetId;
    $('logoCorner').value = l.corner;
    $('logoSize').value = String(Math.round(l.size * 100));
    $('logoSizeVal').textContent = `${Math.round(l.size * 100)}%`;
    $('logoOp').value = String(Math.round(l.opacity * 100));
    $('logoOpVal').textContent = `${Math.round(l.opacity * 100)}%`;
    $('progOn').checked = edit.progress.on;
    $('progColor').value = edit.progress.color;
    $('progPos').value = edit.progress.position;
  };
  $('logoPick').addEventListener('click', () => $('logoFile').click());
  $('logoFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (edit.logo.assetId) await deleteAsset(edit.logo.assetId);
    const id = uid();
    await putAsset({ id, projectId: project().id, kind: 'logo', name: file.name, blob: file });
    await loadImage(id);
    setEdit('logo.assetId', id);
    logoUi();
  });
  $('logoRemove').addEventListener('click', async () => {
    if (edit.logo.assetId) await deleteAsset(edit.logo.assetId);
    setEdit('logo.assetId', null);
    logoUi();
  });
  $('logoCorner').addEventListener('change', (e) => setEdit('logo.corner', e.target.value));
  $('logoSize').addEventListener('input', (e) => {
    setEdit('logo.size', Number(e.target.value) / 100);
    logoUi();
  });
  $('logoOp').addEventListener('input', (e) => {
    setEdit('logo.opacity', Number(e.target.value) / 100);
    logoUi();
  });
  $('progOn').addEventListener('change', (e) => setEdit('progress.on', e.target.checked));
  $('progColor').addEventListener('input', (e) => setEdit('progress.color', e.target.value));
  $('progPos').addEventListener('change', (e) => setEdit('progress.position', e.target.value));

  // ---------------------------------------------------------------- portada y exportación

  const exportUi = () => {
    $('exportRes').value = String(edit.resolution);
    $('coverTitle').value = edit.cover.title;
    $('coverFirst').checked = edit.cover.firstFrame;
    $('coverTime').textContent = edit.cover.time == null ? 'Portada: primer segundo' : `Portada en ${fmt(edit.cover.time)}`;
  };
  $('exportRes').addEventListener('change', (e) => {
    const v = e.target.value;
    setEdit('resolution', v === 'original' ? 'original' : Number(v));
  });
  $('coverHere').addEventListener('click', () => {
    setEdit('cover.time', preview.t);
    exportUi();
    app.toast(`Portada: ${fmt(preview.t)}`);
  });
  $('coverTitle').addEventListener('input', (e) => setEdit('cover.title', e.target.value));
  $('coverFirst').addEventListener('change', (e) => setEdit('cover.firstFrame', e.target.checked));
  $('coverDownload').addEventListener('click', async () => {
    try {
      const { renderCover } = await import('./export.js');
      const { outputDims } = await import('./render.js');
      const first = timeline.pieces[0].take.analysis;
      const { width, height } = outputDims(first.width || 1080, first.height || 1920, edit.format, edit.resolution === 'original' ? 1080 : edit.resolution);
      const cv = new OffscreenCanvas(width, height);
      await renderCover(cv.getContext('2d'), width, height, { timeline, edit, images, cache: new Map() });
      const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
      app.download(blob, `${app.fileBase()}-portada.jpg`);
    } catch (err) {
      console.error(err);
      app.toast('No se pudo crear la portada');
    }
  });

  let exportFile = null;
  let exportUrl = null;
  $('exportBtn').addEventListener('click', async () => {
    if (!timeline.pieces.length) return;
    preview.pause();
    $('edPlay').textContent = '▶';
    const bar = $('exportProgress');
    const status = $('exportStatus');
    $('exportBtn').disabled = true;
    $('exportResult').hidden = true;
    bar.hidden = false;
    bar.firstElementChild.style.width = '0%';
    status.textContent = 'Preparando…';
    try {
      const mod = await import('./export.js');
      let result;
      if (mod.isPlainEdit(edit, project())) {
        status.textContent = 'Uniendo clips…';
        result = await mod.joinClips(timeline.clips.map((c) => c.take.blob), {
          resolution: edit.resolution,
          onProgress: (p) => (bar.firstElementChild.style.width = `${Math.round(p * 100)}%`),
        });
      } else {
        result = await mod.exportEdited({
          timeline, edit, images, musicBlob,
          onProgress: (p, stage) => {
            bar.firstElementChild.style.width = `${Math.round(p * 100)}%`;
            status.textContent = stage === 'audio' ? 'Mezclando el audio…' : `Creando el vídeo… ${Math.round(p * 100)}%`;
          },
        });
      }
      if (exportUrl) URL.revokeObjectURL(exportUrl);
      exportUrl = URL.createObjectURL(result.blob);
      exportFile = new File([result.blob], `${app.fileBase()}.${result.ext}`, { type: result.mime });
      $('exportVideo').src = exportUrl;
      $('exportResult').hidden = false;
      $('shareExport').hidden = !(navigator.canShare && navigator.canShare({ files: [exportFile] }));
      const mb = (result.blob.size / 1048576).toFixed(1);
      status.textContent = `Listo: ${fmt(timeline.duration)} · ${result.width}×${result.height} · ${mb} MB · MP4 (${result.mode}).`;
      bar.firstElementChild.style.width = '100%';
    } catch (err) {
      console.error(err);
      status.textContent = `No se pudo exportar: ${err?.message || err}`;
    } finally {
      $('exportBtn').disabled = false;
      setTimeout(() => (bar.hidden = true), 800);
    }
  });
  $('downloadExport').addEventListener('click', () => exportFile && app.download(exportFile, exportFile.name));
  $('shareExport').addEventListener('click', async () => {
    try {
      await navigator.share({ files: [exportFile], title: project().name });
    } catch {
      /* cancelado */
    }
  });

  // ---------------------------------------------------------------- ciclo de vida

  async function loadProjectAssets() {
    images.clear();
    musicBlob = null;
    const ids = [edit.logo.assetId, ...edit.overlays.filter((o) => o.type === 'image').map((o) => o.assetId)];
    for (const id of ids) await loadImage(id).catch(() => {});
    if (edit.music.assetId) musicBlob = (await getAsset(edit.music.assetId))?.blob ?? null;
  }

  function syncAll() {
    $('edAutoTrim').checked = edit.autoTrim;
    $('edSilence').value = edit.silence;
    capUi();
    fxUi();
    audioUi();
    logoUi();
    exportUi();
    renderOverlays();
  }

  return {
    async show() {
      visible = true;
      edit = withDefaults(project().edit);
      await loadProjectAssets();
      syncAll();
      renderClipList();
      rebuild();
      ensureAnalysis();
    },
    hide() {
      visible = false;
      preview.pause();
      $('edPlay').textContent = '▶';
    },
    /** Algo cambió fuera (nueva toma, guion, proyecto). */
    refresh() {
      if (!visible) return;
      edit = withDefaults(project().edit);
      renderClipList();
      rebuild();
      ensureAnalysis();
    },
    /** Analiza en segundo plano una toma recién grabada (y actualiza el editor si está abierto). */
    async analyzeInBackground(take) {
      await analyze(take);
      if (visible) {
        renderClipList();
        rebuild();
      }
    },
  };
}
