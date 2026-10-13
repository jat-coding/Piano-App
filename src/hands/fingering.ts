import type { NoteEvent } from '../types';

/**
 * Fingering engine: which finger of which hand plays each note.
 *
 * Pure (no DOM), so it runs in Node tests and in a worker alike. The method is a
 * Viterbi search over "events" (a single note, or the notes of a chord struck
 * together). Each event's states are the ways its notes can be fingered in pitch
 * order; the cost of a path follows Parncutt et al. (1997) and Jacobs (2001):
 * comfortable/practical spans between finger pairs, weak fingers, thumbs on black
 * keys, thumb-passing, plus a cost for moving the whole hand that grows the less
 * time there is to move it.
 *
 * Fingers: 1 = thumb … 5 = little finger. Right hand: 1 is lowest. Left: 1 is highest.
 */

export type Finger = 1 | 2 | 3 | 4 | 5;
export type PlayHand = 'left' | 'right';

export interface NoteFingering {
  hand: PlayHand;
  /** null = the note can't be reached by that hand without contorting it. */
  finger: Finger | null;
  /**
   * When the finger must have left the key, at the latest (song seconds). Equal
   * to the note's end unless the hand has to move on while the note still sounds
   * (a later note would stretch the hand too far, or needs that finger): then it
   * is the onset of the event that forces the release, and the rest of the note
   * is held by the pedal, not a finger.
   */
  releaseBy: number;
}

export interface HandEvent {
  time: number;
  /** Indices into the input notes, in ascending pitch. */
  notes: number[];
  /** Finger per entry of `notes` (null = unreachable, played by nobody). */
  fingers: (Finger | null)[];
  /** Earlier notes still under a finger when this event is struck (their fingers stay put). */
  held: { note: number; finger: Finger }[];
  /** Where the thumb would rest, in white-key units (see keyU). */
  handU: number;
}

export interface FingeringResult {
  perNote: NoteFingering[];
  events: Record<PlayHand, HandEvent[]>;
  /** Notes handed to the other hand because a chord was too wide. */
  moved: number;
  /** Notes no hand could reach. */
  unreachable: number;
  /** Notes left without a finger because reaching them would need a jump no hand can make in time. */
  tooFast: number;
  /**
   * Notes moved to the other hand because the split had the hands crossing (a left-hand
   * note above a right-hand note sounding with it) and the other hand could take it.
   */
  uncrossed: number;
}

export interface FingeringOptions {
  /** Notes whose onsets fall within this window form one chord (seconds). */
  chordWindow?: number;
  /** Hand a too-wide chord's edge notes to the other hand when it is free. */
  moveOverflow?: boolean;
  /** Notes the hands should ignore (e.g. off the visible keyboard). They get no finger. */
  skip?: (index: number) => boolean;
  /** Re-split notes that put the two hands across each other (default on; see uncross). */
  uncross?: boolean;
}

// ---------- keyboard geometry in physical units ----------

const WHITE_OF_PC = [0, -1, 1, -1, 2, 3, -1, 4, -1, 5, -1, 6];

export function isBlack(midi: number): boolean {
  return WHITE_OF_PC[((midi % 12) + 12) % 12] < 0;
}

/**
 * Horizontal key-centre position in white-key widths. White keys sit at
 * index + 0.5; a black key sits on the boundary after the white key below it,
 * matching computeKeyboard()'s geometry.
 */
export function keyU(midi: number): number {
  const oct = Math.floor(midi / 12);
  const pc = midi - oct * 12;
  const w = WHITE_OF_PC[pc];
  if (w >= 0) return oct * 7 + w + 0.5;
  return oct * 7 + WHITE_OF_PC[pc - 1] + 1;
}

/** Natural resting offset of each finger from the thumb, white keys (right hand). */
export const REST_U = [0, 0, 1, 2, 3, 4]; // index 0 unused

