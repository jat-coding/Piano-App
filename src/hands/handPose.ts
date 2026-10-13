import type { NoteEvent } from '../types';
import {
  type HandEvent,
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
  /**
   * 0 = an idle finger (relaxes into its rest curl), 1 = on or landing on a key.
   * Ramps in while the finger approaches its next key and out after it lets go,
   * so the skeleton blends smoothly between the two.
   */
  engage: number;
  /** Preparation lift before a strike, 0..1 (already scaled down for fast passages). */
  lift: number;
  /** press and lift 20 ms ago: what an idle neighbour finger follows (finger coupling). */
  pressLag: number;
  liftLag: number;
  /** The key this finger is on or heading for is black (0..1, eased). */
  black: number;
}

/**
 * The hand's shape for the passage it is playing (see detectPassages), eased in
 * and out so it never jumps. All weights are 0..1.
 */
export interface PassageStyle {
  scale: number;
  arpeggio: number;
  octave: number;
  chord: number;
  /** Fingertips lean away from the direction of travel, degrees (screen: + = toward screen-right). */
  rotBias: number;
  /** Forearm rotation, degrees (+ = rolled toward screen-right). */
  roll: number;
  /** Extra knuckle height for a leap's arc, mm (0 outside a leap). */
  leapLift: number;
}

export interface HandPose {
  hand: PlayHand;
  /** Index 1..5 used; 0 unused. */
  fingers: FingerPose[];
  /** How fast the whole hand is gliding, white keys per second (for motion smoothing). */
  speed: number;
  /** How far the current glide goes, white keys (0 when the hand is not gliding). */
  glideDist: number;
  style: PassageStyle;
  /** Song time of this pose (for deterministic idle micro-motion). */
  t: number;
  /**
   * Per finger (1..5), the shape weights a few ms late: when the hand changes shape the
   * fingers follow one after another (15-45 ms apart, leading side first), not as a block.
   */
  lagStyle: PassageStyle[];
  /**
   * The line between the two hands (white keys, keyU): this hand stays on its side of it
   * (the left hand to the left), palm and fingers, with a small gap. NaN with one hand.
   */
  wall: number;
  /** How firmly the wall holds, 0..1: fades out only when the hands' keys truly cross. */
  wallW: number;
}

const NO_STYLE: PassageStyle = { scale: 0, arpeggio: 0, octave: 0, chord: 0, rotBias: 0, roll: 0, leapLift: 0 };

type PassageKind = 'scale' | 'arpeggio' | 'octave' | 'chord';
interface Passage {
  kind: PassageKind;
  t0: number;
  t1: number;
  /** Direction of travel along the keyboard: +1 up, -1 down (scales, arpeggios). */
  dir: number;
  /** Notes per second in the passage. */
  rate: number;
}
const EASE_IN = 0.15;
const EASE_OUT = 0.25;
/** Lift before a strike: starts this long before the onset. */
const PREP = 0.12;
/** Fingers change shape one after another, this far apart (s). */
const STAGGER = 0.03;
/** Neighbour fingers follow a moving finger this much later. */
const COUPLE_LAG = 0.02;
/** A glide this long (white keys) is a leap: the hand arcs up. */
const LEAP_KEYS = 5;
/** The thumb starts its tuck as soon as it lets go, but never earlier than this before landing. */
const THUMB_EARLY = 0.6;

interface KeyPose {
  time: number;
  u: number[]; // per finger 1..5
  depth: number[];
  /** Notes under a finger in this pose (struck now, or still held from before). */
  notes: Set<number>;
}

interface Press {
  start: number;
  end: number; // when the finger lets go: the note's end, or earlier if the hand must move on
  u: number;
  depth: number;
  note: number;
  /** Size of the preparation lift before this strike: smaller in fast passages. */
  liftAmp: number;
}

/**
 * Find the passages a pianist shapes the hand for, from one hand's events:
 * scale runs (>= 4 single notes, steps of 1-2 semitones, one direction),
 * arpeggios (>= 4 single notes, mostly steps of 3-5), octaves (two notes 12
 * apart on thumb + little finger) and chords (3+ notes).
 */
