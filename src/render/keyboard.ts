import { MIN_MIDI, MAX_MIDI } from '../types';

/** Pitch classes that are black keys (C#=1, D#=3, F#=6, G#=8, A#=10). */
const BLACK = new Set([1, 3, 6, 8, 10]);

export function isBlackKey(midi: number): boolean {
  return BLACK.has(((midi % 12) + 12) % 12);
}

export interface KeyGeometry {
  midi: number;
  black: boolean;
  /** Left edge in px. */
  x: number;
  /** Width in px. */
  w: number;
  /** Center x — where falling notes align. */
  cx: number;
}

/**
 * Compute geometry for the keys lo..hi (default: all 88) across a given pixel width.
 * lo and hi should be white keys so the edges aren't half a black key.
 *
 * White keys tile evenly; black keys sit at 60% width straddling the boundary
 * between their neighboring white keys, matching real piano geometry.
 */
export function computeKeyboard(
  width: number,
  lo: number = MIN_MIDI,
  hi: number = MAX_MIDI,
): {
  keys: KeyGeometry[];
  whiteWidth: number;
} {
  // Count white keys in range to get white-key width.
  let whiteCount = 0;
  for (let m = lo; m <= hi; m++) if (!isBlackKey(m)) whiteCount++;
  const whiteWidth = width / whiteCount;
  const blackWidth = whiteWidth * 0.62;

  const keys: KeyGeometry[] = [];

  // First pass: place white keys left-to-right.
  let whiteIndex = 0;
  const whiteX: Record<number, number> = {};
  for (let m = lo; m <= hi; m++) {
    if (!isBlackKey(m)) {
      const x = whiteIndex * whiteWidth;
      whiteX[m] = x;
      keys.push({ midi: m, black: false, x, w: whiteWidth, cx: x + whiteWidth / 2 });
      whiteIndex++;
    }
  }

  // Second pass: place black keys straddling the gap after the prior white key.
  for (let m = lo; m <= hi; m++) {
    if (isBlackKey(m)) {
      // The white key just below this black key.
      const prevWhite = m - 1;
      const baseX = whiteX[prevWhite];
      if (baseX === undefined) continue;
      const x = baseX + whiteWidth - blackWidth / 2;
      keys.push({ midi: m, black: true, x, w: blackWidth, cx: x + blackWidth / 2 });
    }
  }

  return { keys, whiteWidth };
}

/** Index keys by midi for O(1) lookup. */
export function indexKeys(keys: KeyGeometry[]): Map<number, KeyGeometry> {
  const map = new Map<number, KeyGeometry>();
  for (const k of keys) map.set(k.midi, k);
  return map;
}

/** Stray notes at either end the zoom may ignore: at most this share of all notes… */
const OUTLIER_SHARE = 0.03;
/** …and only if this many semitones separate them from the rest. */
const OUTLIER_GAP = 4;
/** A note sounding at least this long (s) is never treated as a stray (see keyboardRange). */
const HELD_NOTE = 0.3;

/**
 * Lowest/highest pitch worth zooming the keyboard to. Transcription leaves the
 * odd ghost note far above or below the music (overtones, thumps); one of those
 * must not widen the keyboard by an octave. A tail of at most 3% of the notes
 * (at least 2) is ignored when a gap of a major third or more separates it from
 * the rest. Returns the kept range and how many notes fell outside it.
 */
export function robustPitchRange(midis: number[]): { lo: number; hi: number; outside: number } {
  const p = [...midis].sort((a, b) => a - b);
  const n = p.length;
  if (!n) return { lo: 60, hi: 60, outside: 0 };
  const k = Math.min(Math.floor((n - 1) / 2), Math.max(2, Math.ceil(n * OUTLIER_SHARE)));
  // Largest tail (≤ k notes) that sits apart from the rest by OUTLIER_GAP.
  let dropLo = 0;
  for (let j = k; j >= 1; j--) {
    if (p[j] - p[j - 1] >= OUTLIER_GAP) {
      dropLo = j;
      break;
    }
  }
  let dropHi = 0;
  for (let j = k; j >= 1; j--) {
    if (p[n - j] - p[n - j - 1] >= OUTLIER_GAP) {
      dropHi = j;
      break;
    }
  }
  return { lo: p[dropLo], hi: p[n - 1 - dropHi], outside: dropLo + dropHi };
}

/**
 * The keyboard range to show for a song: its pitch range (stray outliers
 * ignored) plus a little margin, at least ~2 octaves, snapped to white keys.
 */
export function keyboardRange(notes: { midi: number; duration?: number }[]): { lo: number; hi: number } {
  if (!notes.length) return { lo: 48, hi: 84 };
  const r = robustPitchRange(notes.map((n) => n.midi));
  // A held note is music, not a ghost (those are clicks and overtones, gone in a blink): it
  // stays on the keyboard. With few notes (the desktop engine gives about half as many) the
  // "at least 2" tail above could otherwise cut a real opening or closing note, which then
  // had no key and no finger at all.
  for (const n of notes) {
    if ((n.duration ?? 0) < HELD_NOTE) continue;
    r.lo = Math.min(r.lo, n.midi);
    r.hi = Math.max(r.hi, n.midi);
  }
  let lo = Math.max(MIN_MIDI, r.lo - 2);
  let hi = Math.min(MAX_MIDI, r.hi + 2);
  // Too narrow a range makes comically wide keys — widen around the centre.
  while (hi - lo < 24) {
    if (lo > MIN_MIDI) lo--;
    if (hi < MAX_MIDI) hi++;
    if (lo === MIN_MIDI && hi === MAX_MIDI) break;
  }
  while (lo > MIN_MIDI && isBlackKey(lo)) lo--;
  while (hi < MAX_MIDI && isBlackKey(hi)) hi++;
  return { lo, hi };
}
