import type { HandPose } from './handPose';
import type { PlayHand } from './fingering';

/**
 * A kinematic hand: a rigid palm (screen position + a small rotation, plus a
 * knuckle height above the keys and a pitch), fingers as chains of fixed-length
 * bones from their knuckles, and a thumb with its own base joint (CMC) low on
 * the palm. Fingertip targets come from the HandPose (the fingering engine +
 * eased glides); this solves where the palm must be so every engaged finger can
 * reach its key without breaking anatomy, then bends each finger onto its target.
 *
 * The finger chains are 3D: each long finger has an MCP and a PIP angle, with
 * the DIP coupled to the PIP (DIP = 0.67 PIP, as in real fingers), and the
 * fingertip has a height above the keys. The screen shows them straight from
 * above, so each bone appears as L·cos(its angle to the keys): a bent finger
 * looks shorter, never longer, and no bone ever changes length. The heights
 * drive the shading and the contact shadow (drawHands.ts).
 *
 * Good technique, as numbers (research/hands-phase7-technique-spec-2026-10-12.md):
 * a relaxed "dome" at rest (MCP ~20°, PIP ~35°), knuckles level with the wrist,
 * keystrokes driven by the MCP while PIP/DIP give slightly, idle fingers low and
 * quiet, hard joint limits (no hyperextension), splay that narrows as the MCP
 * flexes, and per-passage shapes (scales, octaves, arpeggios, chords, leaps).
 *
 * Everything is a pure function of the HandPose, so scrub and seek keep working.
 *
 * Proportions: bone lengths and knuckle layout are rounded adult averages derived
 * from published hand-segment proportion data (Buryanov & Kotiuk, "Proportions of
 * Hand Segments", Int. J. Morphol. 28(3):755-758, 2010, open access via SciELO),
 * with ~4 mm of fingertip pad added to each distal bone. Numbers only, no artwork.
 */

/** Millimetres in a white key's width (standard piano: 23.5 mm). */
const KEY_MM = 23.5;
/** The drawn hand is a little smaller than life so an octave stays a comfortable reach. */
export const HAND_SCALE = 0.9;

export interface FingerSpec {
  /** Bone lengths, mm: proximal, middle, distal (+pad). Thumb: metacarpal, proximal, distal (+pad). */
  bones: number[];
  /** Knuckle (MCP; CMC for the thumb) in the hand frame, mm: a = across (thumb → little), v = forward. */
  base: [number, number];
  /** Neutral direction, degrees from forward, + toward the little finger. */
  neutral: number;
  /** Splay limits around neutral at MCP 0°, degrees (thumb: limits of its swing from forward). */
  splay: [number, number];
  /** Width at the base / at the tip, mm. */
  width: [number, number];
}

// Index 0 = thumb, 1..4 = index..little (finger f ↔ FINGERS[f - 1]).
export const FINGERS: FingerSpec[] = [
  { bones: [46, 32, 27], base: [-22, -75], neutral: -30, splay: [-80, 42], width: [22, 17] },
  { bones: [40, 23, 22], base: [-28, 0], neutral: -6, splay: [-22, 18], width: [16.5, 13] },
  { bones: [45, 27, 23], base: [-9, 4], neutral: 0, splay: [-15, 15], width: [17, 13.5] },
  { bones: [42, 26, 23], base: [10, 1], neutral: 5, splay: [-14, 14], width: [16, 12.5] },
  { bones: [33, 18, 21], base: [28, -7], neutral: 12, splay: [-18, 26], width: [14, 11] },
];

const RAD = Math.PI / 180;

/** DIP flexion = DIP_RATIO × PIP flexion (Rijpkema & Girard 1991; widely used). */
export const DIP_RATIO = 0.67;
/** Rest ("ready") pose, degrees [MCP, PIP] for fingers 2..5 (index 0, 1 unused). */
export const REST: [number, number][] = [[0, 0], [0, 0], [22, 38], [20, 35], [20, 35], [15, 25]];
/** Hard joint limits, degrees. */
export const LIM = { mcp: [-5, 60] as [number, number], pip: [5, 75] as [number, number], dip: [0, 55] as [number, number], thumbIp: [0, 45] as [number, number] };
/** Little finger: flatter than the others, but never flat. */
const PIP_MIN_LITTLE = 15;
/** Knuckle (middle MCP) height above the white keys at rest, mm: the dome. */
export const H0 = 60;
/** The lowest the knuckles go when a finger has to reach far (the hand flattens). */
const H_MIN = 28;
/** The forearm rolls toward the little finger to lend it reach: its knuckle drops up to this, mm. */
const ROLL_DROP = 12;
const OCTAVE_ROLL_DROP = 16;
/** A cramped finger on its key may curl its fingertip this far (deg to the key) past pointing straight down. */
const TIP_CURL_MAX = 108;
/** An idle fingertip hovers this far above its key, mm. */
export const HOVER = 3;
/** A black key's top is this far above the white keys, mm. */
export const BLACK_Z = 12;
/** A key goes down this far, mm. */
export const KEY_DIP = 10;
/** Keystroke: the MCP does the work, PIP and DIP give a little (Goebl & Palmer 2013). */
const PRESS_MCP = 9;
const PRESS_PIP = -2;
const PRESS_DIP_RATIO = -0.08;
/** Preparation lift before a strike (MCP extension), degrees. */
const LIFT_MCP = -6;
/** Idle fingers: a hair above the key, with a slow, tiny drift each. */
const MICRO_MCP = 1.2;
/** How much an idle finger follows its neighbour's MCP move (pianist-scaled enslaving). */
const COUPLE: Record<string, number> = { '4-5': 0.15, '5-4': 0.15, '3-4': 0.12, '4-3': 0.12, '2-3': 0.06, '3-2': 0.06 };
/** Octaves: the middle fingers curl up out of the way (PIP 55-70°, tips 15-25 mm up). */
const OCTAVE_PIP_MIN = 55;
const OCTAVE_TIP_Z = 20;
const OCTAVE_REACH = 0.62;
/** Thumb phalanges per unit of curl: MCP, IP. */
export const THUMB_FLEX = [35, 55];
export const CURL_MAX = 0.6;
const THUMB_CURL_REST = 0.3;
/** Preferred angle between the thumb's metacarpal and its phalanges, degrees (+ toward the palm). */
const THUMB_BEND = 12;
const THUMB_BEND_LIM: [number, number] = [-15, 55];
const MAX_TILT = 0.35; // palm rotation limit, radians (~20°)
/** The forearm follows the palm's rotation with this gain, so the wrist bends sideways only a little. */
export const FOREARM_GAIN = 0.7;

