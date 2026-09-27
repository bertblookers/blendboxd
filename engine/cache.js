// The browser's TMDb cache: compact responses in IndexedDB, loaded into memory in
// one read at startup (a warm blend then does no per-film disk I/O). Entries expire
// after MAX_AGE_DAYS, safely inside TMDb's 6-month caching limit (API terms §1.C).
// Every failure degrades to an in-memory cache: a blend never breaks over storage.

const DB_NAME = 'blendboxd';
const DB_VERSION = 1;
export const MAX_AGE_DAYS = 150;
const DAY_MS = 24 * 3600 * 1000;

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tmdb')) db.createObjectStore('tmdb');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});
const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function kvGet(key) {
  const db = await openDb();
  try {
    return await request(db.transaction('kv').objectStore('kv').get(key));
  } finally {
    db.close();
  }
}

export async function kvSet(key, value) {
  const db = await openDb();
  try {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    await done(tx);
  } finally {
    db.close();
  }
}

// -> {get(key), set(key, value), flush(), size, persistent}
export async function openTmdbCache({ now = Date.now(), maxAgeDays = MAX_AGE_DAYS } = {}) {
  const mem = new Map();
  let db = null;
  try {
    db = await openDb();
    const tx = db.transaction('tmdb');
    const store = tx.objectStore('tmdb');
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    const expired = [];
    const cutoff = now - maxAgeDays * DAY_MS;
    keys.forEach((k, i) => {
      const entry = values[i];
      if (entry && entry.t >= cutoff) mem.set(k, entry.v);
      else expired.push(k);
    });
    if (expired.length) {
      const del = db.transaction('tmdb', 'readwrite');
      for (const k of expired) del.objectStore('tmdb').delete(k);
      done(del).catch(() => {});
    }
  } catch {
    db = null; // no IndexedDB (or it failed): this session caches in memory only
  }

  let pending = new Map();
  let timer = null;
  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!db || !pending.size) return;
    const batch = pending;
    pending = new Map();
    try {
      const tx = db.transaction('tmdb', 'readwrite');
      const store = tx.objectStore('tmdb');
      const t = Date.now();
      for (const [k, v] of batch) store.put({ t, v }, k);
      await done(tx);
    } catch {
      db = null; // e.g. quota exceeded: stop persisting, keep the in-memory copy
    }
  };

  return {
    get: key => mem.get(key),
    set(key, value) {
      mem.set(key, value);
      if (!db) return;
      pending.set(key, value);
      if (pending.size >= 400) flush();
      else if (!timer) timer = setTimeout(flush, 1000);
    },
    flush,
    get size() { return mem.size; },
    get persistent() { return db != null; },
  };
}