// ---------- Span table (semitones, right hand) ----------
// [minPrac, minComf, minRel, maxRel, maxComf, maxPrac] for finger pair (a<b).
// Distance d = pitch(b) − pitch(a) for the right hand, mirrored for the left.
// Based on Parncutt et al., but the practical maxima are capped so a drawn hand
// never splays wider than an octave thumb-to-little-finger: a 9th or 10th is
// within reach for big hands, yet on screen it reads as a spider. Notes held at
// once beyond these limits are handed to the other hand, released to the pedal,
// or marked unreachable (see assignFingering).
type Span = [number, number, number, number, number, number];
const SPAN: Record<string, Span> = {
  '12': [-5, -3, 1, 5, 8, 9],
  '13': [-4, -2, 3, 7, 10, 10],
  '14': [-3, -1, 5, 9, 11, 11],
  '15': [-1, 1, 7, 10, 12, 12],
  '23': [1, 1, 1, 2, 3, 4],
  '24': [1, 1, 3, 4, 5, 6],
  '25': [2, 2, 5, 6, 8, 9],
  '34': [1, 1, 1, 2, 2, 3],
  '35': [1, 1, 3, 4, 5, 6],
  '45': [1, 1, 1, 2, 3, 4],
};

/** Widest interval one hand may hold at once, thumb to little finger (semitones). */
export const MAX_HAND_SPAN = SPAN['15'][5];

const W = {
  stretch: 2, // per semitone past the comfortable span
  rel: 1, // per semitone outside the relaxed span (×2 without the thumb)
  weak4: 1,
  weak5: 0.5,
  thumbBlack: 3,
  fiveBlack: 1,
  thumbPass: 1, // thumb-under / finger-over-thumb
  thumbPassBlack: 3, // …with the thumb on black and the other finger on white
  fingerOver: 6, // crossing two non-thumb fingers (rare, costly)
  sameFinger: 1.5, // same finger, new key
  sameFingerPerSemi: 0.4,
  heldConflict: 4, // reusing / crossing a finger that is still holding a note
  heldStretch: 2, // a held note and a new one too far apart: the held one must let go early
  moveBase: 0.5, // per white key the hand shifts…
  moveUrgency: 0.12, // …plus this ÷ the time available
  // Per white key that this hand's inner edge (its thumb, or the fingers beyond its note
  // nearest the other hand) comes closer than SIDE_CLEAR to the other hand's nearest note:
  // the hand would have to lie over the other one. So the note nearest the other hand
  // goes to the finger on that side (left thumb on its highest note, right thumb on its
  // lowest) unless the hand's own notes forbid it.
  side: 4,
};

/** White keys between a hand's inner edge (thumb tip) and the other hand's nearest note that need no extra care. */
const SIDE_CLEAR = 1.5;
/** The other hand's notes count as "near" an event from this long before it until this long after. */
const SIDE_BEFORE = 0.6;
const SIDE_AFTER = 0.4;

const INFEASIBLE = 1e6;

/**
 * Fastest average hand shift between two struck events (white keys per second). Faster
 * than this the hand would teleport on screen (an octave and a half in 0.1 s is a
 * transcription artefact, not something a hand does): one of the two events is played
 * without a finger instead (see dropDashes).
 */
const MAX_DASH = 50;

/**
 * A finger keeps holding an earlier key only while that key is about where the finger
 * would be anyway (white keys from its natural spot over the new notes). Further away,
 * holding it would pull the hand off its new position: the finger lets go and the pedal
 * (or the recording) carries the sound.
 */
const HOLD_SLACK = 1.5;

/** Signed distance for the ordered finger pair, in the right-hand sense. */
function spanDist(hand: PlayHand, pa: number, pb: number): number {
  return hand === 'right' ? pb - pa : pa - pb;
}

function relCost(s: Span, d: number, thumb: boolean): number {
  const k = thumb ? 1 : 2;
  let c = 0;
  if (d > s[3]) c += (d - s[3]) * W.rel * k;
  if (d < s[2] && d >= 0) c += (s[2] - d) * W.rel * k;
  return c;
}

/** Cost of two fingers sounding together (a chord). */
function chordPairCost(hand: PlayHand, fa: Finger, pa: number, fb: Finger, pb: number): number {
  if (fa > fb) [fa, fb, pa, pb] = [fb, fa, pb, pa];
  const s = SPAN[`${fa}${fb}`];
  const d = spanDist(hand, pa, pb);
  if (d < s[0] || d > s[5]) return INFEASIBLE;
  let c = 0;
  if (d > s[4]) c += (d - s[4]) * W.stretch;
  if (d < s[1]) c += (s[1] - d) * W.stretch;
  return c + relCost(s, d, fa === 1);
}

/**
 * Cost of going from (fa, pa) to (fb, pb) in consecutive events. `tf` scales the
 * stretch part down when there is plenty of time to reposition.
 */
