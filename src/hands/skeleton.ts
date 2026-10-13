import type { HandPose } from './handPose';
import type { PlayHand } from './fingering';

/**
 * A kinematic hand seen from above: a rigid palm (position + a small rotation),
 * fingers as chains of fixed-length bones from their knuckles, and a thumb with
 * its own base joint (CMC) low on the palm. Fingertip targets come from the
 * HandPose (the fingering engine + eased glides); this solves where the palm
 * must be so every engaged finger can reach its key without breaking anatomy,
 * then curls/splays each finger onto its target.
 *
 * Seen from above a finger can only get SHORTER (flexion foreshortens it); no
 * bone ever changes length. Everything is a pure function of the HandPose, so
 * scrub and seek keep working.
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
  /** Splay limits around neutral, degrees (thumb: limits of its swing from forward). */
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

/** Joint flexion per unit of curl, degrees: MCP, PIP, DIP (DIP follows PIP, as real fingers do). */
export const FLEX = [50, 85, 40];
/** Thumb phalanges: MCP, IP. */
export const THUMB_FLEX = [35, 55];
export const CURL_MAX = 0.6;
const CURL_REST = 0.22;
const CURL_PRESS = 0.08;
/** Preferred angle between the thumb's metacarpal and its phalanges, degrees (+ toward the palm). */
const THUMB_BEND = 12;
const THUMB_BEND_LIM: [number, number] = [-15, 55];
const MAX_TILT = 0.35; // palm rotation limit, radians (~20°)

const RAD = Math.PI / 180;

/** Projected (top-down) length of each bone at curl c. */
export function boneProjections(f: number, c: number): number[] {
  const spec = FINGERS[f - 1];
  if (f === 1) {
    const [, p, d] = spec.bones;
    const a1 = THUMB_FLEX[0] * c * RAD;
    const a2 = a1 + THUMB_FLEX[1] * c * RAD;
    return [p * Math.cos(a1), d * Math.cos(a2)];
  }
  // A fingertip at most points straight down at the key, never back under the hand.
  let phi = 0;
  return spec.bones.map((L, i) => {
    phi = Math.min(Math.PI / 2, phi + FLEX[i] * c * RAD);
    return L * Math.cos(phi);
  });
}

/** Top-down reach of a finger (thumb: its phalanges) at curl c, mm. Monotone falling on [0, CURL_MAX]. */
export function reach(f: number, c: number): number {
  return boneProjections(f, c).reduce((s, x) => s + x, 0);
}

