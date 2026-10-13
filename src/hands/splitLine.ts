import type { NoteEvent } from '../types';
import type { PlayHand } from './fingering';

/**
 * Which hand plays each note, with one hard rule: the left hand's notes are never to the
 * right of the right hand's notes that sound with them or close to them in time (on screen,
 * a blue bar is never right of an orange one). Transcribed songs come with a rough
 * pitch split that breaks this whenever a melody dips (the reel's G#4/A4/F#4/D4 went to the
 * left hand right after the right hand's D4/F#4), and then a hand plays on the wrong side.
 *
 * Exact, not greedy: "left" must be a down-set of the order "a is lower than b and close to
 * it in time", so the best split is a minimum closure, found with one max-flow. Costs:
 * disagreeing with the given split (small), a hand holding or jumping across more than it
 * can reach (large), and the two hands landing next to each other (medium).
 */

/**
 * Two notes are "close in time" if the gap between their sounding spans is under this (s):
 * then they can be on screen together (the export shows up to 3.2 s of falling notes).
 */
export const SPLIT_GAP = 3.2;
/** The same key in both hands is fine further apart than this (a shared middle note, s). */
export const SAME_KEY_GAP = 1.0;
/** Widest one hand holds at once, semitones (thumb to little finger, see MAX_HAND_SPAN). */
const REACH = 12;
/** How fast a hand can move to a new spot, semitones per second (beyond its reach). */
const MOVE = 60;
const C_LABEL = 1;
const C_REACH = 3; // per semitone past what the hand can hold or reach in time
const C_FAR = 1.5; // per semitone past a seventh, for notes struck together
const C_SPREAD = 0.15; // per semitone past a fifth, for notes struck together (an octave stays in one hand)
const C_NEAR = 2; // the two hands on keys a whole tone or less apart, at about the same time
// Giving a note to a hand the split has idle then (no notes within WAKE_S): a stretch alone
// doesn't bring the other hand in.
const C_WAKE = 4;
const WAKE_S = 2;
const INF = 1e9;

/** Struck together (one chord, or close enough that the hand can't move in between). */
const TOGETHER = 0.12;

function spanGap(a: NoteEvent, b: NoteEvent): number {
  const ea = a.startTime + a.duration;
  const eb = b.startTime + b.duration;
  return Math.max(0, Math.max(a.startTime, b.startTime) - Math.min(ea, eb));
}

/** A left-hand note l and a right-hand note r break the rule (l right of r, or on r's key soon after). */
export function crossed(l: NoteEvent, r: NoteEvent): boolean {
  const gap = spanGap(l, r);
  return l.midi > r.midi ? gap < SPLIT_GAP : l.midi === r.midi && gap < SAME_KEY_GAP;
}

/** Notes in `idx` that a left-hand note i would sit right of, or a right-hand note left of. */
export function crossesAt(notes: NoteEvent[], idx: number[], handOf: PlayHand[], i: number, hand: PlayHand): boolean {
  for (const j of idx) {
    if (j === i || handOf[j] === hand) continue;
    if (hand === 'left' ? crossed(notes[i], notes[j]) : crossed(notes[j], notes[i])) return true;
  }
  return false;
}

