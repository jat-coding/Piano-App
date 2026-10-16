import { useStore } from '../store';
import { parseMidi } from './midi';
import { fileToMonoAudioPair, isMidi, isAudioOrVideo, TARGET_SR, HIRES_SR } from './audio';
import { transcribe, rederive, cancelTranscription, filterMinLength } from './transcribe';
import { rawToSong } from './cleanup';
import type { CleanupParams, TranscribeResult } from './transcribe';
import type { BuildOptions } from './cleanup';
import { saveSong, listSongs, deleteSong, getSong, touchSong, saveMedia } from './library';
import type { PedalSpan, Song } from '../types';
import type { SongKind } from './library';

/** The original recording + the selection that was transcribed (for video export). */
interface SourceMedia {
  file: File;
  trimStart: number;
  trimEnd: number;
}

// The save that's in flight, so export can wait for the song id + media to land.
let persisting: Promise<void> = Promise.resolve();

/** Resolves once the most recently loaded song (and its media) is in the library. */
export function whenSaved(): Promise<void> {
  return persisting;
}

/** Persist a freshly loaded song, replacing any prior copy with the same name. */
function persist(song: Song, kind: SongKind, media?: SourceMedia): Promise<void> {
  useStore.getState().setCurrentSavedId(null); // never point export at the previous song
  persisting = (async () => {
    try {
      const existing = await listSongs();
      const dupe = existing.find((s) => s.name === song.name && s.kind === kind);
      if (dupe) await deleteSong(dupe.id);
      const saved = await saveSong(song, kind);
      if (media && kind !== 'midi') {
        try {
          await saveMedia({
            id: saved.id,
            kind,
            blob: media.file,
            fileName: media.file.name,
            mimeType: media.file.type,
            trimStart: media.trimStart,
            trimEnd: media.trimEnd,
          });
        } catch (err) {
          // Usually storage quota. The song still saves; export falls back to a piano re-render.
          console.warn('Could not keep the original recording', err);
        }
      }
      const s = useStore.getState();
      s.setCurrentSavedId(saved.id);
      s.bumpLibrary();
    } catch (err) {
      console.warn('Could not save to library', err);
    }
  })();
  return persisting;
}

// Set true when the user cancels; in-flight decode/transcription bail out quietly.
let cancelled = false;

// 44.1 kHz copy of the clip awaiting trim, for the desktop engine (null if unavailable).
let pendingHiRes: Float32Array | null = null;

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * Cancel whatever import/transcription is running: stop the worker, drop any
 * decoded/partial data, and return the user to the start screen + library.
 */
export function cancelProcessing(): void {
  cancelled = true;
  cancelTranscription();
  pendingHiRes = null;
  const s = useStore.getState();
  s.setTranscribing(false);
  s.setProgress(-1);
  s.setStage('');
  s.clearPending();
  s.setRaw(null, '');
  s.setRawSource(null, null);
  s.setParseError(null);
}

/** Rebuild the playable Song from the cached raw notes + current build options. */
function rebuild(): void {
  const { rawNotes, rawEngine, rawPedals, sourceName, build, setSong } = useStore.getState();
  if (!rawNotes) return;
  const song = rawToSong(sourceName, rawNotes, build);
  setSong({
    ...song,
    ...(rawEngine ? { engine: rawEngine } : {}),
    ...(rawPedals?.length ? { pedals: rawPedals } : {}),
  });
}

/** The helper's pedal spans in the app's shape; malformed entries are dropped. */
function toPedalSpans(raw: TranscribeResult['pedals']): PedalSpan[] | null {
  if (!Array.isArray(raw)) return null;
  const spans = raw
    .filter((p) => p && Number.isFinite(p.cc) && Number.isFinite(p.startTimeSeconds) && Number.isFinite(p.endTimeSeconds))
    .map((p) => ({ cc: p.cc, start: p.startTimeSeconds, end: p.endTimeSeconds }))
    .filter((p) => p.end > p.start);
  return spans.length ? spans : null;
}

/** Entry point for any dropped/selected file. */
export async function loadFile(file: File): Promise<void> {
  const s = useStore.getState();
  s.setParseError(null);
  cancelled = false;

  if (isMidi(file)) {
    try {
      const song = await parseMidi(file);
      if (!song.notes.length) {
        s.setParseError('No playable notes found in that MIDI file.');
        return;
      }
      s.setRaw(null, ''); // clear any prior transcription (hides cleanup panel)
      s.setRawSource(null, null);
      s.setShowSettings(false);
      s.setSong(song);
      s.setView('player');
      persist(song, 'midi');
    } catch (err) {
      console.error(err);
      s.setParseError('Could not parse that file. Is it a valid .mid / .midi?');
    }
    return;
  }

  if (/\.pdf$/i.test(file.name)) {
    s.setParseError(
      'Sheet-music PDFs need optical music recognition, which runs on a server — not supported yet. ' +
        'For now, import a MIDI, or an audio/video recording of the piece.',
    );
    return;
  }

  if (!isAudioOrVideo(file)) {
    s.setParseError('Unsupported file. Drop a .mid, audio, or video file.');
    return;
  }

  // Audio / video → decode, then hand off to the trim step before transcribing.
  s.setTranscribing(true);
  s.setProgress(-1);
  s.setStage('Reading file…');
  try {
    const { audio, hiRes } = await fileToMonoAudioPair(file, {
      stage: (label) => useStore.getState().setStage(label),
      ffmpegProgress: (r) => useStore.getState().setProgress(r),
    });

    if (cancelled) return; // user backed out during decode

    const name = file.name.replace(/\.[^.]+$/, '');
    const kind: 'audio' | 'video' = /\.(mp4|mov|webm|m4v)$/i.test(file.name)
      ? 'video'
      : 'audio';

    // Pause here: the user clips the section they want before we transcribe.
    useStore.getState().setTranscribing(false);
    pendingHiRes = hiRes;
    useStore.getState().setPending(audio, name, kind, audio.length / TARGET_SR, file);
  } catch (err) {
    if (cancelled) return;
    console.error(err);
    useStore.getState().setTranscribing(false);
    useStore
      .getState()
      .setParseError(err instanceof Error ? err.message : 'Could not read that file.');
  }
}