/** Splay narrows as the MCP flexes: the collateral ligaments tighten. */
export function splayLimitEff(f: number, mcp: number): [number, number] {
  const s = FINGERS[f - 1].splay;
  if (f === 1) return [s[0], s[1]];
  const k = 1 - 0.6 * Math.min(1, Math.max(0, mcp / 60));
  return [s[0] * k, s[1] * k];
}

/** Chain geometry for fingers 2..5: horizontal reach and drop (mm) for MCP m, PIP p (deg), palm pitch psi. */
export function fk(f: number, m: number, p: number, psi = 0, dip = DIP_RATIO * p): { h: number; v: number; phi: number[] } {
  const [L1, L2, L3] = FINGERS[f - 1].bones;
  const a1 = (psi + m) * RAD;
  const a2 = a1 + p * RAD;
  const a3 = a2 + dip * RAD;
  return {
    h: L1 * Math.cos(a1) + L2 * Math.cos(a2) + L3 * Math.cos(a3),
    v: L1 * Math.sin(a1) + L2 * Math.sin(a2) + L3 * Math.sin(a3),
    phi: [a1, a2, a3],
  };
}

/** The finger's knuckle height relative to the middle knuckle, mm: the knuckle arch, lowest at the little finger. */
const KNUCKLE_DZ = [0, 0, 0, 0, 0, 0].map((_, f) => {
  if (f < 2) return 0;
  const r = fk(f, REST[f][0], REST[f][1]);
  return r.v + HOVER - H0;
});
/** Top-down reach of an idle finger at rest, mm. */
const REST_REACH = [0, 0, 0, 0, 0, 0].map((_, f) => (f < 2 ? 0 : fk(f, REST[f][0], REST[f][1]).h));
const FLAT_LEN = [0, 1, 2, 3, 4, 5].map((f) => (f ? FINGERS[f - 1].bones.reduce((s, x) => s + x, 0) : 0));
/** Furthest a finger reaches top-down (hand flattened to H_MIN), and the nearest (fully curled). */
const REACH_MAX = [0, 1, 2, 3, 4, 5].map((f) => {
  if (f === 0) return 0;
  if (f === 1) return reachThumb(0);
  const drop = Math.max(0, H_MIN + KNUCKLE_DZ[f]);
  return Math.sqrt(Math.max(0, (0.985 * FLAT_LEN[f]) ** 2 - drop * drop));
});
const REACH_MIN = [0, 1, 2, 3, 4, 5].map((f) => (f === 0 ? 0 : f === 1 ? reachThumb(CURL_MAX) : fk(f, 45, 27).h));

/**
 * For each long finger and each drop (knuckle height above the fingertip, whole mm),
 * the nearest and furthest the tip can be top-down within the joint limits (fingertip
 * never pointing back). Built once by sweeping MCP and PIP. This is what lets the
 * knuckle height be chosen so every engaged finger can reach its key.
 */
const DROP_MAX = 130;
const REACH_RANGE: { lo: Float64Array; hi: Float64Array }[] = [0, 1, 2, 3, 4, 5].map((f) => {
  const lo = new Float64Array(DROP_MAX + 1).fill(Infinity);
  const hi = new Float64Array(DROP_MAX + 1).fill(-Infinity);
  if (f < 2) return { lo, hi };
  const pipMin = f === 5 ? PIP_MIN_LITTLE : LIM.pip[0];
  for (let m = LIM.mcp[0] + 3; m <= LIM.mcp[1]; m += 1) {
    for (let p = pipMin; p <= LIM.pip[1]; p += 1) {
      if (m + (1 + DIP_RATIO) * p > 90) break;
      const r = fk(f, m, p);
      const b = Math.round(r.v);
      if (b < 0 || b > DROP_MAX) continue;
      if (r.h < lo[b]) lo[b] = r.h;
      if (r.h > hi[b]) hi[b] = r.h;
    }
  }
  // Drops the sweep never reaches take the nearest reached one (no infinities downstream).
  const ok = (i: number) => Number.isFinite(lo[i]);
  let first = 0;
  while (first <= DROP_MAX && !ok(first)) first++;
  for (let i = 0; i < first; i++) (lo[i] = lo[first]), (hi[i] = hi[first]);
  for (let i = first + 1; i <= DROP_MAX; i++) if (!ok(i)) (lo[i] = lo[i - 1]), (hi[i] = hi[i - 1]);
  return { lo, hi };
});
/** The largest drop (mm) at which finger f still reaches d top-down. */
function maxDrop(f: number, d: number): number {
  const t = REACH_RANGE[f];
  if (t.hi[0] < d) return 0;
  for (let i = 1; i <= DROP_MAX; i++) {
    if (t.hi[i] < d) {
      // Interpolate between bins so the height changes smoothly.
      const a = t.hi[i - 1];
      const b = t.hi[i];
      return i - 1 + (a - d) / Math.max(1e-6, a - b);
    }
  }
  return DROP_MAX;
}

