import type { Song, NoteEvent } from '../types';
import { mergeGhostReonsets } from './reonsets';

const DB_NAME = 'cascade';
const STORE = 'songs';
/** v2 added MEDIA: the original recording for each audio/video song (for video export). */
const MEDIA = 'media';
const VERSION = 2;

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

/**
 * The original file a song was transcribed from, plus the trimmed selection
 * (seconds into the file). Kept in its own store, keyed by song id, so listing
 * the rack never loads the blobs. Songs saved before v2 (and MIDI songs) have none.
 */
export interface SongMedia {
  id: string;
  kind: 'audio' | 'video';
  blob: Blob;
  fileName: string;
  mimeType: string;
  trimStart: number;
  trimEnd: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      // Additive upgrades only: v1 songs stay untouched in STORE.
      if (e.oldVersion < 1 && !db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (e.oldVersion < 2 && !db.objectStoreNames.contains(MEDIA)) {
        db.createObjectStore(MEDIA, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
  storeName: string = STORE,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const req = fn(t.objectStore(storeName));
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
  // Songs transcribed before the re-onset cleanup existed get it on load (a no-op for newer ones).
  const notes = rec.kind === 'midi' ? rec.notes : mergeGhostReonsets(rec.notes).notes;
  return { name: rec.name, notes, duration: rec.duration };
}

export async function deleteSong(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
  await tx('readwrite', (s) => s.delete(id), MEDIA);
}

export async function saveMedia(media: SongMedia): Promise<void> {
  await tx('readwrite', (s) => s.put(media), MEDIA);
}

export async function getMedia(id: string): Promise<SongMedia | null> {
  const rec = await tx<SongMedia | undefined>(
    'readonly',
    (s) => s.get(id) as IDBRequest<SongMedia | undefined>,
    MEDIA,
  );
  return rec ?? null;
}
