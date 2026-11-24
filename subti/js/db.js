// Proyectos guardados en el propio dispositivo (IndexedDB). El vídeo nunca sale del móvil.

const DB_NAME = 'subti';
const STORE = 'projects';
let dbp = null;

function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** { id, name, file, thumb, words, settings, duration, width, height, created, updated } */
export const saveProject = (p) => run('readwrite', (s) => s.put({ ...p, updated: Date.now() }));
export const getProject = (id) => run('readonly', (s) => s.get(id));
export const deleteProject = (id) => run('readwrite', (s) => s.delete(id));

/** Lista sin el vídeo, para la pantalla de inicio. */
export async function listProjects() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const { file, ...meta } = c.value;
      out.push(meta);
      c.continue();
    };
    tx.oncomplete = () => resolve(out.sort((a, b) => b.updated - a.updated));
    tx.onerror = () => reject(tx.error);
  });
}

export function prefs(key, fallback) {
  try {
    const v = localStorage.getItem(`subti.${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function setPrefs(key, value) {
  try {
    localStorage.setItem(`subti.${key}`, JSON.stringify(value));
  } catch {
    /* sin almacenamiento: seguimos */
  }
}
