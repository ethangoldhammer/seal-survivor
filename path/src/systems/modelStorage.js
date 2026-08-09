// Uploaded models (currently just the shrimp ring) live in memory only via
// assets.js's loadedModels map — nothing about them survives a reload. The
// rest of the tuning system persists through localStorage, but a model can
// be several MB, and localStorage's quota (usually 5-10MB total, shared with
// every other saved setting) isn't built for that. IndexedDB is — much
// larger quota, designed for binary blobs — so uploaded models get their own
// small persistence layer here instead of being squeezed into the same
// mechanism as everything else.

const DB_NAME = 'seal-survivor-models';
const STORE = 'uploads';

function openDB() {
  return new Promise((resolve, reject) => {
    // IndexedDB is unavailable or disabled in some contexts (sandboxed
    // iframes, private-mode variants). Fail fast rather than constructing a
    // request against undefined.
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('IndexedDB unavailable in this context'));
      return;
    }
    // A blocked/partitioned IndexedDB can hang forever without firing EITHER
    // onsuccess or onerror. Nothing here is important enough to stall the
    // game behind, so give up after a moment and let callers carry on.
    const timer = setTimeout(() => reject(new Error('IndexedDB open timed out')), 2000);
    const settle = (fn) => (v) => { clearTimeout(timer); fn(v); };
    resolve = settle(resolve);
    reject = settle(reject);

    const req = indexedDB.open(DB_NAME, 1);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveModelToDB(key, file) {
  const buffer = await file.arrayBuffer();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ buffer, name: file.name }, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// Returns a real File reconstructed from the stored bytes, or null if
// nothing's saved for this key.
export async function loadModelFromDB(key) {
  const db = await openDB();
  const record = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  if (!record) return null;
  return new File([record.buffer], record.name);
}

// Every key that has a saved model, so boot can restore them ALL before any
// mesh is created.
export async function listSavedModelKeys() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteModelFromDB(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
