// Almacenamiento local: el guion y los ajustes en localStorage, los clips (vídeo) en IndexedDB.
// Nada sale del dispositivo.

const DB_NAME = 'teleclip';
const STORE = 'clips';
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'seg' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Un clip por fragmento del guion: { seg, text, blob, mime, duration, createdAt } */
export const putClip = (clip) => run('readwrite', (s) => s.put(clip));
export const getClips = () => run('readonly', (s) => s.getAll());
export const deleteClip = (seg) => run('readwrite', (s) => s.delete(seg));
export const clearClips = () => run('readwrite', (s) => s.clear());

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