export function reachRange(f: number, drop: number): [number, number] {
  const t = REACH_RANGE[f];
  const b = Math.max(0, Math.min(DROP_MAX, drop));
  const i = Math.floor(b);
  const j = Math.min(DROP_MAX, i + 1);
  const s = b - i;
  return [t.lo[i] + (t.lo[j] - t.lo[i]) * s, t.hi[i] + (t.hi[j] - t.hi[i]) * s];
}

/**
 * Finger IK: MCP and PIP (DIP coupled) so the tip is d mm out (top-down) and
 * `drop` mm below the knuckle. Damped Gauss-Newton from a fixed start (so it is
 * deterministic), projected onto the joint limits after every step. wH / wV
 * weigh the two goals when both can't be met: an engaged finger keeps its key
 * (top-down position), an idle one keeps its height.
 */
export function ikFinger(f: number, d: number, drop: number, psi: number, wH = 1, wV = 0.5, pipFloor = 0, tipCap = 90): [number, number] {
  const [L1, L2, L3] = FINGERS[f - 1].bones;
  const pipMin = Math.max(pipFloor, f === 5 ? PIP_MIN_LITTLE : LIM.pip[0]);
  let m = REST[f][0];
  let p = Math.max(pipMin, REST[f][1]);
  const R = DIP_RATIO;
  for (let it = 0; it < 14; it++) {
    const a1 = (psi + m) * RAD;
    const a2 = a1 + p * RAD;
    const a3 = a2 + R * p * RAD;
    const H = L1 * Math.cos(a1) + L2 * Math.cos(a2) + L3 * Math.cos(a3);
    const V = L1 * Math.sin(a1) + L2 * Math.sin(a2) + L3 * Math.sin(a3);
    const eH = wH * (H - d);
    const eV = wV * (V - drop);
    if (Math.abs(eH) + Math.abs(eV) < 1e-3) break;
    // Jacobian (per radian), weighted.
    const Hm = -V;
    const Hp = -(L2 * Math.sin(a2) + (1 + R) * L3 * Math.sin(a3));
    const Vm = H;
    const Vp = L2 * Math.cos(a2) + (1 + R) * L3 * Math.cos(a3);
    const j11 = wH * Hm, j12 = wH * Hp, j21 = wV * Vm, j22 = wV * Vp;
    const A11 = j11 * j11 + j21 * j21 + 30;
    const A12 = j11 * j12 + j21 * j22;
    const A22 = j12 * j12 + j22 * j22 + 30;
    const g1 = j11 * eH + j21 * eV;
    const g2 = j12 * eH + j22 * eV;
    const det = A11 * A22 - A12 * A12 || 1e-9;
    const dm = (-(A22 * g1) + A12 * g2) / det;
    const dp = (A12 * g1 - A11 * g2) / det;
    m += Math.max(-25, Math.min(25, dm / RAD));
    p += Math.max(-25, Math.min(25, dp / RAD));
    m = Math.max(LIM.mcp[0] + 3, Math.min(LIM.mcp[1], m));
    p = Math.max(pipMin, Math.min(LIM.pip[1], p));
    // The fingertip at most points straight down at the key, never back under the hand.
    const over = psi + m + (1 + R) * p - tipCap;
    if (over > 0) p = Math.max(pipMin, p - over / (1 + R));
  }
  return [m, p];
}

/** Top-down reach of the thumb's phalanges at curl c, mm. */
function reachThumb(c: number): number {
  const [, p, d] = FINGERS[0].bones;
  const a1 = THUMB_FLEX[0] * c * RAD;
  const a2 = a1 + THUMB_FLEX[1] * c * RAD;
  return p * Math.cos(a1) + d * Math.cos(a2);
}

