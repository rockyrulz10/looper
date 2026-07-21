// Minimal IndexedDB wrapper for persisting tracks + samples across reloads
// (iOS Safari can reload backgrounded tabs, so we auto-save).
const DB_NAME = 'looper-db';
const DB_VERSION = 2;
const STORE = 'tracks';
const SAMPLE_STORE = 'samples';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SAMPLE_STORE)) {
        db.createObjectStore(SAMPLE_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function put(store, record) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function del(store, id) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function getAll(store) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function clear(store) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

const Storage = {
  saveTrack: (t) => put(STORE, t),
  deleteTrack: (id) => del(STORE, id),
  async loadAllTracks() {
    const all = await getAll(STORE);
    return all.sort((a, b) => a.order - b.order);
  },

  saveSample: (s) => put(SAMPLE_STORE, s),
  deleteSample: (id) => del(SAMPLE_STORE, id),
  async loadAllSamples() {
    const all = await getAll(SAMPLE_STORE);
    return all.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  },

  async clearAll() {
    await clear(STORE);
    await clear(SAMPLE_STORE);
  },
};
