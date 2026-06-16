import type { NoteEvent } from '../types';

/**
 * Heuristic hand splitter for single-track / transcribed input.
 *
 * Strategy: walk a sliding split point. For each note, decide left/right by
 * comparing against a running split pitch that adapts to the local register,
 * so a passage that drifts high or low doesn't get stuck on a fixed middle-C
 * boundary. The split-point slider (Phase 2) overrides this.
 */
export function splitHands(notes: NoteEvent[], windowSec = 0.75): NoteEvent[] {
  if (notes.length === 0) return notes;

  const result = notes.map((n) => ({ ...n }));

  for (let i = 0; i < result.length; i++) {
    const n = result[i];
    if (n.hand !== 'unknown') continue;

    // Gather notes sounding in a small window around this one.
    const local: number[] = [];
    for (let j = i; j >= 0 && n.startTime - result[j].startTime <= windowSec; j--) {
      local.push(result[j].midi);
    }
    for (
      let j = i + 1;
      j < result.length && result[j].startTime - n.startTime <= windowSec;
      j++
    ) {
      local.push(result[j].midi);
    }

    const lo = Math.min(...local);
    const hi = Math.max(...local);
    // Split halfway across the local span, but never below middle C-ish so a
    // single sparse line of melody stays in the right hand.
    const split = Math.max(60, (lo + hi) / 2);
    n.hand = n.midi >= split ? 'right' : 'left';
  }

  return result;
}

/** Reassign hands using a fixed pitch split point (driven by the UI slider). */
export function splitAtPitch(notes: NoteEvent[], splitMidi: number): NoteEvent[] {
  return notes.map((n) => ({
    ...n,
    hand: n.midi >= splitMidi ? ('right' as const) : ('left' as const),
  }));
}
