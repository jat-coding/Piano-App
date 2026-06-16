import { useStore } from '../store';
import { parseMidi } from './midi';
import { fileToMonoAudio, isMidi, isAudioOrVideo, TARGET_SR } from './audio';
import { transcribe, rederive } from './transcribe';
import { rawToSong } from './cleanup';
import type { CleanupParams } from './transcribe';
import type { BuildOptions } from './cleanup';
import { saveSong, listSongs, deleteSong, getSong } from './library';
import type { Song } from '../types';
import type { SongKind } from './library';

/** Persist a freshly loaded song, replacing any prior copy with the same name. */
async function persist(song: Song, kind: SongKind): Promise<void> {
  try {
    const existing = await listSongs();
    const dupe = existing.find((s) => s.name === song.name && s.kind === kind);
    if (dupe) await deleteSong(dupe.id);
    await saveSong(song, kind);
  } catch (err) {
    console.warn('Could not save to library', err);
  }
}

/** Rebuild the playable Song from the cached raw notes + current build options. */
function rebuild(): void {
  const { rawNotes, sourceName, build, setSong } = useStore.getState();
  if (!rawNotes) return;
  setSong(rawToSong(sourceName, rawNotes, build));
}

/** Entry point for any dropped/selected file. */
export async function loadFile(file: File): Promise<void> {
  const s = useStore.getState();
  s.setParseError(null);

  if (isMidi(file)) {
    try {
      const song = await parseMidi(file);
      if (!song.notes.length) {
        s.setParseError('No playable notes found in that MIDI file.');
        return;
      }
      s.setRaw(null, ''); // clear any prior transcription (hides cleanup panel)
      s.setShowCleanup(false);
      s.setSong(song);
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
    const audio = await fileToMonoAudio(file, {
      stage: (label) => useStore.getState().setStage(label),
      ffmpegProgress: (r) => useStore.getState().setProgress(r),
    });

    const name = file.name.replace(/\.[^.]+$/, '');
    const kind: 'audio' | 'video' = /\.(mp4|mov|webm|m4v)$/i.test(file.name)
      ? 'video'
      : 'audio';

    // Pause here: the user clips the section they want before we transcribe.
    useStore.getState().setTranscribing(false);
    useStore.getState().setPending(audio, name, kind, audio.length / TARGET_SR);
  } catch (err) {
    console.error(err);
    useStore.getState().setTranscribing(false);
    useStore
      .getState()
      .setParseError(err instanceof Error ? err.message : 'Could not read that file.');
  }
}

/** Discard the decoded clip without transcribing. */
export function cancelTrim(): void {
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
  const { pendingName: name, pendingKind: kind } = st;

  st.clearPending();
  st.setTranscribing(true);
  st.setProgress(0);
  st.setStage('Transcribing — this runs entirely on your device…');
  try {
    const raw = await transcribe(slice, useStore.getState().cleanup, (p) =>
      useStore.getState().setProgress(p),
    );
    useStore.getState().setRaw(raw, name);
    rebuild();
    useStore.getState().setShowCleanup(true);
    const built = useStore.getState().song;
    if (built) persist(built, kind);
  } catch (err) {
    console.error(err);
    useStore
      .getState()
      .setParseError(err instanceof Error ? err.message : 'Transcription failed.');
  } finally {
    useStore.getState().setTranscribing(false);
  }
}

/** Load a previously saved song from the library (no re-transcription). */
export async function loadSavedSong(id: string): Promise<void> {
  const song = await getSong(id);
  if (!song) return;
  const s = useStore.getState();
  s.setRaw(null, ''); // saved songs are already cleaned up
  s.setShowCleanup(false);
  s.setSong(song);
}

/** Split-point / quantize / bpm change → cheap local rebuild (no inference). */
export function updateBuild(partial: Partial<BuildOptions>): void {
  useStore.getState().setBuild(partial);
  rebuild();
}

// Cleanup-threshold changes re-derive from the cached model output (debounced).
let rederiveTimer: ReturnType<typeof setTimeout> | undefined;
export function updateCleanup(partial: Partial<CleanupParams>): void {
  useStore.getState().setCleanup(partial);
  clearTimeout(rederiveTimer);
  rederiveTimer = setTimeout(async () => {
    const st = useStore.getState();
    if (!st.rawNotes) return;
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
