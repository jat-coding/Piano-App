import type { NoteEvent, Song } from '../types';
import { MIN_MIDI, MAX_MIDI } from '../types';
import type { RawNote } from './transcribe';
import { splitAtPitch, splitHands } from './handSplit';

export type Quantize = 'off' | '1/8' | '1/16';

export interface BuildOptions {
  /** Fixed split pitch, or null to use the adaptive heuristic. */
  splitMidi: number | null;
  quantize: Quantize;
  bpm: number;
}

export const DEFAULT_BUILD: BuildOptions = {
  splitMidi: null,
  quantize: 'off',
  bpm: 120,
};

function gridSeconds(q: Quantize, bpm: number): number {
  const beat = 60 / bpm;
  if (q === '1/8') return beat / 2;
  if (q === '1/16') return beat / 4;
  return 0;
}

/** Convert raw transcribed notes into a playable Song, applying cleanup + hands. */
export function rawToSong(name: string, raw: RawNote[], opts: BuildOptions): Song {
  const grid = gridSeconds(opts.quantize, opts.bpm);

  let notes: NoteEvent[] = [];
  for (const r of raw) {
    const midi = Math.round(r.pitchMidi);
    if (midi < MIN_MIDI || midi > MAX_MIDI) continue;

    let startTime = r.startTimeSeconds;
    let duration = Math.max(r.durationSeconds, 0.04);

    if (grid > 0) {
      startTime = Math.round(startTime / grid) * grid;
      duration = Math.max(grid, Math.round(duration / grid) * grid);
    }

    notes.push({
      midi,
      startTime,
      duration,
      velocity: Math.min(1, Math.max(0.05, r.amplitude)),
      hand: 'unknown',
    });
  }

  notes.sort((a, b) => a.startTime - b.startTime || a.midi - b.midi);

  notes =
    opts.splitMidi == null ? splitHands(notes) : splitAtPitch(notes, opts.splitMidi);

  const duration = notes.reduce((m, n) => Math.max(m, n.startTime + n.duration), 0);
  return { name, notes, duration };
}

/** Re-apply only the hand split to an existing song (cheap; no re-quantize). */
export function applySplit(song: Song, splitMidi: number | null): Song {
  const notes = splitMidi == null ? splitHands(song.notes) : splitAtPitch(song.notes, splitMidi);
  return { ...song, notes };
}
