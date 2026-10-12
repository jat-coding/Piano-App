import type { NoteEvent } from '../types';
import { assignFingering, isBlack, keyU, REST_U, type Finger, type FingeringResult, type PlayHand } from './fingering';

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
}

interface Press {
  start: number;
  end: number; // already cut short if the same finger plays again
  u: number;
  depth: number;
}

const LEAD = 0.035; // fingers arrive this long before the key goes down
const PRESS_IN = 0.03; // the dip into the key
const LIFT = 0.07; // lifting off after the note ends
const RELEASE_BLEND = 0.1; // a lifted finger rejoins the hand over this long
const SPACING = 0.95; // a free finger's distance from its neighbour, white keys

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
    for (let f = 1; f <= 5; f++) {
      if (!Number.isNaN(u[f])) continue;
      if (f < lo) u[f] = u[lo] - dir * SPACING * (lo - f);
      else if (f > hi) u[f] = u[hi] + dir * SPACING * (f - hi);
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
  return { time, u, depth };
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

export class HandAnimator {
  readonly fingering: FingeringResult;
  private keys: Record<PlayHand, KeyPose[]> = { left: [], right: [] };
  private presses: Record<PlayHand, Press[][]> = { left: [], right: [] };

  constructor(notes: NoteEvent[]) {
    this.fingering = assignFingering(notes);
    for (const hand of ['left', 'right'] as PlayHand[]) {
      const evs = this.fingering.events[hand];
      const perFinger: Press[][] = [[], [], [], [], [], []];
      this.keys[hand] = evs.map((e) => {
        const played = new Map<Finger, number>();
        e.notes.forEach((ni, j) => {
          const f = e.fingers[j];
          if (!f) return;
          const n = notes[ni];
          played.set(f, n.midi);
          perFinger[f].push({
            start: n.startTime,
            end: n.startTime + n.duration,
            u: keyU(n.midi),
            depth: isBlack(n.midi) ? 1 : 0,
          });
        });
        return keyPose(hand, e.time, played, e.handU);
      });
      for (let f = 1; f <= 5; f++) {
        const list = perFinger[f].sort((a, b) => a.start - b.start);
        // A finger lets go of a key just before it has to strike the next one.
        for (let i = 0; i + 1 < list.length; i++) {
          list[i].end = Math.min(list[i].end, list[i + 1].start - PRESS_IN - 0.02);
        }
      }
      this.presses[hand] = perFinger;
    }
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
    const gap = b.time - a.time;
    let dist = 0;
    for (let f = 1; f <= 5; f++) dist = Math.max(dist, Math.abs(b.u[f] - a.u[f]));
    // Travel time grows with distance; start early enough to land just before the note.
    const travel = Math.min(0.45, Math.max(0.12, 0.1 + 0.04 * dist));
    const arrive = b.time - Math.min(LEAD, gap * 0.15);
    const hold = Math.min(0.08, gap * 0.3);
    let start = Math.max(a.time + hold, arrive - travel);
    if (start >= arrive) start = a.time + gap * 0.2; // too little time: a quick, eased jump
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
        // While the key is held (and just after) the fingertip stays on it, unless
        // the hand has already moved too far away to keep it there.
        const stay = 1 - smooth((t - p.end) / RELEASE_BLEND);
        const reach = 1 - smooth((Math.abs(p.u - u) - 2.2) / 0.8);
        const w = Math.max(0, Math.min(stay, reach));
        u = lerp(u, p.u, w);
        depth = lerp(depth, p.depth, w);
        press *= reach;
      }
      fingers.push({ u, depth, press: Math.max(0, press) });
    }
    // Keep the long fingers in order and apart, so the hand never folds over
    // itself. The thumb is exempt: passing under the hand is its job.
    const dir = hand === 'right' ? 1 : -1;
    for (let f = 3; f <= 5; f++) {
      const min = fingers[f - 1].u + dir * 0.55;
      if (dir > 0 ? fingers[f].u < min : fingers[f].u > min) {
        // A pressed finger wins: move the free one.
        if (fingers[f].press >= fingers[f - 1].press) fingers[f - 1].u = fingers[f].u - dir * 0.55;
        else fingers[f].u = min;
      }
    }
    return { hand, fingers, speed: g.speed };
  }
}