function stepPairCost(
  hand: PlayHand,
  fp: Finger,
  pp: number,
  fc: Finger,
  pc: number,
  tf: number,
  gap: number,
): number {
  if (fp === fc) {
    if (pp === pc) return 0;
    const c = W.sameFinger + W.sameFingerPerSemi * Math.abs(pc - pp);
    return gap < 0.2 ? c * 2 : c;
  }
  let fa = fp;
  let fb = fc;
  let pa = pp;
  let pb = pc;
  if (fa > fb) [fa, fb, pa, pb] = [fb, fa, pb, pa];
  const s = SPAN[`${fa}${fb}`];
  const d = spanDist(hand, pa, pb);
  const thumb = fa === 1;
  if (d < 0 && !thumb) {
    // Finger-over between two long fingers: possible for a step, never more.
    if (d < -2) return INFEASIBLE;
    return W.fingerOver + 2 * -d;
  }
  let c = 0;
  if (d < 0) {
    // Thumb passing under (or a finger over the thumb).
    const thumbP = fa === fp ? pp : pc;
    const otherP = fa === fp ? pc : pp;
    c += isBlack(thumbP) && !isBlack(otherP) ? W.thumbPassBlack : W.thumbPass;
    if (d < s[0]) c += (s[0] - d) * W.stretch * 3;
    else if (d < s[1]) c += (s[1] - d) * W.stretch;
    return c;
  }
  if (d > s[4]) c += (d - s[4]) * W.stretch * tf;
  if (d < s[1]) c += (s[1] - d) * W.stretch * tf;
  return c + relCost(s, d, thumb) * tf;
}

// ---------- events and states ----------

interface Ev {
  time: number;
  idx: number[]; // note indices, ascending pitch
  pitch: number[];
  end: number[];
  /**
   * The other hand's nearest key around this event (white-key units, keyU): its lowest for
   * the left hand, its highest for the right. NaN when the other hand plays nothing nearby.
   */
  otherEdge?: number;
}

interface State {
  fingers: Finger[]; // per pitch, in ascending pitch order
  handU: number;
  cost: number; // vertical (within-event) cost
}

const COMBOS: Finger[][][] = (() => {
  const out: Finger[][][] = [[], [], [], [], [], []];
  for (let mask = 1; mask < 32; mask++) {
    const fs: Finger[] = [];
    for (let f = 1; f <= 5; f++) if (mask & (1 << (f - 1))) fs.push(f as Finger);
    out[fs.length].push(fs);
  }
  return out;
})();

function restU(hand: PlayHand, f: Finger): number {
  return hand === 'right' ? REST_U[f] : -REST_U[f];
}

function noteCost(f: Finger, p: number): number {
  let c = 0;
  if (f === 4) c += W.weak4;
  if (f === 5) c += W.weak5;
  if (isBlack(p)) {
    if (f === 1) c += W.thumbBlack;
    if (f === 5) c += W.fiveBlack;
  }
  return c;
}

/** All pitch-ordered fingerings of a chord that one hand can physically reach. */
function statesFor(hand: PlayHand, pitch: number[], otherEdge = NaN): State[] {
  const k = pitch.length;
  if (k === 0 || k > 5) return [];
  const out: State[] = [];
  for (const combo of COMBOS[k]) {
    // Right hand: lowest pitch gets the lowest finger. Left hand: the reverse.
    const fingers = hand === 'right' ? combo : [...combo].reverse();
    let cost = 0;
    let sumU = 0;
    for (let i = 0; i < k && cost < INFEASIBLE; i++) {
      cost += noteCost(fingers[i], pitch[i]);
      sumU += keyU(pitch[i]) - restU(hand, fingers[i]);
      for (let j = i + 1; j < k; j++) {
        cost += chordPairCost(hand, fingers[i], pitch[i], fingers[j], pitch[j]);
      }
    }
    if (cost >= INFEASIBLE) continue;
    const handU = sumU / k;
    if (!Number.isNaN(otherEdge)) cost += sideCost(hand, handU, fingers, pitch, otherEdge);
    out.push({ fingers, handU, cost });
  }
  return out;
}

/**
 * How far this fingering puts the hand over toward the other hand. Its inner edge is the
 * thumb when the thumb plays (or sits beyond) the inner note, i.e. where the thumb rests
 * (handU) or its note, whichever is nearer the other hand.
 */