function detectPassages(evs: HandEvent[], notes: NoteEvent[]): Passage[] {
  const out: Passage[] = [];
  const endOf = (e: HandEvent) => Math.max(...e.notes.map((ni) => notes[ni].startTime + notes[ni].duration));
  for (const e of evs) {
    const m = e.notes.map((ni) => notes[ni].midi);
    if (m.length === 2 && Math.abs(m[1] - m[0]) === 12) {
      const fs = new Set(e.fingers);
      if (fs.has(1) && fs.has(5)) out.push({ kind: 'octave', t0: e.time, t1: endOf(e), dir: 0, rate: 0 });
    } else if (m.length >= 3) out.push({ kind: 'chord', t0: e.time, t1: endOf(e), dir: 0, rate: 0 });
  }
  // Runs of single notes.
  let i = 0;
  while (i < evs.length) {
    if (evs[i].notes.length !== 1) {
      i++;
      continue;
    }
    let j = i + 1;
    let dir = 0;
    let steps: number[] = [];
    while (j < evs.length && evs[j].notes.length === 1 && evs[j].time - evs[j - 1].time < 0.6) {
      const d = notes[evs[j].notes[0]].midi - notes[evs[j - 1].notes[0]].midi;
      if (!d || (dir && Math.sign(d) !== dir) || Math.abs(d) > 5) break;
      dir = Math.sign(d);
      steps.push(Math.abs(d));
      j++;
    }
    if (j - i >= 4) {
      const small = steps.filter((d) => d <= 2).length;
      const wide = steps.filter((d) => d >= 3).length;
      const kind: PassageKind | null = small === steps.length ? 'scale' : wide >= steps.length * 0.6 ? 'arpeggio' : null;
      if (kind) {
        const t0 = evs[i].time;
        const t1 = evs[j - 1].time;
        out.push({ kind, t0, t1: Math.max(t1, endOf(evs[j - 1])), dir, rate: (j - i - 1) / Math.max(0.05, t1 - t0) });
      }
      i = j - 1 > i ? j - 1 : j;
    } else i = j > i + 1 ? j - 1 : i + 1;
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

const LEAD = 0.035; // fingers arrive this long before the key goes down
const PRESS_IN = 0.03; // the dip into the key
const LIFT = 0.07; // lifting off after the note ends
const RELEASE_BLEND = 0.1; // a lifted finger rejoins the hand over this long
const APPROACH = 0.18; // a finger starts reaching for its next key this long before landing
const ENGAGE_RELEASE = 0.3;
const REACH_AHEAD = 4.5; // ...but not for a key further than this (white keys) from one still held
const HELD_FADE_IN = 0.1;
/** A finger reaches ahead only for a key within this many white keys of where the hand holds it now... */
const REACH_NEAR = 2;
/** ...the thumb further: passing under the hand is its job. */
const REACH_NEAR_THUMB = 4;
/** Fade between reaching and not, white keys. */
const REACH_FADE = 1.5;
const LAND_FREE = 0.06;
/** A fingertip stays this far (white keys) from the line between the hands: its half-width plus a small gap. */
export const SIDE_TIP = 0.33;
/**
 * Where the line between the hands goes: halfway between their innermost fingers, with a
 * finger that isn't on (or heading for) a key counted this many white keys further back,
 * so the hand that is playing keeps its keys and an idle or travelling hand makes way.
 */
const IDLE_YIELD = 3;
/** The wall fades out over this much crossing (white keys) between the hands' innermost keys. */
const CROSS_FADE = 0.3;
/**
 * A hand makes way ahead of time, easing out of the other hand's path: a line that is
 * coming dt seconds from now pulls only as far as it lies more than WALL_SPEED·dt +
 * WALL_ACCEL·dt²/2 white keys inside the current one. Looks up to WALL_AHEAD seconds ahead,
 * sampled every WALL_STEP seconds on a fixed grid (frames share the samples); a sample
 * entering the window fades in over WALL_FADE.
 */
const WALL_SPEED = 4;
const WALL_ACCEL = 30;
const WALL_AHEAD = 0.6;
const WALL_STEP = 0.05;
const WALL_FADE = 0.15;
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
  return { time, u, depth, notes: new Set() };
}

function lowerBoundNum(arr: number[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] <= t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function lowerBound(arr: { time: number }[] | { start: number }[] | { t0: number }[], t: number, key: 'time' | 'start' | 't0'): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if ((arr[m] as any)[key] <= t) lo = m + 1;
    else hi = m;
  }
  return lo; // first index with value > t
}