/** Discard the decoded clip without transcribing. */
export function cancelTrim(): void {
  pendingHiRes = null;
  useStore.getState().clearPending();
}

/**
 * Transcribe the user-selected region of the decoded clip, then build + save.
 * Times in the resulting song are relative to the clip start (0-based).
 */
export async function confirmTrim(startSec: number, endSec: number): Promise<void> {
  const st = useStore.getState();
  const audio = st.pendingAudio;
  if (!audio) return;

  const start = Math.max(0, Math.floor(startSec * TARGET_SR));
  const end = Math.min(audio.length, Math.floor(endSec * TARGET_SR));
  const slice = end > start ? audio.slice(start, end) : audio;
  const { pendingName: name, pendingKind: kind, pendingFile: file } = st;
  const trimStart = start / TARGET_SR;
  const trimEnd = (end > start ? end : audio.length) / TARGET_SR;
  // The same selection from the 44.1 kHz copy, for the desktop engine.
  const hi = pendingHiRes;
  pendingHiRes = null;
  let hiSlice: Float32Array | null = null;
  if (hi) {
    const hs = Math.max(0, Math.round(trimStart * HIRES_SR));
    const he = Math.min(hi.length, Math.round(trimEnd * HIRES_SR));
    hiSlice = he > hs ? hi.slice(hs, he) : null;
  }

  cancelled = false;
  st.clearPending();
  st.setTranscribing(true);
  st.setProgress(-1); // indeterminate while the model loads / spectrogram runs
  st.setStage('Transcribing…');
  try {
    const result = await transcribe(
      slice,
      hiSlice,
      useStore.getState().cleanup,
      // Stay indeterminate until real per-frame progress arrives, so the bar
      // animates during model load instead of looking frozen at 0%.
      (p) => useStore.getState().setProgress(p > 0 ? p : -1),
      (label) => useStore.getState().setStage(label),
    );
    if (cancelled) return;
    const s2 = useStore.getState();
    if (result.engine === 'transkun') {
      // Desktop notes: no worker frames exist, so cleanup works on these notes directly.
      // Min-length starts off: Transkun's lengths are real key releases, and the on-device
      // engine's 80 ms default cuts its MAESTRO score from 98.5 to 82.3.
      s2.setDesktopMinLen(0);
      s2.setRawSource('transkun', result.notes, toPedalSpans(result.pedals));
    } else {
      s2.setRawSource('basic-pitch', null);
    }
    s2.setRaw(result.notes, name);
    rebuild();
    useStore.getState().setView('player');
    const built = useStore.getState().song;
    if (built) persist(built, kind, file ? { file, trimStart, trimEnd } : undefined);
  } catch (err) {
    if (cancelled || isAbort(err)) return; // user cancelled — not an error
    console.error(err);
    useStore
      .getState()
      .setParseError(err instanceof Error ? err.message : 'Transcription failed.');
  } finally {
    if (!cancelled) useStore.getState().setTranscribing(false);
  }
}

/** Load a previously saved song from the library (no re-transcription). */
export async function loadSavedSong(id: string): Promise<void> {
  const song = await getSong(id);
  if (!song) return;
  const s = useStore.getState();
  s.setRaw(null, ''); // saved songs are already cleaned up
  s.setRawSource(null, null);
  s.setShowSettings(false);
  s.setCurrentSavedId(id);
  s.setSong(song);
  await touchSong(id); // mark as just practiced → moves to the front
  s.bumpLibrary();
}

/** Split-point / quantize / bpm change → cheap local rebuild (no inference). */
export function updateBuild(partial: Partial<BuildOptions>): void {
  useStore.getState().setBuild(partial);
  rebuild();
}

/**
 * Desktop-transcribed songs: Min-length filters the notes the helper returned, client-side.
 * (Asking the worker to re-derive would return nothing: it holds no frames for these songs.)
 */
export function updateDesktopMinLength(ms: number): void {
  const st = useStore.getState();
  st.setDesktopMinLen(ms);
  if (st.rawEngine !== 'transkun' || !st.rawFull) return;
  st.setRaw(filterMinLength(st.rawFull, ms), st.sourceName);
  rebuild();
}

// Cleanup-threshold changes re-derive from the cached model output (debounced).
let rederiveTimer: ReturnType<typeof setTimeout> | undefined;
export function updateCleanup(partial: Partial<CleanupParams>): void {
  if (useStore.getState().rawEngine === 'transkun') {
    // Never re-derive a desktop song from the worker: it would come back empty.
    if (partial.minNoteLenMs != null) updateDesktopMinLength(partial.minNoteLenMs);
    return;
  }
  useStore.getState().setCleanup(partial);
  clearTimeout(rederiveTimer);
  rederiveTimer = setTimeout(async () => {
    const st = useStore.getState();
    if (!st.rawNotes || st.rawEngine === 'transkun') return;
    st.setStage('Updating…');
    st.setTranscribing(true);
    try {
      const raw = await rederive(st.cleanup);
      useStore.getState().setRaw(raw, st.sourceName);
      rebuild();
    } catch (err) {
      console.error(err);
    } finally {
      useStore.getState().setTranscribing(false);
    }
  }, 250);
}