function sideCost(hand: PlayHand, handU: number, fingers: Finger[], pitch: number[], otherEdge: number): number {
  const inner = hand === 'left' ? pitch.length - 1 : 0;
  const innerU = keyU(pitch[inner]);
  // A finger other than the thumb on the inner note leaves the fingers before it (and the
  // palm) sticking out past it toward the other hand.
  const edge = fingers[inner] === 1 ? innerU : hand === 'left' ? Math.max(innerU, handU) : Math.min(innerU, handU);
  const clear = hand === 'left' ? otherEdge - edge : edge - otherEdge;
  return W.side * Math.max(0, SIDE_CLEAR - clear);
}

function transitionCost(hand: PlayHand, a: Ev, sa: State, b: Ev, sb: State): number {
  const gap = Math.max(0.001, b.time - a.time);
  const tf = Math.min(1, Math.max(0.15, 0.35 / gap));
  let pairs = 0;
  for (let i = 0; i < a.pitch.length; i++) {
    for (let j = 0; j < b.pitch.length; j++) {
      pairs += stepPairCost(hand, sa.fingers[i], a.pitch[i], sb.fingers[j], b.pitch[j], tf, gap);
      if (pairs >= INFEASIBLE) return INFEASIBLE;
    }
  }
  let c = pairs / Math.max(a.pitch.length, b.pitch.length);

  // Notes of `a` still held when `b` is struck: their fingers are busy.
  for (let i = 0; i < a.pitch.length; i++) {
    if (a.end[i] <= b.time + 0.05) continue;
    const fh = sa.fingers[i];
    for (let j = 0; j < b.pitch.length; j++) {
      const fb = sb.fingers[j];
      if (b.pitch[j] === a.pitch[i]) continue;
      if (fb === fh) c += W.heldConflict;
      else {
        const above = spanDist(hand, a.pitch[i], b.pitch[j]) > 0; // b is "outward" in finger order
        if (above !== fb > fh) c += W.heldConflict;
        else if (chordPairCost(hand, fh, a.pitch[i], fb, b.pitch[j]) >= INFEASIBLE) c += W.heldStretch;
      }
    }
  }

  const du = Math.abs(sb.handU - sa.handU);
  c += du * (W.moveBase + W.moveUrgency / Math.max(gap, 0.04));
  return c;
}

/** Viterbi over one hand's events. Returns the chosen state per event. */
function viterbi(hand: PlayHand, evs: Ev[], states: State[][]): State[] {
  const n = evs.length;
  if (!n) return [];
  let prev = states[0].map((s) => s.cost);
  const back: Int32Array[] = [new Int32Array(states[0].length).fill(-1)];
  for (let i = 1; i < n; i++) {
    const cur = new Array<number>(states[i].length).fill(Infinity);
    const bp = new Int32Array(states[i].length).fill(0);
    for (let s = 0; s < states[i].length; s++) {
      const sb = states[i][s];
      for (let r = 0; r < states[i - 1].length; r++) {
        const base = prev[r];
        if (base >= cur[s]) continue;
        const v = base + transitionCost(hand, evs[i - 1], states[i - 1][r], evs[i], sb) + sb.cost;
        if (v < cur[s]) {
          cur[s] = v;
          bp[s] = r;
        }
      }
    }
    prev = cur;
    back.push(bp);
  }
  let best = 0;
  for (let s = 1; s < prev.length; s++) if (prev[s] < prev[best]) best = s;
  const path = new Array<State>(n);
  for (let i = n - 1; i >= 0; i--) {
    path[i] = states[i][best];
    best = back[i][best];
  }
  return path;
}

function groupEvents(notes: NoteEvent[], idx: number[], win: number): Ev[] {
  const evs: Ev[] = [];
  let cur: Ev | null = null;
  for (const i of idx) {
    const n = notes[i];
    if (!cur || n.startTime - cur.time > win) {
      cur = { time: n.startTime, idx: [], pitch: [], end: [] };
      evs.push(cur);
    }
    cur.idx.push(i);
  }
  for (const e of evs) {
    e.idx.sort((a, b) => notes[a].midi - notes[b].midi);
    // The same key twice in one chord is one press.
    e.idx = e.idx.filter((v, k) => k === 0 || notes[v].midi !== notes[e.idx[k - 1]].midi);
    e.pitch = e.idx.map((i) => notes[i].midi);
    e.end = e.idx.map((i) => notes[i].startTime + notes[i].duration);
  }
  return evs;
}

