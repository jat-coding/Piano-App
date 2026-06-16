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
 * Compute geometry for all 88 keys across a given pixel width.
 *
 * White keys tile evenly; black keys sit at 60% width straddling the boundary
 * between their neighboring white keys, matching real piano geometry.
 */
export function computeKeyboard(width: number): {
  keys: KeyGeometry[];
  whiteWidth: number;
} {
  // Count white keys in range to get white-key width.
  let whiteCount = 0;
  for (let m = MIN_MIDI; m <= MAX_MIDI; m++) if (!isBlackKey(m)) whiteCount++;
  const whiteWidth = width / whiteCount;
  const blackWidth = whiteWidth * 0.62;

  const keys: KeyGeometry[] = [];

  // First pass: place white keys left-to-right.
  let whiteIndex = 0;
  const whiteX: Record<number, number> = {};
  for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
    if (!isBlackKey(m)) {
      const x = whiteIndex * whiteWidth;
      whiteX[m] = x;
      keys.push({ midi: m, black: false, x, w: whiteWidth, cx: x + whiteWidth / 2 });
      whiteIndex++;
    }
  }

  // Second pass: place black keys straddling the gap after the prior white key.
  for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
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