/** The thumb curl that gives a phalanx reach of d (clamped to what anatomy allows). */
function thumbCurlFor(d: number): number {
  if (d >= reachThumb(0)) return 0;
  if (d <= reachThumb(CURL_MAX)) return CURL_MAX;
  let lo = 0;
  let hi = CURL_MAX;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (reachThumb(m) > d) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

export interface Pt {
  x: number;
  y: number;
}

export interface PalmPose {
  x: number; // knuckle-line centre, canvas px
  y: number;
  rot: number; // radians, + = fingers lean toward screen-right
  /** Middle-knuckle height above the white keys, mm. */
  h: number;
  /** Dorsum pitch, degrees (+ = knuckles lower than the wrist). */
  psi: number;
  /** Forearm rotation (pronation/supination), degrees; shows as shading and palm width. */
  roll: number;
}

export interface FingerSolve {
  /** Joints from the knuckle (thumb: CMC, MCP, IP) to the tip, canvas px. */
  joints: Pt[];
  /** Joint heights above the white keys, mm (same order as joints). */
  z: number[];
  /** Joints in the hand frame, mm (a across, v forward, z up): for checks. */
  joints3: [number, number, number][];
  /** Joint angles, degrees. Thumb: mcp/pip = its MCP/IP flexion, dip = 0. */
  mcp: number;
  pip: number;
  dip: number;
  /** Cumulative angle of each bone to the keys, radians (+ = pointing down). */
  phi: number[];
  /** Thumb curl (0..CURL_MAX); 0 for the long fingers. */
  curl: number;
  /** Splay from neutral, degrees (thumb: swing of the whole thumb from forward). */
  splay: number;
  /** Where the fingertip was asked to be. */
  target: Pt;
  /** Distance from the solved tip to the target, px (0 = on it). */
  miss: number;
  press: number;
  engage: number;
  /** On a black key (0..1). */
  black: number;
}

export interface Skeleton {
  hand: PlayHand;
  palm: PalmPose;
  /** Forearm angle on screen, radians (follows palm.rot with FOREARM_GAIN). */
  forearm: number;
  /** px per mm. */
  k: number;
  dir: number;
  fingers: FingerSolve[]; // 1..5, index 0 unused
  toWorld: (a: number, v: number) => Pt;
  toLocal: (q: Pt) => [number, number];
}

/** Where the fingertips go on the keys, in canvas px. */
export interface TipFrame {
  uToX: (u: number) => number;
  /** Hand size unit, px per white key. */
  unit: number;
  whiteTipY: number;
  blackTipY: number;
  /** Where the thumb plays a white key: further toward the player, it's the short finger. */
  thumbTipY: number;
  /** The deepest a fingertip goes into the keys (near the fallboard). */
  deepY: number;
}

function frame(p: { x: number; y: number; rot: number }, k: number, dir: number) {
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  // Hand frame: a across (mirrored for the left hand), v forward (up the screen).
  const toWorld = (a: number, v: number): Pt => {
    const lx = dir * a * k;
    const ly = -v * k;
    return { x: p.x + lx * c - ly * s, y: p.y + lx * s + ly * c };
  };
  const toLocal = (q: Pt): [number, number] => {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;
    return [(dir * lx) / k, -ly / k];
  };
  return { toWorld, toLocal };
}

/** Angle of (a, v) from forward, degrees, + toward the little finger. */
function angleOf(a: number, v: number): number {
  return Math.atan2(a, v) / RAD;
}

function hinge(x: number): number {
  return x > 0 ? x : 0;
}

function lerp(a: number, b: number, s: number): number {
  return a + (b - a) * s;
}

/** A small deterministic hash in [0, 1) for (hand, finger): per-finger phases of the idle drift. */
function hash01(hand: PlayHand, f: number): number {
  const x = Math.sin((hand === 'right' ? 12.9898 : 78.233) * (f + 1) * 4.1) * 43758.5453;
  return x - Math.floor(x);
}

/** The fingertip's target in canvas px: on its key, or relaxed for an idle finger. */
function tipTarget(pose: HandPose, f: number, tf: TipFrame): Pt {
  const fp = pose.fingers[f];
  let y = tf.whiteTipY + (tf.blackTipY - tf.whiteTipY) * fp.depth;
  if (f === 1) y += (tf.thumbTipY - tf.whiteTipY) * (1 - fp.depth); // the thumb is shorter
  return { x: tf.uToX(fp.u), y };
}

/** Thumb chain from CMC to a tip at local (a, v): returns MCP local, curl, bend. */
function thumbIK(ta: number, tv: number): { mcp: [number, number]; curl: number; tip: [number, number]; swing: number } {
  const spec = FINGERS[0];
  const [ca, cv] = spec.base;
  const Lm = spec.bones[0];
  const da = ta - ca;
  const dv = tv - cv;
  let D = Math.hypot(da, dv);
  let swing = angleOf(da, dv);
  swing = Math.min(spec.splay[1], Math.max(spec.splay[0], swing));
  const rMax = REACH_MAX[1];
  const rMin = REACH_MIN[1];
  D = Math.min(Lm + rMax, Math.max(Math.abs(Lm - rMin) + 1e-6, D));
  // Law of cosines with the preferred bend; clamp the phalanx reach, then re-solve the bend.
  const pref = THUMB_BEND * RAD;
  let r = -Lm * Math.cos(pref) + Math.sqrt(Math.max(0, D * D - Lm * Lm * Math.sin(pref) ** 2));
  r = Math.min(rMax, Math.max(rMin, r));
  let cg = (D * D - Lm * Lm - r * r) / (2 * Lm * r);
  cg = Math.min(1, Math.max(-1, cg));
  let bend = Math.acos(cg);
  bend = Math.min(THUMB_BEND_LIM[1] * RAD, Math.max(THUMB_BEND_LIM[0] * RAD, bend));
  // The bend turns the phalanges toward the palm (+a for this frame).
  const off = Math.atan2(r * Math.sin(bend), Lm + r * Math.cos(bend));
  const metaAng = swing * RAD - off;
  const mcp: [number, number] = [ca + Lm * Math.sin(metaAng), cv + Lm * Math.cos(metaAng)];
  const phAng = metaAng + bend;
  const tip: [number, number] = [mcp[0] + r * Math.sin(phAng), mcp[1] + r * Math.cos(phAng)];
  return { mcp, curl: thumbCurlFor(r), tip, swing };
}

function solve3(A: number[][], b: number[]): number[] {
  // 3x3 Gaussian elimination with partial pivoting.
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    const d = M[i][i] || 1e-12;
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const m = M[r][i] / d;
      for (let c = i; c < 4; c++) M[r][c] -= m * M[i][c];
    }
  }
  return [M[0][3] / (M[0][0] || 1e-12), M[1][3] / (M[1][1] || 1e-12), M[2][3] / (M[2][2] || 1e-12)];
}

