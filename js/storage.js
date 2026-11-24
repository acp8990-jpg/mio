// Almacenamiento local: ajustes en localStorage; proyectos, tomas de vídeo y archivos (música, logo)
// en IndexedDB. Nada sale del dispositivo.

const DB_NAME = 'teleclip';
const DB_VERSION = 2;
let dbPromise = null;

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        const tx = req.transaction;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('takes')) {
          db.createObjectStore('takes', { keyPath: 'id' }).createIndex('project', 'projectId');
        }
        if (!db.objectStoreNames.contains('assets')) {
          db.createObjectStore('assets', { keyPath: 'id' }).createIndex('project', 'projectId');
        }
        // Versión 1 → 2: los clips sueltos pasan a ser tomas del primer proyecto.
        if (e.oldVersion >= 1 && db.objectStoreNames.contains('clips')) {
          const projects = tx.objectStore('projects');
          const takes = tx.objectStore('takes');
          let script = '';
          let splitMode = 'paragraphs';
          try {
            script = localStorage.getItem('teleclip.script') ?? '';
            splitMode = JSON.parse(localStorage.getItem('teleclip.settings') || '{}').splitMode || splitMode;
          } catch {
            /* sin localStorage */
          }
          const now = Date.now();
          projects.put({ id: 'p1', name: 'Mi primer vídeo', createdAt: now, updatedAt: now, script, splitMode, clips: {}, edit: {} });
          tx.objectStore('clips').getAll().onsuccess = (ev) => {
            for (const c of ev.target.result) {
              takes.put({
                id: uid(), projectId: 'p1', seg: c.seg, blob: c.blob, mime: c.mime, duration: c.duration,
                width: c.width, height: c.height, createdAt: c.createdAt || now,
              });
            }
            db.deleteObjectStore('clips');
          };
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---- proyectos: { id, name, createdAt, updatedAt, script, splitMode, clips: {seg: {...}}, edit: {...}, order }
export const listProjects = () => run('projects', 'readonly', (s) => s.getAll());
export const getProject = (id) => run('projects', 'readonly', (s) => s.get(id));
export const putProject = (p) => run('projects', 'readwrite', (s) => s.put({ ...p, updatedAt: Date.now() }));

export async function deleteProject(id) {
  for (const t of await takesFor(id)) await deleteTake(t.id);
  for (const a of await assetsFor(id)) await deleteAsset(a.id);
  await run('projects', 'readwrite', (s) => s.delete(id));
}

// ---- tomas: { id, projectId, seg, blob, mime, duration, width, height, createdAt, analysis? }
export const takesFor = (projectId) => run('takes', 'readonly', (s) => s.index('project').getAll(projectId));
export const putTake = (t) => run('takes', 'readwrite', (s) => s.put(t));
export const deleteTake = (id) => run('takes', 'readwrite', (s) => s.delete(id));

// ---- archivos del proyecto (música, logo, imágenes): { id, projectId, kind, name, blob }
export const assetsFor = (projectId) => run('assets', 'readonly', (s) => s.index('project').getAll(projectId));
export const getAsset = (id) => run('assets', 'readonly', (s) => s.get(id));
export const putAsset = (a) => run('assets', 'readwrite', (s) => s.put(a));
export const deleteAsset = (id) => run('assets', 'readwrite', (s) => s.delete(id));

// ---- ajustes sencillos
export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

export function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* modo privado o almacenamiento lleno: seguimos sin guardar */
  }
}

export function loadText(key) {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function saveText(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {
    /* no disponible */
  }
}
