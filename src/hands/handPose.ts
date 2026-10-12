import type { NoteEvent } from '../types';
import {
  assignFingering,
  isBlack,
  keyU,
  REST_U,
  type Finger,
  type FingeringOptions,
  type FingeringResult,
  type PlayHand,
} from './fingering';

/**
 * Hand poses as a pure function of song time, built on the fingering engine.
 * No DOM: positions come out in white-key units (keyU), depth as 0 = front of
 * the white keys … 1 = on a black key, press as 0 = hovering … 1 = key down.
 */

export interface FingerPose {
  u: number;
  depth: number;
  press: number;
}

export interface HandPose {
  hand: PlayHand;
  /** Index 1..5 used; 0 unused. */
  fingers: FingerPose[];
  /** How fast the whole hand is gliding, white keys per second (for motion smoothing). */
  speed: number;
}

interface KeyPose {
  time: number;
  u: number[]; // per finger 1..5
  depth: number[];
  /** Notes under a finger in this pose (struck now, or still held from before). */
  notes: Set<number>;
  /** Don't start gliding here before this (set when notes of the previous pose still sound). */
  notBefore: number;
}

interface Press {
  start: number;
  end: number; // when the finger lets go: the note's end, or earlier if the hand must move on
  u: number;
  depth: number;
  note: number;
}

const LEAD = 0.035; // fingers arrive this long before the key goes down
const PRESS_IN = 0.03; // the dip into the key
const LIFT = 0.07; // lifting off after the note ends
const RELEASE_BLEND = 0.1; // a lifted finger rejoins the hand over this long
const SPACING = 0.95; // a free finger's distance from its neighbour, white keys
/** Thumb to little finger never wider than this (white keys): an octave plus a little. */
const MAX_HAND_U = 7.3;
const MIN_GAP = 0.55; // long fingers never closer than this (no folding over)
// How far a free (not pressing) finger may splay from its neighbour, white keys.
// Pressing fingers are already limited by the fingering engine's span table.
const MAX_SPLAY_THUMB = 4.2;
const MAX_SPLAY = 1.9;
/** Tails shorter than this are just the finger lifting off: no style change (avoids a 1–3 frame flicker). */
const MIN_SUSTAIN_TAIL = 0.1;

function smooth(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * x * (x * (x * 6 - 15) + 10); // smootherstep: no velocity jumps
}

function lerp(a: number, b: number, s: number): number {
  return a + (b - a) * s;
}

/** Where all five fingertips sit for one event: played fingers on their keys, the rest fanned naturally. */
function keyPose(hand: PlayHand, time: number, played: Map<Finger, number>, handU: number): KeyPose {
  const dir = hand === 'right' ? 1 : -1;
  const u = new Array<number>(6).fill(NaN);
  const depth = new Array<number>(6).fill(0);
  for (const [f, midi] of played) {
    u[f] = keyU(midi);
    depth[f] = isBlack(midi) ? 1 : 0;
  }
  const playedF = [...played.keys()].sort((a, b) => a - b);
  if (!playedF.length) {
    for (let f = 1; f <= 5; f++) u[f] = handU + dir * REST_U[f];
  } else {
    const lo = playedF[0];
    const hi = playedF[playedF.length - 1];
    // Free fingers outside the played ones fan out, closer together when the
    // played fingers already stretch the hand, so it never exceeds MAX_HAND_U.
    const outside = lo - 1 + (5 - hi);
    const room = MAX_HAND_U - Math.abs(u[hi] - u[lo]);
    const spacing = outside ? Math.max(MIN_GAP, Math.min(SPACING, room / outside)) : SPACING;
    for (let f = 1; f <= 5; f++) {
      if (!Number.isNaN(u[f])) continue;
      if (f < lo) u[f] = u[lo] - dir * spacing * (lo - f);
      else if (f > hi) u[f] = u[hi] + dir * spacing * (f - hi);
      else {
        // Between two played fingers: share the gap evenly.
        let a = f - 1;
        while (Number.isNaN(u[a])) a--;
        let b = f + 1;
        while (Number.isNaN(u[b])) b++;
        u[f] = lerp(u[a], u[b], (f - a) / (b - a));
        depth[f] = 0.5 * (depth[a] + depth[b]) * 0.6;
      }
      if (f < lo) depth[f] = depth[lo] * 0.4;
      if (f > hi) depth[f] = depth[hi] * 0.4;
    }
  }
  return { time, u, depth, notes: new Set(), notBefore: -Infinity };
}

function lowerBound(arr: { time: number }[] | { start: number }[], t: number, key: 'time' | 'start'): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if ((arr[m] as any)[key] <= t) lo = m + 1;
    else hi = m;
  }
  return lo; // first index with value > t
}

const MIN_TRAVEL = 0.12;

/**
 * Make a pose anatomically plausible by moving only the free fingers: the long
 * fingers stay in order and apart (the thumb may pass under, that's its job),
 * no free finger splays like a spider, and the whole hand stays within an
 * octave and a bit. Fingers on keys stay put; the fingering engine already
 * keeps those within one hand's span.
 */
