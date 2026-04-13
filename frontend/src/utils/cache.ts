import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { Job } from '../types';

interface AppDB extends DBSchema {
  jobs: { key: string; value: Job & { cachedAt: number } };
  prefs: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<AppDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<AppDB>('applybot', 1, {
      upgrade(db) {
        db.createObjectStore('jobs', { keyPath: 'id' });
        db.createObjectStore('prefs');
      },
    });
  }
  return dbPromise;
}

const TTL = 30 * 60 * 1000; // 30 min

/** Cache up to 50 jobs in IndexedDB */
export async function cacheJobs(jobs: Job[]): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction('jobs', 'readwrite');
    await tx.store.clear();
    await Promise.all(jobs.slice(0, 50).map(j => tx.store.put({ ...j, cachedAt: Date.now() })));
    await tx.done;
  } catch { /* non-critical */ }
}

/** Get cached jobs (expires after TTL) */
export async function getCachedJobs(): Promise<Job[]> {
  try {
    const db = await getDB();
    const all = await db.getAll('jobs');
    const now = Date.now();
    const fresh = all.filter(j => now - j.cachedAt < TTL);

    const stale = all.filter(j => now - j.cachedAt >= TTL);
    if (stale.length) {
      const tx = db.transaction('jobs', 'readwrite');
      await Promise.all(stale.map(j => tx.store.delete(j.id)));
      await tx.done;
    }

    return fresh;
  } catch {
    return [];
  }
}

/** Store user preference */
export async function setPref(key: string, value: unknown): Promise<void> {
  try {
    const db = await getDB();
    await db.put('prefs', value, key);
  } catch { /* non-critical */ }
}

/** Get user preference */
export async function getPref<T>(key: string): Promise<T | undefined> {
  try {
    const db = await getDB();
    return db.get('prefs', key) as Promise<T | undefined>;
  } catch {
    return undefined;
  }
}