/** Glide time: GLIDE_MIN + GLIDE_PER_KEY per white key, at most GLIDE_MAX (s). */
const GLIDE_MIN = 0.16;
const GLIDE_PER_KEY = 0.045;
const GLIDE_MAX = 0.7;

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

/**
 * How long a glide of `dist` white keys takes when there is time for it (s): long enough
 * that the hand eases out and in instead of darting (an octave takes about half a second).
 */
function glideTime(dist: number): number {
  return Math.min(GLIDE_MAX, GLIDE_MIN + GLIDE_PER_KEY * dist);
}

/**
 * When the glide from keyframe a to b starts and lands. The hand stays put as long as it
 * can and leaves just early enough to make an unhurried glide that still lands on time.
 * Notes left behind don't hold it back: if they still sound, the pedal holds them and
 * their fingers let go as the hand leaves (they used to delay the glide until they ended,
 * which squeezed long leaps into a dash of a few frames).
 */
function glideWindow(a: KeyPose, b: KeyPose): { start: number; arrive: number; dist: number } {
  const gap = b.time - a.time;
  let dist = 0;
  for (let f = 1; f <= 5; f++) dist = Math.max(dist, Math.abs(b.u[f] - a.u[f]));
  const arrive = b.time - Math.min(LEAD, gap * 0.15);
  // The hand can't leave before the keys of `a` are struck (a beat on them for a short
  // move; a leap may leave sooner, the pedal or the other fingers carry the sound).
  const hold = Math.min(dist > LEAP_KEYS ? 0.05 : 0.08, gap * 0.25);
  const start = Math.max(a.time + hold, arrive - glideTime(dist));
  return { start, arrive, dist };
}

interface RawPose {
  fingers: FingerPose[];
  anchored: boolean[];
  hold: number[];
  g: { u: number[]; depth: number[]; speed: number; dist: number; x: number; dir: number };
}

/**
 * Keep a hand's fingertips on its side of the line between the hands (SIDE_TIP short of
 * it). A hand that isn't playing moves over as a whole, out of the way; a playing hand's
 * free fingers fold in. Fingers on keys never move (if one is past the line the keys
 * themselves cross: the wall has faded out by then, see wallAt). `hold` is how firmly
 * each finger is tied to its key (0..1, eased).
 */
function keepSide(fingers: FingerPose[], hold: number[], hand: PlayHand, wall: number, w: number): void {
  const s = hand === 'left' ? 1 : -1; // + = toward the other hand
  const limit = s * (wall - s * SIDE_TIP);
  let over = 0;
  let busy = 0;
  for (let f = 1; f <= 5; f++) {
    over = Math.max(over, s * fingers[f].u - limit);
    busy = Math.max(busy, fingers[f].press);
  }
  // A hand with no key down steps back whole (keeps its shape); one holding a key only
  // tucks its free fingers.
  const back = Math.max(0, over) * (1 - busy) * w;
  for (let f = 1; f <= 5; f++) {
    // A finger tied to its key (landing, holding, just letting go) stays with it; the hold
    // eases in and out, so a finger let go past the line glides back instead of jumping.
    const free = 1 - hold[f];
    if (free <= 0) continue;
    let v = s * fingers[f].u - back * free;
    v -= Math.max(0, v - limit) * w * free;
    fingers[f].u = s * v;
  }
}