/** The curl that gives a reach of d (clamped to what anatomy allows). */
export function curlFor(f: number, d: number): number {
  if (d >= reach(f, 0)) return 0;
  if (d <= reach(f, CURL_MAX)) return CURL_MAX;
  let lo = 0;
  let hi = CURL_MAX;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (reach(f, m) > d) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

const REACH_MAX = [0, 1, 2, 3, 4, 5].map((f) => (f ? reach(f, 0) : 0));
const REACH_MIN = [0, 1, 2, 3, 4, 5].map((f) => (f ? reach(f, CURL_MAX) : 0));
/** Tip of a relaxed thumb in the hand frame, mm. */
const THUMB_REST: [number, number] = (() => {
  const spec = FINGERS[0];
  const m = spec.bones[0];
  const r = reach(1, CURL_REST);
  const a = spec.neutral * RAD;
  const b = a + THUMB_BEND * RAD;
  return [spec.base[0] + m * Math.sin(a) + r * Math.sin(b), spec.base[1] + m * Math.cos(a) + r * Math.cos(b)];
})();

export interface Pt {
  x: number;
  y: number;
}

export interface PalmPose {
  x: number; // knuckle-line centre, canvas px
  y: number;
  rot: number; // radians, + = fingers lean toward the little finger
}

export interface FingerSolve {
  /** Joints from the knuckle (thumb: CMC, MCP, IP) to the tip, canvas px. */
  joints: Pt[];
  curl: number;
  /** Splay from neutral, degrees (thumb: swing of the whole thumb from forward). */
  splay: number;
  /** Where the fingertip was asked to be. */
  target: Pt;
  /** Distance from the solved tip to the target, px (0 = on it). */
  miss: number;
  press: number;
  engage: number;
}

export interface Skeleton {
  hand: PlayHand;
  palm: PalmPose;
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

function frame(p: PalmPose, k: number, dir: number) {
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

/** The fingertip's target in canvas px: on its key, or relaxed for an idle finger. */
function tipTarget(pose: HandPose, f: number, tf: TipFrame): Pt {
  const fp = pose.fingers[f];
  let y = tf.whiteTipY + (tf.blackTipY - tf.whiteTipY) * fp.depth;
  if (f === 1) y += (tf.thumbTipY - tf.whiteTipY) * (1 - fp.depth); // the thumb is shorter
  y += 0.12 * tf.unit * fp.press; // the pad flattens onto the key
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
  return { mcp, curl: curlFor(1, r), tip, swing };
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
 * fingertip targets with hard-ish anatomy limits as steep penalties), then
 * each finger by 2D IK (splay + curl) with its bones held at full length.
 */
export function solveSkeleton(pose: HandPose, tf: TipFrame): Skeleton {
  const dir = pose.hand === 'right' ? 1 : -1;
  const k = (tf.unit * HAND_SCALE) / KEY_MM;
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
  const effTarget = (f: number): Pt => {
    const t = targets[f];
    if (f === 1 || pose.fingers[f].depth > 0) return t;
    const deep = Math.max(tf.deepY, tf.blackTipY + 0.2 * tf.unit);
    return { x: t.x, y: t.y + (deep - tf.whiteTipY) * fwd };
  };

  const press = pose.fingers.map((fp) => fp.press);

  // Where the palm sits with nothing pulling on it: knuckles a relaxed middle finger behind a white-key tip.
  const yNat = tf.whiteTipY + reach(3, CURL_REST) * k;
  let xNat = 0;
  for (let f = 2; f <= 5; f++) xNat += targets[f].x - dir * FINGERS[f - 1].base[0] * k;
  xNat /= 4;

  const residuals = (p: PalmPose): number[] => {
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
        r.push((soft * 0.5 * (ta - THUMB_REST[0])) / 10, (soft * 0.5 * (tv - THUMB_REST[1])) / 10);
        r.push(hard * hinge(D - 0.97 * Dmax) / 4);
        r.push(hard * hinge(ang - spec.splay[1] + 4) / 8);
        r.push(hard * hinge(spec.splay[0] + 4 - ang) / 8);
        continue;
      }
      // A spring toward the finger's relaxed tip position (pressing: a little more curled).
      const pref = reach(f, CURL_REST + CURL_PRESS * press[f]);
      const n = spec.neutral * RAD;
      r.push((soft * (ta - (spec.base[0] + pref * Math.sin(n)))) / 10);
      r.push((soft * (tv - (spec.base[1] + pref * Math.cos(n)))) / 10);
      r.push((hard * hinge(d - 0.97 * REACH_MAX[f])) / 4);
      r.push((hard * hinge(1.05 * REACH_MIN[f] - d)) / 4);
      const psi = ang - spec.neutral;
      r.push((hard * hinge(psi - spec.splay[1] + 2)) / 6);
      r.push((hard * hinge(spec.splay[0] + 2 - psi)) / 6);
    }
    r.push(p.rot * 4);
    r.push(hinge(Math.abs(p.rot) - MAX_TILT) * 300);
    r.push((p.y - yNat) / (k * 60));
    return r;
  };

  // Levenberg–Marquardt from a fixed, deterministic start: a pure function of the pose.
  // The springs are quadratic, so there is one minimum and neighbouring frames agree.
  const lm = (start: PalmPose): { p: PalmPose; c: number } => {
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
    return { p, c };
  };
  const best = lm({ x: xNat, y: yNat, rot: 0 });
  // Never tilt past the limit, whatever the springs want.
  const p = { ...best.p, rot: Math.max(-MAX_TILT, Math.min(MAX_TILT, best.p.rot)) };

  // Per finger IK with the palm fixed.
  const { toWorld, toLocal } = frame(p, k, dir);
  const fingers: FingerSolve[] = [];
  fingers.push({ joints: [], curl: 0, splay: 0, target: { x: 0, y: 0 }, miss: 0, press: 0, engage: 0 });
  for (let f = 1; f <= 5; f++) {
    const spec = FINGERS[f - 1];
    const e = engage[f];
    // Idle fingers relax into a gently curled rest pose; engaged ones go to their keys.
    const tgt = effTarget(f);
    let [ta, tv] = toLocal(tgt);
    if (e < 1) {
      let ra: number;
      let rv2: number;
      if (f === 1) {
        const ang = spec.neutral * RAD;
        const r = reach(1, CURL_REST);
        const m = spec.bones[0];
        ra = spec.base[0] + m * Math.sin(ang) + r * Math.sin(ang + THUMB_BEND * RAD);
        rv2 = spec.base[1] + m * Math.cos(ang) + r * Math.cos(ang + THUMB_BEND * RAD);
      } else {
        const ang = spec.neutral * RAD;
        const r = reach(f, CURL_REST + 0.03);
        ra = spec.base[0] + r * Math.sin(ang);
        rv2 = spec.base[1] + r * Math.cos(ang);
      }
      // Free fingers still lean a little toward where the glide puts them.
      const w = Math.max(e, 0.25);
      ta = ra + (ta - ra) * w;
      tv = rv2 + (tv - rv2) * w;
    }
    let joints: Pt[];
    let curl: number;
    let splay: number;
    let tipLocal: [number, number];
    if (f === 1) {
      const t = thumbIK(ta, tv);
      const proj = boneProjections(1, t.curl);
      const pa = t.tip[0] - t.mcp[0];
      const pv = t.tip[1] - t.mcp[1];
      const pl = Math.hypot(pa, pv) || 1;
      const ip: [number, number] = [t.mcp[0] + (pa / pl) * proj[0], t.mcp[1] + (pv / pl) * proj[0]];
      joints = [toWorld(spec.base[0], spec.base[1]), toWorld(t.mcp[0], t.mcp[1]), toWorld(ip[0], ip[1]), toWorld(t.tip[0], t.tip[1])];
      curl = t.curl;
      splay = t.swing;
      tipLocal = t.tip;
    } else {
      const da = ta - spec.base[0];
      const dv = tv - spec.base[1];
      const d = Math.hypot(da, dv);
      splay = Math.min(spec.splay[1], Math.max(spec.splay[0], angleOf(da, dv) - spec.neutral));
      curl = curlFor(f, d);
      const ang = (spec.neutral + splay) * RAD;
      const ua = Math.sin(ang);
      const uv = Math.cos(ang);
      const proj = boneProjections(f, curl);
      let a = spec.base[0];
      let v = spec.base[1];
      joints = [toWorld(a, v)];
      for (const L of proj) {
        a += ua * L;
        v += uv * L;
        joints.push(toWorld(a, v));
      }
      tipLocal = [a, v];
    }
    const tipW = toWorld(tipLocal[0], tipLocal[1]);
    fingers.push({
      joints,
      curl,
      splay,
      target: tgt,
      miss: e >= 1 ? Math.hypot(tipW.x - tgt.x, tipW.y - tgt.y) : 0,
      press: press[f],
      engage: e,
    });
  }
  return { hand: pose.hand, palm: p, k, dir, fingers, toWorld, toLocal };
}