function settle(fingers: FingerPose[], anchored: boolean[], dir: number): void {
  const at = (f: number) => fingers[f].u * dir; // position along the hand, thumb → little finger
  const put = (f: number, v: number) => (fingers[f].u = v * dir);
  // Allowed distance from finger f-1 to finger f.
  const lo = (f: number) => (f === 2 ? -Infinity : MIN_GAP);
  const hi = (f: number) => (f === 2 ? MAX_SPLAY_THUMB : MAX_SPLAY);
  const fix = (f: number, moveLater: boolean): boolean => {
    const d = at(f) - at(f - 1);
    if (d >= lo(f) && d <= hi(f)) return false;
    const target = d < lo(f) ? lo(f) : hi(f);
    const later = moveLater ? !anchored[f] : anchored[f - 1] && !anchored[f];
    const earlier = !later && !anchored[f - 1];
    if (later) put(f, at(f - 1) + target);
    else if (earlier) put(f - 1, at(f) - target);
    return later || earlier;
  };
  for (let iter = 0; iter < 6; iter++) {
    let changed = false;
    // Sweep out from the thumb moving the outer finger, then back moving the inner
    // one, so free fingers squeezed between two fixed ones settle in between.
    for (let f = 2; f <= 5; f++) changed = fix(f, true) || changed;
    for (let f = 5; f >= 2; f--) changed = fix(f, false) || changed;
    const span = at(5) - at(1);
    if (span > MAX_HAND_U) {
      if (!anchored[5]) put(5, at(1) + MAX_HAND_U), (changed = true);
      else if (!anchored[1]) put(1, at(5) - MAX_HAND_U), (changed = true);
    }
    if (!changed) break;
  }
}

/** When the glide from keyframe a to b starts and lands. */
function glideWindow(a: KeyPose, b: KeyPose): { start: number; arrive: number; dist: number } {
  const gap = b.time - a.time;
  let dist = 0;
  for (let f = 1; f <= 5; f++) dist = Math.max(dist, Math.abs(b.u[f] - a.u[f]));
  // Travel time grows with distance; start early enough to land just before the note.
  const travel = Math.min(0.45, Math.max(0.12, 0.1 + 0.04 * dist));
  const arrive = b.time - Math.min(LEAD, gap * 0.15);
  const hold = Math.min(0.08, gap * 0.3);
  let start = Math.max(a.time + hold, arrive - travel);
  if (start >= arrive) start = a.time + gap * 0.2; // too little time: a quick, eased jump
  // Stay while the notes being left behind still sound, as long as the hand can
  // still get there in time; if it can't, those fingers let go (the pedal holds them).
  if (b.notBefore > start) start = Math.max(start, Math.min(b.notBefore, arrive - MIN_TRAVEL));
  return { start, arrive, dist };
}

export class HandAnimator {
  readonly fingering: FingeringResult;
  private keys: Record<PlayHand, KeyPose[]> = { left: [], right: [] };
  private presses: Record<PlayHand, Press[][]> = { left: [], right: [] };
  /** Per note: when its finger lets go of the key (the note's start if it never had one). */
  private fingerOff: Float64Array;
  private noteEnd: Float64Array;
  private skipped: Uint8Array;