/**
 * Shrink a chord to what one hand can reach by dropping notes from the edge that
 * faces the other hand (the right hand gives up its lowest notes, the left its
 * highest). Returns how many to drop, or -1 if even one note is impossible.
 */
function overflowCount(hand: PlayHand, pitch: number[]): number {
  for (let r = 0; r < pitch.length; r++) {
    const keep = hand === 'right' ? pitch.slice(r) : pitch.slice(0, pitch.length - r);
    if (statesFor(hand, keep).length) return r;
  }
  return -1;
}

/**
 * Assign a hand and finger to every note. Notes marked 'left' stay with the left
 * hand and everything else with the right, except edge notes of chords too wide
 * for one hand, which move to the other hand when it isn't busy.
 */
export function assignFingering(notes: NoteEvent[], opts: FingeringOptions = {}): FingeringResult {
  const win = opts.chordWindow ?? 0.035;
  const moveOverflow = opts.moveOverflow ?? true;
  const handOf: PlayHand[] = notes.map((n) => (n.hand === 'left' ? 'left' : 'right'));
  const perNote: NoteFingering[] = handOf.map((hand, i) => ({
    hand,
    finger: null,
    releaseBy: notes[i].startTime + notes[i].duration,
  }));
  const skip = opts.skip;
  const byStart = notes
    .map((_, i) => i)
    .filter((i) => !skip?.(i))
    .sort((a, b) => notes[a].startTime - notes[b].startTime);
  const uncrossed = opts.uncross === false ? 0 : uncross(notes, byStart, handOf, win);
  for (let i = 0; i < notes.length; i++) perNote[i].hand = handOf[i];

  // Pass 1: find chords one hand can't span; hand their edge notes over if the
  // other hand has no onset nearby, otherwise they stay unreachable.
  const unreachable = new Set<number>();
  let moved = 0;
  let tooFast = 0;
  const onsets: Record<PlayHand, number[]> = { left: [], right: [] };
  for (const i of byStart) onsets[handOf[i]].push(notes[i].startTime);
  const otherBusy = (hand: PlayHand, t: number): boolean => {
    const arr = onsets[hand === 'right' ? 'left' : 'right'];
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (arr[m] < t - 0.12) lo = m + 1;
      else hi = m;
    }
    return lo < arr.length && arr[lo] <= t + 0.12;
  };
  for (const hand of ['right', 'left'] as PlayHand[]) {
    const idx = byStart.filter((i) => handOf[i] === hand);
    for (const e of groupEvents(notes, idx, win)) {
      const r = overflowCount(hand, e.pitch);
      if (r === 0) continue;
      const drop = r < 0 ? e.idx : hand === 'right' ? e.idx.slice(0, r) : e.idx.slice(e.idx.length - r);
      const other: PlayHand = hand === 'right' ? 'left' : 'right';
      const canMove =
        moveOverflow &&
        r > 0 &&
        !otherBusy(hand, e.time) &&
        overflowCount(other, drop.map((i) => notes[i].midi).sort((a, b) => a - b)) === 0;
      for (const i of drop) {
        if (canMove) {
          handOf[i] = other;
          perNote[i].hand = other;
          moved++;
        } else unreachable.add(i);
      }
      if (canMove) {
        onsets[other].push(e.time);
        onsets[other].sort((a, b) => a - b);
      }
    }
  }

  // Pass 2: Viterbi per hand over the reachable notes.
  const events: Record<PlayHand, HandEvent[]> = { left: [], right: [] };
  for (const hand of ['right', 'left'] as PlayHand[]) {
    const idx = byStart.filter((i) => handOf[i] === hand && !unreachable.has(i));
    const evs = groupEvents(notes, idx, win);
    const other: PlayHand = hand === 'right' ? 'left' : 'right';
    const otherIdx = byStart.filter((i) => handOf[i] === other && !unreachable.has(i));
    for (const e of evs) e.otherEdge = otherEdgeAt(notes, otherIdx, other, e.time);
    const states = evs.map((e) => {
      const st = statesFor(hand, e.pitch, e.otherEdge);
      return st.length ? st : statesFor(hand, e.pitch);
    });
    const path = viterbi(hand, evs, states);
    evs.forEach((e, k) => {
      const st = path[k];
      e.idx.forEach((ni, j) => (perNote[ni].finger = st.fingers[j]));
      events[hand].push({ time: e.time, notes: e.idx, fingers: st.fingers, handU: st.handU, held: [] });
    });
    tooFast += dropDashes(events[hand], perNote);
    // Pass 3: which earlier notes stay under their fingers at each event, and
    // which must let go early because the hand moves on (pedal holds the sound).
    trackHeld(hand, events[hand], notes, perNote);
  }

  return { perNote, events, moved, unreachable: unreachable.size, tooFast, uncrossed };
}

