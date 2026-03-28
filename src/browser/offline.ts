const DB_NAME = "obtrace_offline";
const STORE_NAME = "queue";
const MAX_ENTRIES = 500;
const MAX_BYTES = 5 * 1024 * 1024;

let db: IDBDatabase | null = null;
let draining = false;

function openDB(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      store.createIndex("ts", "ts");
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

async function countAndSize(): Promise<{ count: number; size: number }> {
  const idb = await openDB();
  return new Promise((resolve) => {
    const tx = idb.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const countReq = store.count();
    let totalSize = 0;
    let count = 0;
    countReq.onsuccess = () => { count = countReq.result; };
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        totalSize += (cursor.value.payload as string).length;
        cursor.continue();
      } else {
        resolve({ count, size: totalSize });
      }
    };
    cursorReq.onerror = () => resolve({ count, size: totalSize });
  });
}

export async function enqueueOffline(url: string, payload: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const { count, size } = await countAndSize();
    if (count >= MAX_ENTRIES || size + payload.length > MAX_BYTES) return false;

    const idb = await openDB();
    return new Promise((resolve) => {
      const tx = idb.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).add({ ts: Date.now(), url, payload, headers });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

export async function drainOfflineQueue(): Promise<void> {
  if (draining || !navigator.onLine) return;
  draining = true;

  try {
    const idb = await openDB();
    const entries: Array<{ id: number; url: string; payload: string; headers: Record<string, string> }> = [];

    await new Promise<void>((resolve) => {
      const tx = idb.transaction(STORE_NAME, "readonly");
      const cursorReq = tx.objectStore(STORE_NAME).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          entries.push(cursor.value as typeof entries[0]);
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => resolve();
    });

    for (const entry of entries) {
      try {
        const res = await fetch(entry.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...entry.headers },
          body: entry.payload,
        });
        if (res.ok || res.status === 400) {
          const tx = idb.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).delete(entry.id);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  } catch {
  } finally {
    draining = false;
  }
}

export function installOfflineSupport(): () => void {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return () => {};

  const onOnline = () => drainOfflineQueue();
  window.addEventListener("online", onOnline);

  drainOfflineQueue();

  return () => window.removeEventListener("online", onOnline);
}
