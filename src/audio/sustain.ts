import type { NoteEvent, PedalSpan } from '../types';

/** MIDI CC 64: the damper (sustain) pedal. 66 = sostenuto, 67 = soft; neither holds notes here. */
export const SUSTAIN_CC = 64;
/**
 * Most a pedal may stretch a note past its own key release (s). A sanity cap only: the
 * Salamander samples decay on their own long before this, so in practice the pedal-up wins.
 */
export const MAX_PEDAL_RING = 20;

/**
 * When each note actually stops sounding (song-s), parallel to song.notes. Standard damper
 * semantics: a key released while the sustain pedal is down keeps ringing until the pedal
 * comes up. A re-strike of the same key ends the earlier ring (its string is struck again),
 * so one key never stacks pedalled copies of itself.
 *
 * Returns null when the song has no sustain-pedal data: callers then use n.duration exactly
 * as before, so songs without pedals sound unchanged.
 */
export function sustainedEnds(notes: NoteEvent[], pedals: PedalSpan[] | undefined): Float64Array | null {
  const spans = (pedals ?? [])
    .filter((p) => p.cc === SUSTAIN_CC && p.end > p.start)
    .sort((a, b) => a.start - b.start);
  if (!spans.length) return null;

  const ends = new Float64Array(notes.length);
  // Next onset of the same key, walking backwards through the (start-sorted) notes.
  const nextOnset = new Map<number, number>();
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    const off = n.startTime + n.duration;
    let end = off;
    const span = spanAt(spans, off);
    if (span) {
      const restrike = nextOnset.get(n.midi) ?? Infinity;
      end = Math.max(off, Math.min(span.end, restrike, off + MAX_PEDAL_RING));
    }
    ends[i] = end;
    nextOnset.set(n.midi, n.startTime);
  }
  return ends;
}

/** The sustain span holding the pedal down at time t, if any (spans sorted by start). */
function spanAt(spans: PedalSpan[], t: number): PedalSpan | null {
  // Last span starting at or before t.
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  // Spans may overlap (two passes of the model); check back a few for one still down.
  for (let k = lo - 1; k >= 0 && k >= lo - 4; k--) if (spans[k].end > t) return spans[k];
  return null;
}