/**
 * The other hand's nearest key around time t (keyU): the lowest of its notes for a left
 * hand asking (`other` = 'right'), the highest for a right hand. Notes count from
 * SIDE_BEFORE before t (if still sounding at t) to SIDE_AFTER after. `idx` is sorted by onset.
 */
function otherEdgeAt(notes: NoteEvent[], idx: number[], other: PlayHand, t: number): number {
  let lo = 0;
  let hi = idx.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (notes[idx[m]].startTime < t - SIDE_BEFORE) lo = m + 1;
    else hi = m;
  }
  let edge = NaN;
  for (let k = lo; k < idx.length; k++) {
    const n = notes[idx[k]];
    if (n.startTime > t + SIDE_AFTER) break;
    if (n.startTime < t && n.startTime + n.duration < t) continue;
    const u = keyU(n.midi);
    if (Number.isNaN(edge) || (other === 'right' ? u < edge : u > edge)) edge = u;
  }
  return edge;
}

/**
 * Undo hand-split mistakes that cross the hands: a left-hand note above a right-hand note
 * struck with it (or struck while that note is still being played) puts one hand across
 * the other. Move whichever of the two notes the other hand can take (it fits in that
 * hand's chord there), preferring the one nearer that hand's other notes. A crossing
 * neither hand can resolve is left alone: it is forced (and drawn with the crossing hand
 * on top). Returns how many notes moved.
 */