/**
 * Solve the whole hand for one HandPose. Palm first (least-squares over the
 * fingertip targets with hard-ish anatomy limits as steep penalties), then the
 * knuckle height (lowered only as far as a far-reaching finger needs), then each
 * finger by IK (splay, then MCP/PIP in the vertical plane) with fixed bones.
 */
export function solveSkeleton(pose: HandPose, tf: TipFrame): Skeleton {
  const dir = pose.hand === 'right' ? 1 : -1;
  const st = pose.style;
  // A leap's arc: the hand looks ~4% bigger at the top (closer to the eye).
  const k = ((tf.unit * HAND_SCALE) / KEY_MM) * (1 + 0.04 * Math.min(1, st.leapLift / 40));
  const targets: Pt[] = [{ x: 0, y: 0 }];
  for (let f = 1; f <= 5; f++) targets.push(tipTarget(pose, f, tf));
  const engage = pose.fingers.map((fp) => fp.engage ?? 0);
  /**
   * A key can be pressed anywhere along its length. When the thumb (or another
   * finger) is on a black key the whole hand comes forward, so the long fingers
   * play their white keys deeper in, instead of the palm twisting. A fixed rule of
   * the pose, not of the palm, so the solve stays smooth.
   */
  let fwd = engage[1] * pose.fingers[1].depth;
  for (let f = 2; f <= 5; f++) fwd = Math.max(fwd, 0.5 * engage[f] * pose.fingers[f].depth);
  const thumbBlack = engage[1] * pose.fingers[1].depth;
  const effTarget = (f: number): Pt => {
    const t = targets[f];
    if (f === 1) return t;
    // With the thumb on a black key the long fingers play their black keys further in too.
    if (pose.fingers[f].depth > 0) return { x: t.x, y: t.y + (tf.deepY - tf.blackTipY) * 0.5 * thumbBlack * pose.fingers[f].depth };
    const deep = Math.max(tf.deepY, tf.blackTipY + 0.2 * tf.unit);
    return { x: t.x, y: t.y + (deep - tf.whiteTipY) * fwd };
  };

  const rotBias = st.rotBias * RAD;
  // Thumb rest tip in the hand frame.
  const thumbRest: [number, number] = (() => {
    const spec = FINGERS[0];
    const m = spec.bones[0];
    const r = reachThumb(THUMB_CURL_REST);
    const a = spec.neutral * RAD;
    const b = a + THUMB_BEND * RAD;
    return [spec.base[0] + m * Math.sin(a) + r * Math.sin(b), spec.base[1] + m * Math.cos(a) + r * Math.cos(b)];
  })();

  // Where the palm sits with nothing pulling on it: knuckles a relaxed middle finger behind a white-key tip.
  const yNat = tf.whiteTipY + REST_REACH[3] * k;
  let xNat = 0;
  for (let f = 2; f <= 5; f++) xNat += targets[f].x - dir * FINGERS[f - 1].base[0] * k;
  xNat /= 4;

  // The passage's knuckle height (see below) bounds how near and how far each finger
  // can reach: the palm solve keeps every engaged finger inside those bounds.
  const hPass = H0 + 10 * st.octave - 4 * st.arpeggio + st.leapLift;
  const rollMaxLM = ROLL_DROP + OCTAVE_ROLL_DROP * st.octave;
  const reachLM = [0, 1, 2, 3, 4, 5].map((f) => {
    if (f < 2) return [0, 0];
    const zk = BLACK_Z * pose.fingers[f].depth;
    const near = REACH_MIN[f];
    const far = reachRange(f, Math.max(0, H_MIN + KNUCKLE_DZ[f] - (f === 5 ? rollMaxLM : 0) - zk))[1];
    return [near, far];
  });
  const residuals = (p: { x: number; y: number; rot: number }): number[] => {
    const { toLocal } = frame(p, k, dir);
    const r: number[] = [];
    for (let f = 1; f <= 5; f++) {
      const spec = FINGERS[f - 1];
      const e = engage[f];
      // Every finger pulls a little (keeps the glide feel); engaged ones much more.
      const soft = 0.12 + 0.88 * e;
      const hard = 0.4 + 5 * e;
      const [ta, tv] = toLocal(effTarget(f));
      const da = ta - spec.base[0];
      const dv = tv - spec.base[1];
      const d = Math.hypot(da, dv);
      const ang = angleOf(da, dv);
      if (f === 1) {
        const D = d;
        const Dmax = spec.bones[0] + REACH_MAX[1];
        // A spring toward where a relaxed thumb's tip sits on the palm (convex: one minimum).
        r.push((soft * 0.5 * (ta - thumbRest[0])) / 10, (soft * 0.5 * (tv - thumbRest[1])) / 10);
        r.push(hard * hinge(D - 0.97 * Dmax) / 4);
        r.push(hard * hinge(ang - spec.splay[1] + 4) / 8);
        r.push(hard * hinge(spec.splay[0] + 4 - ang) / 8);
        continue;
      }
      // A spring toward the finger's relaxed tip position (the dome).
      // On a black key the finger is flatter (Taubman; Chang): the palm sits a little further back.
      const pref = REST_REACH[f] * (1 + 0.25 * pose.fingers[f].black);
      const n = spec.neutral * RAD;
      r.push((soft * (ta - (spec.base[0] + pref * Math.sin(n)))) / 10);
      r.push((soft * (tv - (spec.base[1] + pref * Math.cos(n)))) / 10);
      r.push((hard * hinge(d - 0.97 * reachLM[f][1])) / 4);
      r.push((hard * hinge(reachLM[f][0] + 2 - d)) / 4);
      const psi = ang - spec.neutral;
      // Splay narrows as the knuckles flex; at rest it is ~80% of the flat-hand range.
      r.push((hard * hinge(psi - 0.85 * spec.splay[1] + 2)) / 6);
      r.push((hard * hinge(0.85 * spec.splay[0] + 2 - psi)) / 6);
    }
    r.push((p.rot - rotBias) * 4);
    r.push(hinge(Math.abs(p.rot) - MAX_TILT) * 300);
    r.push((p.y - yNat) / (k * 60));
    return r;
  };

  // Levenberg–Marquardt from a fixed, deterministic start: a pure function of the pose.
  // The springs are quadratic, so there is one minimum and neighbouring frames agree.
  const lm = (start: { x: number; y: number; rot: number }) => {
    let p = start;
    let rv = residuals(p);
    let c = rv.reduce((s, x) => s + x * x, 0);
    let lambda = 1e-2;
    const eps = [0.05 * k, 0.05 * k, 1e-4];
    for (let it = 0; it < 80; it++) {
      const J: number[][] = [];
      for (let j = 0; j < 3; j++) {
        const q = { ...p };
        if (j === 0) q.x += eps[0];
        else if (j === 1) q.y += eps[1];
        else q.rot += eps[2];
        const r2 = residuals(q);
        J.push(r2.map((x, i) => (x - rv[i]) / eps[j]));
      }
      const A = [0, 1, 2].map((a) => [0, 1, 2].map((b) => J[a].reduce((s, x, i) => s + x * J[b][i], 0)));
      const g = [0, 1, 2].map((a) => J[a].reduce((s, x, i) => s + x * rv[i], 0));
      let improved = false;
      for (let tries = 0; tries < 12; tries++) {
        const Al = A.map((row, i) => row.map((x, j) => (i === j ? x * (1 + lambda) + 1e-9 : x)));
        const step = solve3(Al, g.map((x) => -x));
        const q = { x: p.x + step[0], y: p.y + step[1], rot: p.rot + step[2] };
        const rq = residuals(q);
        const cq = rq.reduce((s, x) => s + x * x, 0);
        if (cq < c) {
          p = q;
          rv = rq;
          const done = c - cq < 1e-12;
          c = cq;
          lambda = Math.max(1e-6, lambda * 0.3);
          improved = !done;
          break;
        }
        lambda *= 8;
      }
      if (!improved) break;
    }
    return p;
  };
  const best = lm({ x: xNat, y: yNat, rot: 0 });
  // Never tilt past the limit, whatever the springs want.
  const rot = Math.max(-MAX_TILT, Math.min(MAX_TILT, best.rot));
  const { toWorld, toLocal } = frame({ x: best.x, y: best.y, rot }, k, dir);

  // Knuckle height and pitch: the dome, higher and knuckles-up for octaves, a
  // little lower and flatter for arpeggios, up in a leap's arc; then lowered only
  // as far as a far-reaching finger needs (the hand flattens to reach, it never
  // stretches a bone). The little finger first gets its extra reach from the
  // forearm rolling toward it (its knuckle drops, up to ROLL_DROP mm).
  const psi = -5 * st.octave;
  let h = hPass;
  const zKey = (f: number) => BLACK_Z * pose.fingers[f].depth;
  const local = [0, 1, 2, 3, 4, 5].map((f) => (f ? toLocal(effTarget(f)) : ([0, 0] as [number, number])));
  // Lower the knuckles only as far as a stretched finger needs (the hand flattens to
  // reach, it never stretches a bone), weighted by how engaged that finger is so the
  // height glides. The little finger first gets its reach from the forearm rolling
  // toward it (its knuckle drops, up to rollMax).
  const rollMax = ROLL_DROP + OCTAVE_ROLL_DROP * st.octave;
  const need = [0, 0, 0, 0, 0, 0];
  for (let f = 2; f <= 5; f++) {
    if (engage[f] <= 0) continue;
    const d = Math.hypot(local[f][0] - FINGERS[f - 1].base[0], local[f][1] - FINGERS[f - 1].base[1]);
    need[f] = Math.max(0, h + KNUCKLE_DZ[f] - zKey(f) - maxDrop(f, d + 1));
  }
  const pinkyRoll = Math.min(rollMax, need[5]) * engage[5];
  need[5] = Math.max(0, need[5] - rollMax);
  let lower = 0;
  for (let f = 2; f <= 5; f++) lower = Math.max(lower, engage[f] * engage[f] * need[f]);
  h = Math.max(H_MIN, h - lower);
  const knuckleDz = KNUCKLE_DZ.map((z, f) => z - (f === 5 ? pinkyRoll : f === 4 ? 0.3 * pinkyRoll : 0));
  // ...which shows as forearm rotation: the little-finger side rolls down (screen side by hand).
  const rollDeg = st.roll + dir * Math.asin(Math.min(1, pinkyRoll / 56)) / RAD;

  const fingers: FingerSolve[] = [];
  fingers.push({ joints: [], z: [], joints3: [], mcp: 0, pip: 0, dip: 0, phi: [], curl: 0, splay: 0, target: { x: 0, y: 0 }, miss: 0, press: 0, engage: 0, black: 0 });
  // The MCP move each finger makes for its keystroke/lift, 20 ms ago: idle neighbours follow a little.
  const act = pose.fingers.map((fp) => PRESS_MCP * fp.pressLag + LIFT_MCP * fp.liftLag * 0.8);
  const t = pose.t;
  for (let f = 1; f <= 5; f++) {
    const spec = FINGERS[f - 1];
    const fp = pose.fingers[f];
    const e = engage[f];
    const tgt = effTarget(f);
    let [ta, tv] = local[f];
    if (f === 1) {
      // The thumb: a 2-link chain from the CMC (as before), lying on its side.
      if (e < 1) {
        const w = Math.max(e, 0.25);
        ta = thumbRest[0] + (ta - thumbRest[0]) * w;
        tv = thumbRest[1] + (tv - thumbRest[1]) * w;
      }
      const th = thumbIK(ta, tv);
      const c = Math.max(th.curl, 0.12 * (1 - e)); // a relaxed thumb is never dead straight
      const a1 = THUMB_FLEX[0] * c;
      const a2 = THUMB_FLEX[1] * c;
      const proj = [FINGERS[0].bones[1] * Math.cos(a1 * RAD), FINGERS[0].bones[2] * Math.cos((a1 + a2) * RAD)];
      const pa = th.tip[0] - th.mcp[0];
      const pv = th.tip[1] - th.mcp[1];
      const pl = Math.hypot(pa, pv) || 1;
      const ip: [number, number] = [th.mcp[0] + (pa / pl) * proj[0], th.mcp[1] + (pv / pl) * proj[0]];
      const tip: [number, number] = [ip[0] + (pa / pl) * proj[1], ip[1] + (pv / pl) * proj[1]];
      const zTip = (e > 0.5 ? zKey(1) : HOVER) - KEY_DIP * fp.press;
      const zIp = zTip + FINGERS[0].bones[2] * Math.sin((a1 + a2) * RAD);
      const zMcp = zIp + FINGERS[0].bones[1] * Math.sin(a1 * RAD);
      const joints = [toWorld(spec.base[0], spec.base[1]), toWorld(th.mcp[0], th.mcp[1]), toWorld(ip[0], ip[1]), toWorld(tip[0], tip[1])];
      const tipW = joints[3];
      fingers.push({
        joints,
        z: [zMcp, zMcp, zIp, zTip],
        joints3: [[spec.base[0], spec.base[1], zMcp], [th.mcp[0], th.mcp[1], zMcp], [ip[0], ip[1], zIp], [tip[0], tip[1], zTip]],
        mcp: a1,
        pip: a2,
        dip: 0,
        phi: [0, a1 * RAD, (a1 + a2) * RAD],
        curl: c,
        splay: th.swing,
        target: tgt,
        miss: e >= 1 ? Math.hypot(tipW.x - tgt.x, tipW.y - tgt.y) : 0,
        press: fp.press,
        engage: e,
        black: fp.black,
      });
      continue;
    }
    const kz = h + knuckleDz[f];
    // Engaged: IK onto the key (white key top, or the black key's top).
    const dEng = Math.hypot(ta - spec.base[0], tv - spec.base[1]);
    const splayEng = angleOf(ta - spec.base[0], tv - spec.base[1]) - spec.neutral;
    let [m, p] = e > 0 ? ikFinger(f, dEng, kz - zKey(f), psi, 1, 0.3) : [0, 0];
    if (e > 0 && Math.abs(fk(f, m, p, psi).h - dEng) > 1.5) {
      // Cramped (the hand is low for a stretch elsewhere): curl the fingertip under a little more.
      // Seen from above the key position matters, the fingertip's depth hardly does.
      [m, p] = ikFinger(f, dEng, kz - zKey(f), psi, 1, 0.05, 0, TIP_CURL_MAX);
    }
    // Idle: the dome, a hair above the keys, leaning a little toward where the glide puts it.
    // This finger's (staggered) view of the hand shape.
    const ls = pose.lagStyle?.[f] ?? st;
    // Idle: the dome (chords: curled and a little lifted; arpeggios: open and flatter),
    // kept as a shape while the hand rises, lowers or arcs around it. Only if the
    // fingertip would leave its hover band does the MCP give, to keep it just above the key.
    let mi = REST[f][0] - 4 * ls.chord - 4 * ls.arpeggio;
    let pi = REST[f][1] + 8 * ls.chord - 5 * ls.arpeggio;
    const zBand: [number, number] = [0.5, HOVER + 2 + 4 * ls.chord];
    const tipAt = (mm: number) => kz - st.leapLift - fk(f, mm, pi, psi).v;
    if (tipAt(mi) > zBand[1] || tipAt(mi) < zBand[0]) {
      const goal = tipAt(mi) > zBand[1] ? zBand[1] : zBand[0];
      let lo = LIM.mcp[0];
      let hi = 50;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        if (tipAt(mid) > goal) lo = mid;
        else hi = mid;
      }
      mi = (lo + hi) / 2;
      // Knuckles very low: straighten the middle joint too.
      if (tipAt(mi) < zBand[0]) {
        const tipP = (pp: number) => kz - st.leapLift - fk(f, mi, pp, psi).v;
        let a = f === 5 ? PIP_MIN_LITTLE : LIM.pip[0];
        let b = pi;
        for (let i = 0; i < 18; i++) {
          const mid = (a + b) / 2;
          if (tipP(mid) >= zBand[0]) a = mid;
          else b = mid;
        }
        pi = a;
      }
    }
    if (f < 5 && ls.octave > 0) {
      // Octaves: 2-4 curl up out of the way, close together, tips well above the keys.
      const [mo, po] = ikFinger(f, OCTAVE_REACH * REST_REACH[f], kz - OCTAVE_TIP_Z, psi, 0.3, 1, OCTAVE_PIP_MIN, 100);
      mi = lerp(mi, mo, ls.octave);
      pi = lerp(pi, po, ls.octave);
    }
    const lean = 0.25;
    let splayIdle = (angleOf(ta - spec.base[0], tv - spec.base[1]) - spec.neutral) * lean;
    if (ls.arpeggio > 0) {
      // Arpeggios: an open, fanned hand.
      const fan = f === 2 ? spec.splay[0] : f === 3 ? 0 : spec.splay[1];
      splayIdle = lerp(splayIdle, 0.85 * fan * 0.8, ls.arpeggio);
    }
    if (ls.octave > 0 && f < 5) splayIdle = lerp(splayIdle, 0, ls.octave);
    if (e > 0) {
      mi = lerp(mi, m, e);
      pi = lerp(pi, p, e);
    }
    m = mi;
    p = pi;
    let splay = lerp(splayIdle, splayEng, e);
    // Keystroke (MCP-led), preparation lift, idle drift and neighbour coupling, on top.
    let dip = DIP_RATIO * p;
    m += PRESS_MCP * fp.press + LIFT_MCP * fp.lift;
    p += PRESS_PIP * fp.press;
    dip += PRESS_DIP_RATIO * p * fp.press;
    const idle = 1 - e;
    if (idle > 0) {
      const hsh = hash01(pose.hand, f);
      const fq = 0.3 + 0.4 * hsh;
      m += idle * MICRO_MCP * Math.sin(2 * Math.PI * fq * t + 6.283 * hsh);
      for (const g of [f - 1, f + 1]) {
        const c = COUPLE[`${g}-${f}`];
        if (c) m += idle * c * act[g];
      }
    }
    // Hard limits: no hyperextension anywhere, pinky never flat, tip never folds back.
    m = Math.max(LIM.mcp[0], Math.min(LIM.mcp[1], m));
    p = Math.max(f === 5 ? PIP_MIN_LITTLE : LIM.pip[0], Math.min(LIM.pip[1], p));
    dip = Math.max(LIM.dip[0], Math.min(LIM.dip[1], dip));
    const lim = splayLimitEff(f, m);
    splay = Math.max(lim[0], Math.min(lim[1], splay));
    // An idle fingertip never sinks into the keys: lift it from the knuckle if it would.
    if (idle > 0 && !fp.press) {
      const zTip = kz - fk(f, m, p, psi, dip).v;
      if (zTip < 0) {
        let lo = LIM.mcp[0];
        let hi = m;
        for (let i = 0; i < 16; i++) {
          const mid = (lo + hi) / 2;
          if (kz - fk(f, mid, p, psi, dip).v >= 0.2) lo = mid;
          else hi = mid;
        }
        m = lo;
      }
    }
    const ang = (spec.neutral + splay) * RAD;
    const ua = Math.sin(ang);
    const uv = Math.cos(ang);
    const { phi } = fk(f, m, p, psi, dip);
    let a = spec.base[0];
    let v = spec.base[1];
    let z = kz;
    const joints = [toWorld(a, v)];
    const zs = [z];
    const j3: [number, number, number][] = [[a, v, z]];
    spec.bones.forEach((L, i) => {
      const hz = L * Math.cos(phi[i]);
      a += ua * hz;
      v += uv * hz;
      z -= L * Math.sin(phi[i]);
      joints.push(toWorld(a, v));
      zs.push(z);
      j3.push([a, v, z]);
    });
    const tipW = joints[3];
    fingers.push({
      joints,
      z: zs,
      joints3: j3,
      mcp: m,
      pip: p,
      dip,
      phi,
      curl: 0,
      splay,
      target: tgt,
      miss: e >= 1 ? Math.hypot(tipW.x - tgt.x, tipW.y - tgt.y) : 0,
      press: fp.press,
      engage: e,
      black: fp.black,
    });
  }
  return {
    hand: pose.hand,
    palm: { x: best.x, y: best.y, rot, h, psi, roll: rollDeg },
    forearm: rot * FOREARM_GAIN,
    k,
    dir,
    fingers,
    toWorld,
    toLocal,
  };
}