/** Re-split `idx` (sorted by onset) in place in handOf. Returns how many notes changed hand. */
export function resplit(notes: NoteEvent[], idx: number[], handOf: PlayHand[]): number {
  const n = idx.length;
  if (n < 2) return 0;
  // Node k = note idx[k]; source side = left hand.
  const S = n;
  const T = n + 1;
  const g = new Flow(n + 2);
  const cL = new Float64Array(n); // cost if the note goes to the left hand
  const cR = new Float64Array(n);
  const busy = (hand: PlayHand, t: number, self: number): boolean =>
    idx.some((j) => j !== self && handOf[j] === hand && Math.abs(notes[j].startTime - t) <= WAKE_S);
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const other: PlayHand = handOf[i] === 'left' ? 'right' : 'left';
    const c = C_LABEL + (busy(other, notes[i].startTime, i) ? 0 : C_WAKE);
    if (handOf[i] === 'left') cR[k] += c;
    else cL[k] += c;
  }
  // Pairs close in time. Notes are sorted by onset, so stop once onsets are far apart and
  // the earlier note has ended; long notes keep pairing for as long as they sound.
  // Largest pair cost per note, as a max (not a sum: a chord isn't several times as hard).
  const reachR = new Float64Array(n);
  const reachL = new Float64Array(n);
  for (let a = 0; a < n; a++) {
    const na = notes[idx[a]];
    const endA = na.startTime + na.duration;
    for (let b = a + 1; b < n; b++) {
      const nb = notes[idx[b]];
      if (nb.startTime - endA >= SPLIT_GAP) break;
      const [lo, hi] = na.midi <= nb.midi ? [a, b] : [b, a];
      const nlo = notes[idx[lo]];
      const nhi = notes[idx[hi]];
      // Order: hi in the left hand forces lo there too (same key: both ways).
      if (nlo.midi !== nhi.midi) g.add(hi, lo, INF);
      else if (spanGap(nlo, nhi) < SAME_KEY_GAP) g.add(hi, lo, INF), g.add(lo, hi, INF);
      const d = nhi.midi - nlo.midi;
      const dt = Math.abs(nb.startTime - na.startTime);
      // One hand taking both: it must reach across d in dt.
      let c = C_REACH * Math.max(0, d - REACH - MOVE * Math.max(0, dt - 0.05));
      // Struck together: past a fifth it spreads the hand, past a seventh the drawn hand
      // barely reaches (fingertips fall short of the outer keys).
      if (dt <= TOGETHER) c += C_SPREAD * Math.max(0, d - 7) + C_FAR * Math.max(0, d - 10);
      // lo in the right hand means hi is too (order), so "both right" is a cost on lo alone;
      // likewise "both left" is a cost on hi alone.
      reachR[lo] = Math.max(reachR[lo], c);
      reachL[hi] = Math.max(reachL[hi], c);
      // The two hands side by side, about the same moment.
      if (d > 0 && d <= 2 && (dt <= 0.3 || spanGap(nlo, nhi) === 0)) g.add(lo, hi, C_NEAR);
    }
  }
  for (let k = 0; k < n; k++) {
    cR[k] += reachR[k];
    cL[k] += reachL[k];
    if (cR[k] > 0) g.add(S, k, cR[k]); // cut when k ends on the right (sink) side
    if (cL[k] > 0) g.add(k, T, cL[k]);
  }
  g.maxflow(S, T);
  const left = g.sourceSide(S);
  let moved = 0;
  for (let k = 0; k < n; k++) {
    const h: PlayHand = left[k] ? 'left' : 'right';
    if (handOf[idx[k]] !== h) (handOf[idx[k]] = h), moved++;
  }
  return moved;
}

/** Dinic max-flow on a small graph. */
class Flow {
  private head: Int32Array;
  private to: number[] = [];
  private cap: number[] = [];
  private next: number[] = [];
  private level: Int32Array;
  private it: Int32Array;
  constructor(private nv: number) {
    this.head = new Int32Array(nv).fill(-1);
    this.level = new Int32Array(nv);
    this.it = new Int32Array(nv);
  }
  add(u: number, v: number, c: number): void {
    this.to.push(v), this.cap.push(c), this.next.push(this.head[u]), (this.head[u] = this.to.length - 1);
    this.to.push(u), this.cap.push(0), this.next.push(this.head[v]), (this.head[v] = this.to.length - 1);
  }
  private bfs(s: number, t: number): boolean {
    this.level.fill(-1);
    const q = [s];
    this.level[s] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const u = q[qi];
      for (let e = this.head[u]; e >= 0; e = this.next[e]) {
        if (this.cap[e] > 1e-9 && this.level[this.to[e]] < 0) {
          this.level[this.to[e]] = this.level[u] + 1;
          q.push(this.to[e]);
        }
      }
    }
    return this.level[t] >= 0;
  }
  private dfs(u: number, t: number, f: number): number {
    if (u === t) return f;
    for (; this.it[u] >= 0; this.it[u] = this.next[this.it[u]]) {
      const e = this.it[u];
      const v = this.to[e];
      if (this.cap[e] > 1e-9 && this.level[v] === this.level[u] + 1) {
        const d = this.dfs(v, t, Math.min(f, this.cap[e]));
        if (d > 0) {
          this.cap[e] -= d;
          this.cap[e ^ 1] += d;
          return d;
        }
      }
    }
    return 0;
  }
  maxflow(s: number, t: number): number {
    let flow = 0;
    while (this.bfs(s, t)) {
      this.it.set(this.head);
      for (let f = this.dfs(s, t, INF); f > 0; f = this.dfs(s, t, INF)) flow += f;
    }
    return flow;
  }
  /** After maxflow: nodes still reachable from s in the residual graph. */
  sourceSide(s: number): Uint8Array {
    const seen = new Uint8Array(this.nv);
    const q = [s];
    seen[s] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const u = q[qi];
      for (let e = this.head[u]; e >= 0; e = this.next[e]) {
        if (this.cap[e] > 1e-9 && !seen[this.to[e]]) (seen[this.to[e]] = 1), q.push(this.to[e]);
      }
    }
    return seen;
  }
}
