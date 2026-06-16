import { Midi } from '@tonejs/midi';
import type { NoteEvent, Song, Hand } from '../types';
import { MIN_MIDI, MAX_MIDI } from '../types';
import { splitHands } from './handSplit';

/**
 * Parse a MIDI file into the normalized NoteEvent[] format.
 *
 * Hand assignment priority (per the brief):
 *   1. Two or more tracks with notes → first = right (orange), second = left (blue).
 *   2. Single track → fall back to the heuristic splitter.
 */
export async function parseMidi(file: File): Promise<Song> {
  const buf = await file.arrayBuffer();
  const midi = new Midi(buf);

  // Tracks that actually contain notes.
  const playedTracks = midi.tracks.filter((t) => t.notes.length > 0);

  const notes: NoteEvent[] = [];

  if (playedTracks.length >= 2) {
    // Heuristic: the track with the higher average pitch is the right hand.
    const avg = (t: (typeof playedTracks)[number]) =>
      t.notes.reduce((s, n) => s + n.midi, 0) / t.notes.length;
    const sorted = [...playedTracks].sort((a, b) => avg(b) - avg(a));
    const rightTrack = sorted[0];

    for (const track of playedTracks) {
      const hand: Hand = track === rightTrack ? 'right' : 'left';
      for (const n of track.notes) pushNote(notes, n, hand);
    }
  } else {
    // Single track (or none distinguishable) → heuristic split later.
    for (const track of playedTracks) {
      for (const n of track.notes) pushNote(notes, n, 'unknown');
    }
  }

  notes.sort((a, b) => a.startTime - b.startTime || a.midi - b.midi);

  // Apply heuristic only if we couldn't separate by track.
  const needsSplit = notes.some((n) => n.hand === 'unknown');
  const finalNotes = needsSplit ? splitHands(notes) : notes;

  const duration = finalNotes.reduce(
    (max, n) => Math.max(max, n.startTime + n.duration),
    0,
  );

  return {
    name: file.name.replace(/\.midi?$/i, ''),
    notes: finalNotes,
    duration,
  };
}

function pushNote(
  out: NoteEvent[],
  n: { midi: number; time: number; duration: number; velocity: number },
  hand: Hand,
): void {
  // Clamp out-of-range notes into the 88-key window rather than dropping them.
  if (n.midi < MIN_MIDI || n.midi > MAX_MIDI) return;
  out.push({
    midi: n.midi,
    startTime: n.time,
    duration: Math.max(n.duration, 0.02),
    velocity: n.velocity,
    hand,
  });
}