function uncross(notes: NoteEvent[], byStart: number[], handOf: PlayHand[], win: number): number {
  const TOGETHER = 0.3; // struck together or right after each other (s)
  const NEAR_SEMI = 2;
  // A near (uncrossed) note moves only if it is this many semitones nearer the other hand's notes.
  const NEAR_PREF = 5;
  const HELD = 0.6; // ...or the earlier note was struck at most this long before and still sounds
  let moved = 0;
  const chordAt = (hand: PlayHand, t: number, without: number): number[] => {
    const out: number[] = [];
    for (const i of byStart) {
      if (i === without || handOf[i] !== hand) continue;
      if (Math.abs(notes[i].startTime - t) <= win) out.push(notes[i].midi);
    }
    return out;
  };
  // Mean pitch of a hand's notes within ±1 s of t, without note `without`.
  const centre = (hand: PlayHand, t: number, without: number): number => {
    let s = 0;
    let c = 0;
    for (const i of byStart) {
      if (i === without || handOf[i] !== hand) continue;
      if (Math.abs(notes[i].startTime - t) <= 1) (s += notes[i].midi), c++;
    }
    return c ? s / c : NaN;
  };
  const fits = (hand: PlayHand, i: number): boolean => {
    const chord = [...chordAt(hand, notes[i].startTime, i), notes[i].midi].sort((a, b) => a - b);
    return chord.length <= 5 && statesFor(hand, [...new Set(chord)]).length > 0;
  };
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let a = 0; a < byStart.length; a++) {
      const i = byStart[a];
      for (let b = a + 1; b < byStart.length; b++) {
        const j = byStart[b];
        const ni = notes[i];
        const nj = notes[j];
        if (nj.startTime - ni.startTime > HELD) break;
        if (handOf[i] === handOf[j] || ni.midi === nj.midi) continue;
        const together = nj.startTime - ni.startTime <= TOGETHER || ni.startTime + ni.duration > nj.startTime + 0.05;
        if (!together) continue;
        const l = handOf[i] === 'left' ? i : j;
        const r = l === i ? j : i;
        const crossed = notes[l].midi > notes[r].midi;
        // Within a whole tone: not crossed, but the two hands would be on top of each other.
        // Only then a note that sits with the other hand's notes, far from its own, moves.
        if (!crossed && notes[l].midi < notes[r].midi - NEAR_SEMI) continue;
        // Candidates: the left note to the right hand, or the right note to the left.
        const cand: { n: number; to: PlayHand; d: number }[] = [];
        for (const [n, to] of [[l, 'right'], [r, 'left']] as [number, PlayHand][]) {
          if (!fits(to, n)) continue;
          const c = centre(to, notes[n].startTime, n);
          const d = Number.isNaN(c) ? 0 : Math.abs(notes[n].midi - c);
          if (!crossed) {
            const own = centre(handOf[n], notes[n].startTime, n);
            // (A note alone in its hand around then has no own notes to stay near.)
            if (Number.isNaN(c) || (!Number.isNaN(own) && d + NEAR_PREF > Math.abs(notes[n].midi - own))) continue;
          }
          cand.push({ n, to, d });
        }
        if (!cand.length) continue;
        cand.sort((x, y) => x.d - y.d);
        handOf[cand[0].n] = cand[0].to;
        moved++;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return moved;
}

/**
 * Remove events the hand can't get to in time (see MAX_DASH), keeping the path that
 * moves least: of two events too far apart for the time between them, the one whose
 * removal leaves the calmer path with its other neighbour goes. Its notes get no finger.
 */
function dropDashes(evs: HandEvent[], perNote: NoteFingering[]): number {
  const speed = (a: HandEvent, b: HandEvent) => Math.abs(b.handU - a.handU) / Math.max(1e-3, b.time - a.time);
  let dropped = 0;
  for (let k = 1; k < evs.length; ) {
    if (speed(evs[k - 1], evs[k]) <= MAX_DASH) {
      k++;
      continue;
    }
    const without = (j: number) => (j > 0 && j + 1 < evs.length ? speed(evs[j - 1], evs[j + 1]) : 0);
    const j = without(k - 1) <= without(k) ? k - 1 : k;
    for (const ni of evs[j].notes) perNote[ni].finger = null;
    dropped += evs[j].notes.length;
    evs.splice(j, 1);
    k = Math.max(1, j);
  }
  return dropped;
}

/**
 * Walk one hand's events in order, keeping each still-sounding note under its
 * finger while that finger isn't needed and the hand isn't stretched past what
 * one hand can hold. Otherwise the note's finger is released by the event that
 * forces it (`releaseBy`), farthest-from-the-new-notes first.
 */
function trackHeld(hand: PlayHand, evs: HandEvent[], notes: NoteEvent[], perNote: NoteFingering[]): void {
  type Held = { note: number; finger: Finger; pitch: number; end: number };
  let held: Held[] = [];
  const release = (h: Held, t: number) => {
    perNote[h.note].releaseBy = Math.min(perNote[h.note].releaseBy, t);
  };
  for (const e of evs) {
    // Notes that end around now just end; a finger is never "held" past its note.
    held = held.filter((h) => h.end > e.time + 0.05);
    const pitches = e.notes.map((ni) => notes[ni].midi);
    const used = new Set(e.fingers);
    let keep: Held[] = [];
    for (const h of held) {
      const natural = e.handU + restU(hand, h.finger);
      if (used.has(h.finger) || pitches.includes(h.pitch) || Math.abs(keyU(h.pitch) - natural) > HOLD_SLACK) release(h, e.time);
      else keep.push(h);
    }
    // Everything under a finger at once must fit one hand.
    const centre = pitches.reduce((a, b) => a + b, 0) / Math.max(1, pitches.length);
    for (;;) {
      const all = [
        ...keep.map((h) => ({ f: h.finger, p: h.pitch })),
        ...e.fingers.map((f, j) => ({ f: f as Finger, p: pitches[j] })),
      ];
      let bad = false;
      for (let i = 0; i < all.length && !bad; i++) {
        for (let j = i + 1; j < all.length && !bad; j++) {
          if (chordPairCost(hand, all[i].f, all[i].p, all[j].f, all[j].p) >= INFEASIBLE) bad = true;
        }
      }
      if (!bad || !keep.length) break;
      let far = 0;
      for (let k = 1; k < keep.length; k++) {
        if (Math.abs(keep[k].pitch - centre) > Math.abs(keep[far].pitch - centre)) far = k;
      }
      release(keep[far], e.time);
      keep = keep.filter((_, k) => k !== far);
    }
    e.held = keep.map((h) => ({ note: h.note, finger: h.finger }));
    held = [
      ...keep,
      ...e.notes.map((ni, j) => ({
        note: ni,
        finger: e.fingers[j] as Finger,
        pitch: notes[ni].midi,
        end: notes[ni].startTime + notes[ni].duration,
      })),
    ];
  }
}
