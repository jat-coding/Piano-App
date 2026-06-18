import type { Song, NoteEvent } from '../types';

const DB_NAME = 'cascade';
const STORE = 'songs';
const VERSION = 1;

export type SongKind = 'midi' | 'audio' | 'video';

export interface SavedSong {
  id: string;
  name: string;
  kind: SongKind;
  duration: number;
  createdAt: number;
  lastPlayedAt?: number; // for "last practiced first"
  notes: NoteEvent[];
}

export type SavedSongMeta = Omit<SavedSong, 'notes'>;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export async function saveSong(song: Song, kind: SongKind): Promise<SavedSong> {
  const record: SavedSong = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: song.name,
    kind,
    duration: song.duration,
    createdAt: Date.now(),
    notes: song.notes,
  };
  await tx('readwrite', (s) => s.put(record));
  return record;
}

export async function listSongs(): Promise<SavedSongMeta[]> {
  const all = await tx<SavedSong[]>('readonly', (s) => s.getAll() as IDBRequest<SavedSong[]>);
  return all
    .map(({ notes: _notes, ...meta }) => meta)
    // Last-practiced first; songs never played fall back to most-recently added.
    .sort((a, b) => (b.lastPlayedAt ?? b.createdAt) - (a.lastPlayedAt ?? a.createdAt));
}

/** Mark a song as just practiced (moves it to the front of the rack). */
export async function touchSong(id: string): Promise<void> {
  const rec = await tx<SavedSong | undefined>(
    'readonly',
    (s) => s.get(id) as IDBRequest<SavedSong | undefined>,
  );
  if (!rec) return;
  rec.lastPlayedAt = Date.now();
  await tx('readwrite', (s) => s.put(rec));
}

export async function getSong(id: string): Promise<Song | null> {
  const rec = await tx<SavedSong | undefined>(
    'readonly',
    (s) => s.get(id) as IDBRequest<SavedSong | undefined>,
  );
  if (!rec) return null;
  return { name: rec.name, notes: rec.notes, duration: rec.duration };
}

export async function deleteSong(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}