  constructor(notes: NoteEvent[], opts: FingeringOptions = {}) {
    this.fingering = assignFingering(notes, opts);
    this.noteEnd = Float64Array.from(notes, (n) => n.startTime + n.duration);
    this.skipped = Uint8Array.from(notes, (_, i) => (opts.skip?.(i) ? 1 : 0));
    // Unfingered notes (unreachable) sound with no finger at all: off from the start.
    this.fingerOff = Float64Array.from(notes, (n) => n.startTime);
    for (const hand of ['left', 'right'] as PlayHand[]) {
      const evs = this.fingering.events[hand];
      const perFinger: Press[][] = [[], [], [], [], [], []];
      this.keys[hand] = evs.map((e) => {
        const played = new Map<Finger, number>();
        const under = new Set<number>();
        // Fingers still holding earlier notes stay on those keys in this pose.
        for (const h of e.held) {
          played.set(h.finger, notes[h.note].midi);
          under.add(h.note);
        }
        e.notes.forEach((ni, j) => {
          const f = e.fingers[j];
          if (!f) return;
          const n = notes[ni];
          played.set(f, n.midi);
          under.add(ni);
          perFinger[f].push({
            start: n.startTime,
            end: this.fingering.perNote[ni].releaseBy,
            u: keyU(n.midi),
            depth: isBlack(n.midi) ? 1 : 0,
            note: ni,
          });
        });
        const kp = keyPose(hand, e.time, played, e.handU);
        kp.notes = under;
        return kp;
      });
      const ks = this.keys[hand];
      // A glide waits for the notes it leaves behind to end (see glideWindow).
      for (let k = 1; k < ks.length; k++) {
        let last = -Infinity;
        for (const ni of ks[k - 1].notes) {
          if (!ks[k].notes.has(ni)) last = Math.max(last, Math.min(this.noteEnd[ni], this.fingering.perNote[ni].releaseBy));
        }
        ks[k].notBefore = last;
      }
      const eventOf = new Map<number, number>();
      ks.forEach((kp, k) => kp.notes.forEach((ni) => eventOf.has(ni) || eventOf.set(ni, k)));
      for (let f = 1; f <= 5; f++) {
        const list = perFinger[f].sort((a, b) => a.start - b.start);
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          // The finger leaves with the hand: at the start of the first glide toward
          // a pose that puts this finger anywhere but on this key, if the note
          // still sounds then. Until that moment every pose keeps it on the key.
          for (let k = eventOf.get(p.note)! + 1; k < ks.length && ks[k - 1].time < p.end; k++) {
            if (Math.abs(ks[k].u[f] - p.u) < 0.05) continue;
            const go = glideWindow(ks[k - 1], ks[k]).start;
            if (go < p.end) p.end = Math.max(p.start + 0.01, go);
            break;
          }
          // A finger lets go of a key just before it has to strike the next one.
          if (i + 1 < list.length) p.end = Math.min(p.end, list[i + 1].start - PRESS_IN - 0.02);
          this.fingerOff[p.note] = p.end;
        }
      }
      this.presses[hand] = perFinger;
    }
  }

  /** False for notes the hands ignore (e.g. off the visible keyboard). */
  inRange(note: number): boolean {
    return !this.skipped[note];
  }

  /**
   * True while note `i` still sounds but no finger is on its key: the hand has
   * moved on and the pedal is holding it, or no hand could reach it at all.
   * Renderers draw such keys and bars as sustained (dimmer, outlined) so a lit
   * key never looks like a missing finger.
   */
  sustained(i: number, t: number): boolean {
    return t >= this.sustainFrom(i) && t < this.noteEnd[i];
  }

  /** From when note i is drawn as sustained (song seconds); Infinity if never. */
  sustainFrom(i: number): number {
    if (this.skipped[i]) return Infinity;
    // A lit key counts as held by the pedal from the moment its finger starts lifting off.
    const off = this.fingerOff[i];
    return off <= this.noteEnd[i] - MIN_SUSTAIN_TAIL ? off : Infinity;
  }

  hasHand(hand: PlayHand): boolean {
    return this.keys[hand].length > 0;
  }

  /** The glide between keyframes: where the hand is at t, before any held keys. */
  private glide(hand: PlayHand, t: number): { u: number[]; depth: number[]; speed: number } {
    const ks = this.keys[hand];
    const i = lowerBound(ks, t, 'time'); // ks[i-1].time <= t < ks[i].time
    if (i === 0) return { u: ks[0].u, depth: ks[0].depth, speed: 0 };
    const a = ks[i - 1];
    if (i >= ks.length) return { u: a.u, depth: a.depth, speed: 0 };
    const b = ks[i];
    const { start, arrive, dist } = glideWindow(a, b);
    const span = Math.max(1e-3, arrive - start);
    const x = (t - start) / span;
    const s = smooth(x);
    const u = new Array<number>(6);
    const depth = new Array<number>(6);
    for (let f = 1; f <= 5; f++) {
      u[f] = lerp(a.u[f], b.u[f], s);
      depth[f] = lerp(a.depth[f], b.depth[f], s);
    }
    // Peak speed of a smootherstep is 1.875× the average.
    const speed = x > 0 && x < 1 ? (dist / span) * 30 * x * x * (1 - x) * (1 - x) : 0;
    return { u, depth, speed };
  }

  pose(hand: PlayHand, t: number): HandPose | null {
    if (!this.hasHand(hand)) return null;
    const g = this.glide(hand, t);
    const fingers: FingerPose[] = [{ u: 0, depth: 0, press: 0 }];
    // Fingers on a key right now (landing or holding): those never move below.
    const anchored = [false, false, false, false, false, false];
    for (let f = 1; f <= 5; f++) {
      let u = g.u[f];
      let depth = g.depth[f];
      let press = 0;
      const list = this.presses[hand][f];
      const k = lowerBound(list, t + PRESS_IN, 'start') - 1; // latest press that has begun
      if (k >= 0) {
        const p = list[k];
        // Down at the note's start, up at its end.
        press = Math.min(smooth((t - (p.start - PRESS_IN)) / PRESS_IN), 1 - smooth((t - p.end) / LIFT));
        // While the key is held the fingertip stays on it (the poses around it
        // keep it there too, see the constructor); after, it rejoins the hand.
        const w = Math.max(0, 1 - smooth((t - p.end) / RELEASE_BLEND));
        u = lerp(u, p.u, w);
        depth = lerp(depth, p.depth, w);
        anchored[f] = t >= p.start - PRESS_IN && t <= p.end;
      }
      fingers.push({ u, depth, press: Math.max(0, press) });
    }
    settle(fingers, anchored, hand === 'right' ? 1 : -1);
    return { hand, fingers, speed: g.speed };
  }
}
