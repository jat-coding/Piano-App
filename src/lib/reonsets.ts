import type { NoteEvent } from '../types';

/**
 * Merge "ghost" re-onsets in transcribed notes back into the note they split.
 *
 * The transcriber sometimes cuts one long, ringing note (often held by the sustain pedal)
 * into a chain of pieces: the same key, each piece starting the instant the previous one
 * ends, as if the key were struck again and again. On screen that shows as a key pressed
 * several times that the pianist pressed once. A real repeated note needs the key to come
 * back up; without the pedal that leaves a gap, and when it doesn't (pedal, or fast
 * repeats) a real re-strike is a fresh attack: about as loud as the note before it. A
 * ghost piece is the same string fading out, so it is quieter than the strike it belongs
 * to.
 *
 * Rules, per key, over chains of back-to-back pieces (each starts within CONTIGUOUS of the
 * previous one's end):
 *  - a chain of 3+ pieces in which the loudness comes back up at least twice (and on at
 *    least 30% of the steps) is a repeated-note figure (a trill or tremolo with a missed
 *    neighbour, repeated chords): left alone;
 *  - otherwise a piece clearly quieter than the strike it follows (below GHOST_RATIO of
 *    it) is folded into that strike, which then lasts until the piece's end. A piece that
 *    starts together with a freshly struck other key (within TOGETHER) is folded in at a
 *    smaller drop (below NEAR_GHOST_RATIO): striking one key makes the strings already
 *    ringing under the pedal flare up, and the transcriber reads that as new strikes.
 *  - a chain of 3+ pieces that only ever gets quieter and ends below FADE_RATIO of where it
 *    started is one note dying away: all of it is folded into the first piece. (Real strikes
 *    come out of the transcriber at a nearly constant loudness even in a diminuendo: a
 *    rendered 0.8 -> 0.53 run of six pedalled re-strikes read as 0.82, 0.81, 0.81, 0.82,
 *    0.82, 0.75.)
 * Real repeats with a gap, louder re-strikes and MIDI files are never touched (call this
 * only on transcribed notes). Pure; the input is not modified. Idempotent.
 */

/** Pieces closer than this (s) count as back-to-back: about two of the model's 11.6 ms frames. */
export const CONTIGUOUS = 0.025;
/** A piece below this fraction of the strike it follows is that strike fading, not a new one. */
export const GHOST_RATIO = 0.9;
/** ...or below this, when it starts together with a freshly struck other key. */
export const NEAR_GHOST_RATIO = 0.97;
/** A chain that only fades, ending below this fraction of its first piece, is one note. */
const FADE_RATIO = 0.7;
/** "Together", seconds. */
const TOGETHER = 0.04;
/** A step counts as a fresh attack in figure detection when it is at least this loud relative to the step before. */
const RISE_RATIO = 0.9;

export interface ReonsetResult {
  notes: NoteEvent[];
  merged: number;
}

export function mergeGhostReonsets(input: NoteEvent[]): ReonsetResult {
  const byKey = new Map<number, number[]>();
  input.forEach((n, i) => {
    const l = byKey.get(n.midi);
    if (l) l.push(i);
    else byKey.set(n.midi, [i]);
  });
  const out = input.map((n) => ({ ...n }));
  // Onsets of keys that weren't already sounding (a real new strike somewhere), sorted.
  const sounding = (i: number) =>
    (byKey.get(input[i].midi) ?? []).some(
      (j) => j !== i && input[j].startTime < input[i].startTime - TOGETHER && input[j].startTime + input[j].duration > input[i].startTime - CONTIGUOUS,
    );
  const freshOnsets = input.map((n, i) => (sounding(i) ? NaN : n.startTime)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  const fresh = (i: number) => {
    const t = input[i].startTime;
    let lo = 0;
    let hi = freshOnsets.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (freshOnsets[m] < t - TOGETHER) lo = m + 1;
      else hi = m;
    }
    return lo < freshOnsets.length && freshOnsets[lo] <= t + TOGETHER;
  };
  const drop = new Uint8Array(input.length);
  let merged = 0;
  for (const idx of byKey.values()) {
    idx.sort((a, b) => input[a].startTime - input[b].startTime);
    // Split into chains of back-to-back pieces.
    let c0 = 0;
    for (let k = 1; k <= idx.length; k++) {
      const contiguous =
        k < idx.length &&
        input[idx[k]].startTime - (input[idx[k - 1]].startTime + input[idx[k - 1]].duration) <= CONTIGUOUS;
      if (contiguous) continue;
      merged += mergeChain(idx.slice(c0, k), input, out, drop, fresh);
      c0 = k;
    }
  }
  const notes = out.filter((_, i) => !drop[i]);
  notes.sort((a, b) => a.startTime - b.startTime || a.midi - b.midi);
  return { notes, merged };
}

function mergeChain(chain: number[], input: NoteEvent[], out: NoteEvent[], drop: Uint8Array, fresh: (i: number) => boolean): number {
  if (chain.length < 2) return 0;
  const steps = chain.length - 1;
  let rises = 0;
  for (let k = 1; k < chain.length; k++) if (input[chain[k]].velocity >= RISE_RATIO * input[chain[k - 1]].velocity) rises++;
  if (chain.length >= 3 && rises >= 2 && rises >= 0.3 * steps) return 0;
  const v = (k: number) => input[chain[k]].velocity;
  let fading = chain.length >= 3 && v(chain.length - 1) < FADE_RATIO * v(0);
  for (let k = 1; k < chain.length && fading; k++) if (v(k) >= v(k - 1)) fading = false;
  if (fading) {
    const last = input[chain[chain.length - 1]];
    out[chain[0]].duration = last.startTime + last.duration - input[chain[0]].startTime;
    for (let k = 1; k < chain.length; k++) drop[chain[k]] = 1;
    return steps;
  }
  let head = chain[0];
  let n = 0;
  for (let k = 1; k < chain.length; k++) {
    const i = chain[k];
    const ratio = input[i].velocity / input[head].velocity;
    if (ratio < GHOST_RATIO || (ratio < NEAR_GHOST_RATIO && fresh(i))) {
      const h = out[head];
      h.duration = Math.max(h.duration, input[i].startTime + input[i].duration - h.startTime);
      drop[i] = 1;
      n++;
    } else head = i;
  }
  return n;
}