export class HandAnimator {
  readonly fingering: FingeringResult;
  private keys: Record<PlayHand, KeyPose[]> = { left: [], right: [] };
  private presses: Record<PlayHand, Press[][]> = { left: [], right: [] };
  private passages: Record<PlayHand, Passage[]> = { left: [], right: [] };
  private maxPassage = 0;
  /** Where each hand's notes start and end (song seconds), for parking an idle hand. */
  private span: Record<PlayHand, [number, number]> = { left: [0, 0], right: [0, 0] };
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
            liftAmp: 1,
          });
        });
        const kp = keyPose(hand, e.time, played, e.handU);
        kp.notes = under;
        return kp;
      });
      const ks = this.keys[hand];
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
      // Preparation lift: full at <= 4 notes/s, less above (fast fingers stay close to the keys).
      const onsets = evs.map((e) => e.time);
      for (let f = 1; f <= 5; f++) {
        for (const p of perFinger[f]) {
          const a = lowerBoundNum(onsets, p.start - 0.5);
          const b = lowerBoundNum(onsets, p.start + 0.5);
          p.liftAmp = Math.min(1, 4 / Math.max(1e-6, b - a));
        }
      }
      this.passages[hand] = detectPassages(evs, notes);
      for (const ps of this.passages[hand]) this.maxPassage = Math.max(this.maxPassage, ps.t1 - ps.t0);
      if (ks.length) this.span[hand] = [ks[0].time, ks[ks.length - 1].time];
    }
  }

  /** The passage shape at t: every passage near t, eased in and out, strongest wins per kind. */
  private style(hand: PlayHand, t: number, g: { dist: number; x: number; dir: number }): PassageStyle {
    const st: PassageStyle = { ...NO_STYLE };
    const list = this.passages[hand];
    const hi = lowerBound(list, t + EASE_IN, 't0');
    for (let i = hi - 1; i >= 0; i--) {
      const ps = list[i];
      if (ps.t0 < t - this.maxPassage - EASE_OUT - 1) break;
      const w = smooth((t - (ps.t0 - EASE_IN)) / EASE_IN) * (1 - smooth((t - ps.t1) / EASE_OUT));
      if (w <= 0) continue;
      if (w > st[ps.kind]) {
        st[ps.kind] = w;
        if (ps.kind === 'scale') {
          // Glissando motion: fingertips point slightly away from the travel, wrist leading.
          st.rotBias = -ps.dir * 6 * Math.min(1, ps.rate / 6) * w;
          // Fast scales cross with a small forearm flick instead of a deep tuck.
          st.roll = ps.rate > 5 ? ps.dir * 5 * w : 0;
        } else if (ps.kind === 'arpeggio') {
          st.rotBias = -ps.dir * 4 * w;
          // The forearm rotates toward the next note.
          st.roll = ps.dir * 10 * w;
        }
      }
    }
    // A leap: the hand arcs up mid-flight.
    if (g.dist > LEAP_KEYS && g.x > 0 && g.x < 1) st.leapLift = Math.min(18, 4 * g.dist) * Math.sin(Math.PI * g.x);
    return st;
  }

  /** The hand that plays note i (bars take its colour): the split's, unless the fingering moved it. */
  handOf(i: number): PlayHand {
    return this.fingering.perNote[i].hand;
  }

  /**
   * Which hand is drawn on top at t. Apart, it doesn't matter (they never meet). When a
   * passage truly forces a crossing (see wallAt), the hand that crosses goes over: the one
   * that struck most recently, since it is the one reaching across.
   */
  onTop(t: number): PlayHand {
    const { wallW } = this.wallAt(t);
    if (wallW >= 1) return 'right';
    const last = (h: PlayHand) => {
      const ks = this.keys[h];
      const i = lowerBound(ks, t + 0.2, 'time');
      return i > 0 ? ks[i - 1].time : -Infinity;
    };
    return last('left') > last('right') ? 'left' : 'right';
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
  private glide(hand: PlayHand, t: number): { u: number[]; depth: number[]; speed: number; dist: number; x: number; dir: number } {
    const ks = this.keys[hand];
    const i = lowerBound(ks, t, 'time'); // ks[i-1].time <= t < ks[i].time
    if (i === 0) return { u: ks[0].u, depth: ks[0].depth, speed: 0, dist: 0, x: 0, dir: 0 };
    const a = ks[i - 1];
    if (i >= ks.length) return { u: a.u, depth: a.depth, speed: 0, dist: 0, x: 1, dir: 0 };
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
    return { u, depth, speed, dist: x > 0 && x < 1 ? dist : 0, x, dir: Math.sign(b.u[3] - a.u[3]) };
  }

  /** Press (0..1) and preparation lift (0..1) of finger f at t. */
  private pressLift(hand: PlayHand, f: number, t: number): { press: number; lift: number } {
    const list = this.presses[hand][f];
    const k = lowerBound(list, t + PRESS_IN, 'start') - 1;
    let press = 0;
    if (k >= 0) {
      const p = list[k];
      press = Math.max(0, Math.min(smooth((t - (p.start - PRESS_IN)) / PRESS_IN), 1 - smooth((t - p.end) / LIFT)));
    }
    let lift = 0;
    if (k + 1 < list.length) {
      const next = list[k + 1];
      const x = (t - (next.start - PREP)) / (PREP - PRESS_IN);
      if (x > 0 && x < 1) lift = Math.sin(Math.PI * x) * next.liftAmp * (1 - press);
    }
    return { press, lift };
  }

  /**
   * A hand with nothing to play yet (or any more) steps aside if the other hand
   * is playing where it would sit, then slides in for its first note.
   */
  private parkShift(hand: PlayHand, t: number, u: number[]): number {
    const [first, last] = this.span[hand];
    const w = Math.max(1 - smooth((t - (first - 0.9)) / 0.6), smooth((t - (last + 0.6)) / 0.6));
    if (w <= 0) return 0;
    const other: PlayHand = hand === 'right' ? 'left' : 'right';
    if (!this.hasHand(other)) return 0;
    const [oFirst, oLast] = this.span[other];
    if (t < oFirst - 0.9 || t > oLast + 1.2) return 0;
    const o = this.glide(other, t).u;
    const MARGIN = 0.8;
    let need = 0;
    if (hand === 'right') {
      const oHi = Math.max(o[1], o[2], o[3], o[4], o[5]);
      const lo = Math.min(u[1], u[2], u[3], u[4], u[5]);
      need = Math.max(0, oHi + MARGIN - lo);
    } else {
      const oLo = Math.min(o[1], o[2], o[3], o[4], o[5]);
      const hi = Math.max(u[1], u[2], u[3], u[4], u[5]);
      need = -Math.max(0, hi - (oLo - MARGIN));
    }
    return need * w;
  }

  /**
   * Both hands' fingers at t before they are kept apart, memoised for the last time asked
   * (a frame asks for each hand, and each needs the other's).
   */
  private rawAt = { t: NaN, left: null as RawPose | null, right: null as RawPose | null };
  private raw(hand: PlayHand, t: number): RawPose | null {
    if (this.rawAt.t !== t) this.rawAt = { t, left: null, right: null };
    return (this.rawAt[hand] ??= this.hasHand(hand) ? this.rawPose(hand, t) : null);
  }

  /**
   * The line between the hands at t and how firmly it holds (see HandPose.wall): halfway
   * between the left hand's innermost finger and the right hand's, where a finger that
   * isn't on its way to a key counts IDLE_YIELD keys further back. Continuous in t, since
   * every finger position and engagement is.
   */
  wallAt(t: number): { wall: number; wallW: number; a: number; b: number } {
    const L = this.raw('left', t);
    const R = this.raw('right', t);
    if (!L || !R) return { wall: NaN, wallW: 0, a: NaN, b: NaN };
    let a = -Infinity;
    let b = Infinity;
    for (let f = 1; f <= 5; f++) {
      a = Math.max(a, L.fingers[f].u - (1 - L.fingers[f].engage) * IDLE_YIELD);
      b = Math.min(b, R.fingers[f].u + (1 - R.fingers[f].engage) * IDLE_YIELD);
    }
    return { wall: (a + b) / 2, wallW: smooth((b - a) / CROSS_FADE), a, b };
  }

  private wallGrid = new Map<number, { wall: number; wallW: number; a: number; b: number }>();
  private wallAtGrid(i: number): { wall: number; wallW: number; a: number; b: number } {
    let w = this.wallGrid.get(i);
    if (!w) {
      if (this.wallGrid.size > 4000) this.wallGrid.clear();
      // Through a scratch memo slot, so the per-frame one stays valid.
      const keep = this.rawAt;
      w = this.wallAt(i * WALL_STEP);
      this.rawAt = keep;
      this.wallGrid.set(i, w);
    }
    return w;
  }

  /**
   * The line this hand keeps to at t: the line between the hands now, moved out of the way
   * early enough for where the other hand is about to play in the next WALL_AHEAD s (its
   * innermost finger that is on or heading for a key then, less SIDE_TIP, so this hand's
   * fingertips stay clear of it), easing out of the way (see WALL_SPEED). The left hand's
   * line is never right of the shared one and the right hand's never left of it, so the
   * hands still can't meet.
   */
  wallFor(hand: PlayHand, t: number): { wall: number; wallW: number } {
    const now = this.wallAt(t);
    if (!now.wallW) return now;
    const s = hand === 'left' ? 1 : -1;
    let wall = now.wall;
    const i0 = Math.floor(t / WALL_STEP) + 1;
    for (let i = i0; i * WALL_STEP <= t + WALL_AHEAD; i++) {
      const w = this.wallAtGrid(i);
      if (!w.wallW) continue;
      const dt = i * WALL_STEP - t;
      // As a sample nears the end of the window its pull fades in, so nothing jumps when it enters.
      const fade = smooth((t + WALL_AHEAD - i * WALL_STEP) / WALL_FADE);
      const other = s > 0 ? w.b : w.a;
      const cand = other - s * SIDE_TIP + s * (WALL_SPEED * dt + 0.5 * WALL_ACCEL * dt * dt);
      if (s * (cand - wall) < 0) wall = lerp(wall, cand, fade * w.wallW);
    }
    // ...but never over this hand's own keys: a finger still holding its key keeps it, and
    // the hand only makes way around it (a line through its own held key can't be met and
    // would set the palm fighting itself).
    const raw = this.raw(hand, t)!;
    for (let f = 1; f <= 5; f++) {
      const need = raw.fingers[f].u + s * SIDE_TIP;
      const lim = need - s * (1 - raw.hold[f]) * IDLE_YIELD;
      if (s * (lim - wall) > 0) wall = s * Math.min(s * lim, s * now.wall);
    }
    return { wall, wallW: now.wallW };
  }


  pose(hand: PlayHand, t: number): HandPose | null {
    const raw = this.raw(hand, t);
    if (!raw) return null;
    const { g, anchored, hold } = raw;
    // Copies: the raw pose is shared with the other hand's wall.
    const fingers = raw.fingers.map((fp) => ({ ...fp }));
    const { wall, wallW } = this.wallFor(hand, t);
    if (wallW > 0) keepSide(fingers, hold, hand, wall, wallW);
    settle(fingers, anchored, hand === 'right' ? 1 : -1);
    const style = this.style(hand, t, g);
    // Which side leads: the side the hand travels toward (screen right = higher u).
    const dirHand = hand === 'right' ? 1 : -1;
    const lead = g.dir * dirHand >= 0 ? 5 : 2;
    const lagStyle: PassageStyle[] = [style];
    for (let f = 1; f <= 5; f++) {
      const dt = f === 1 ? 0 : STAGGER * Math.abs(f - lead);
      lagStyle.push(dt ? this.style(hand, t - dt, g) : style);
    }
    return { hand, fingers, speed: g.speed, glideDist: g.dist, style, t, lagStyle, wall, wallW };
  }

  private rawPose(hand: PlayHand, t: number): RawPose {
    const g = this.glide(hand, t);
    const shift = this.parkShift(hand, t, g.u);
    const fingers: FingerPose[] = [{ u: 0, depth: 0, press: 0, engage: 0, lift: 0, pressLag: 0, liftLag: 0, black: 0 }];
    // Fingers on a key right now (landing or holding): those never move below.
    const anchored = [false, false, false, false, false, false];
    // The same, eased (0..1): how firmly each finger is tied to its key, for keepSide.
    const hold = [0, 0, 0, 0, 0, 0];
    // Keys held right now, and how firmly (fades as each finger lets go): a finger only
    // reaches ahead for its next key if that key is within a hand's reach of them.
    const held: { u: number; w: number }[] = [];
    for (let f = 1; f <= 5; f++) {
      const list = this.presses[hand][f];
      const k = lowerBound(list, t + PRESS_IN, 'start') - 1;
      // A key counts as held from the moment its finger starts down (fading in, so a new
      // far-away key doesn't yank other fingers back in one frame) until it lets go.
      if (k >= 0) held.push({ u: list[k].u, w: Math.max(0, Math.min(smooth((t - (list[k].start - PRESS_IN)) / HELD_FADE_IN), 1 - smooth((t - list[k].end) / RELEASE_BLEND))) });
    }
    for (let f = 1; f <= 5; f++) {
      let u = g.u[f] + shift;
      let depth = g.depth[f];
      let engage = 0;
      let black = 0;
      const list = this.presses[hand][f];
      const k = lowerBound(list, t + PRESS_IN, 'start') - 1; // latest press that has begun
      if (k + 1 < list.length) {
        // Reaching for the next key ahead of the hand: this is what makes a thumb
        // pass under the hand while the other fingers still hold their keys. The
        // thumb starts as soon as it lets go of its previous key (pianists "lift
        // the thumb early"), up to THUMB_EARLY before it lands.
        const next = list[k + 1];
        const land = next.start - PRESS_IN;
        let lead = APPROACH;
        // A tuck (the thumb's next key near its last one) starts as soon as it lets go; a
        // longer thumb move keeps the usual lead.
        if (f === 1) {
          const tuck = k >= 0 && Math.abs(next.u - list[k].u) <= 3;
          lead = tuck ? Math.max(0.06, land - Math.max(list[k].end, land - THUMB_EARLY)) : APPROACH * 2;
        }
        let far = 0;
        for (const h of held) if (Math.abs(h.u - next.u) > REACH_AHEAD) far = Math.max(far, h.w);
        // ...and not in the last moment before landing: the finger is going there regardless.
        far *= 1 - smooth((t - (land - LAND_FREE)) / LAND_FREE);
        const ramp = smooth((t - (land - lead)) / lead) * (1 - far);
        hold[f] = smooth((t - (land - LAND_FREE)) / LAND_FREE);
        // A finger reaches ahead only as far as it comfortably can from where the hand has it
        // now (REACH_NEAR; the thumb further, passing under is its job). The rest of the way
        // is the hand's glide. A finger stretching for a far key early would drag the palm
        // back and forth on the way, and dropping the stretch as the hand comes near would
        // snap it. Both the reach (saturating) and its pull on the palm are smooth in the
        // distance, so nothing jumps between frames.
        const base = g.u[f] + shift;
        const near = f === 1 ? REACH_NEAR_THUMB : REACH_NEAR;
        const d = next.u - base;
        const ad = Math.abs(d);
        const reach = ad <= near ? ad : near + REACH_FADE * Math.tanh((ad - near) / REACH_FADE);
        u = base + Math.sign(d) * reach * ramp;
        engage = ramp * (1 - smooth((ad - near) / (2 * REACH_FADE)));
        depth = lerp(depth, next.depth, engage);
        black = next.depth * engage;
      }
      if (k >= 0) {
        const p = list[k];
        // While the key is held the fingertip stays on it (the poses around it
        // keep it there too, see the constructor); after, it rejoins the hand.
        const w = Math.max(0, 1 - smooth((t - p.end) / RELEASE_BLEND));
        u = lerp(u, p.u, w);
        depth = lerp(depth, p.depth, w);
        anchored[f] = t >= p.start - PRESS_IN && t <= p.end;
        hold[f] = Math.max(hold[f], w);
        // The palm lets go of a released finger more slowly than the fingertip does,
        // so the hand settles instead of snapping.
        const e2 = 1 - smooth((t - p.end) / ENGAGE_RELEASE);
        if (e2 > engage) black = p.depth * e2;
        engage = Math.max(engage, e2);
      }
      const now = this.pressLift(hand, f, t);
      const lag = this.pressLift(hand, f, t - COUPLE_LAG);
      fingers.push({ u, depth, press: now.press, engage, lift: now.lift, pressLag: lag.press, liftLag: lag.lift, black });
    }
    settle(fingers, anchored, hand === 'right' ? 1 : -1);
    return { fingers, anchored, hold, g };
  }
}
