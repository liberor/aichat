import type { Conv } from './types';

const DB_NAME = 'ai-chat-mvp';
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('conversations')) {
        db.createObjectStore('conversations', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export async function allConvs(tenant: string): Promise<Conv[]> {
  const list = await tx<Conv[]>('conversations', 'readonly', (s) => s.getAll());
  return list
    .filter((c) => c.tenant === tenant)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 旧版本没有 tenant 字段的会话，先不展示，由用户决定归到当前租户还是删除 */
export async function legacyConvs(): Promise<Conv[]> {
  const list = await tx<Conv[]>('conversations', 'readonly', (s) => s.getAll());
  return list.filter((c) => !c.tenant);
}

export async function claimLegacyConvs(tenant: string): Promise<number> {
  const list = await legacyConvs();
  for (const c of list) {
    await putConv({
      ...c,
      tenant,
      runId: undefined,
      lastEventId: undefined,
      messages: c.messages.map((m) => (m.pending ? { ...m, pending: false } : m)),
    });
  }
  return list.length;
}

export async function deleteLegacyConvs(): Promise<number> {
  const list = await legacyConvs();
  for (const c of list) await delConv(c.id);
  return list.length;
}

export async function putConv(conv: Conv): Promise<void> {
  await tx('conversations', 'readwrite', (s) => s.put(conv));
}

export async function delConv(id: string): Promise<void> {
  await tx('conversations', 'readwrite', (s) => s.delete(id));
}

export async function kvGet<T>(k: string): Promise<T | undefined> {
  const row = await tx<{ k: string; v: T } | undefined>('kv', 'readonly', (s) => s.get(k));
  return row?.v;
}

export async function kvSet<T>(k: string, v: T): Promise<void> {
  await tx('kv', 'readwrite', (s) => s.put({ k, v }));
}
