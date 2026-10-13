import type { HandAnimator, HandPose } from './handPose';
import type { PlayHand } from './fingering';
import { FINGERS, FOREARM_GAIN, solveSkeleton, type Pt, type Skeleton, type TipFrame } from './skeleton';

/**
 * Hands seen from straight above: one smooth, slightly translucent skin-tone
 * shape per hand (palm, wrist stub, five tapered fingers) with a thin soft edge
 * so it reads over the notes and over the other hand. The outline is rebuilt
 * every frame from the 3D kinematic skeleton (skeleton.ts), so it bends the way
 * a hand does and stays a pure function of song time.
 *
 * A bent finger seen from above only gets shorter, so the bends are carried by
 * light, not lines: each bone is shaded by its slope (a fingertip pointing down
 * at the key is darker), knuckles get a soft highlight and a little width as
 * they flex, a flexion crease darkens just past each bent joint, a fingertip
 * seen end-on narrows, and a soft contact shadow on the keys separates as a
 * finger or the hand lifts. The press glow keeps each hand's colour, matching
 * its falling bars.
 */

export interface HandGeometry {
  /** White-key units (keyU) → canvas x. */
  uToX: (u: number) => number;
  whiteW: number;
  /**
   * Smallest size unit for the hand itself (px per white key). On a wide zoom the
   * keys get narrow; fingertips still land on key centres, but the hand doesn't
   * shrink below this.
   */
  minUnit?: number;
  strikeY: number;
  kbH: number;
  blackH: number;
  /** Device pixels per canvas unit (the live player draws in CSS px at dpr). */
  pixelRatio?: number;
  /** Nothing of the hands is drawn below this y (the live player's control bar); the wrist fades out above it. */
  floorY?: number;
}

/** Skin, like his reference picture; the press glow keeps the hand's bar colour. */
const SKIN = { fill: '#dcae8c', edge: '#8a5a3f', shade: '92,50,30', light: '255,238,222' };
const GLOW: Record<PlayHand, string> = { right: '#f2b85e', left: '#7cc4d8' };

const HAND_ALPHA = 0.8;
/** Wrist stub below the palm, mm (fades out). */
const FOREARM = 46;
/** How long the wrist trails the palm, seconds. */
const WRIST_LAG = 0.07;
/** When the hand shifts to a new position the arm leads by this much, seconds. */
const WRIST_LEAD = 0.04;

let scratch: HTMLCanvasElement | OffscreenCanvas | null = null;
function scratchCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (!scratch) {
    scratch =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
  }
  if (scratch.width < w) scratch.width = w;
  if (scratch.height < h) scratch.height = h;
  return scratch;
}

/** The hand's size unit: the white-key width, but never below the geometry's minimum. */
export function handUnit(g: HandGeometry): number {
  return Math.max(g.whiteW, g.minUnit ?? 0);
}

/** Where fingertips land on the keys (canvas px), for this keyboard. */
export function tipFrame(g: HandGeometry): TipFrame {
  const w = handUnit(g);
  const blackTipY = Math.max(g.strikeY + g.blackH * 0.35, g.strikeY + g.blackH - 0.75 * w);
  const kY = Math.min(g.strikeY + g.kbH + 0.9 * w, blackTipY + 3.6 * w);
  // White keys are played just in front of the black keys, as pianists do.
  const whiteTipY = Math.min(
    g.strikeY + g.kbH * 0.92,
    Math.max(g.strikeY + g.blackH + 0.4 * w, Math.min(kY - 2.5 * w, g.strikeY + g.kbH - 0.45 * w)),
  );
  const thumbTipY = Math.max(whiteTipY, Math.min(whiteTipY + 1.4 * w, g.strikeY + g.kbH - 0.3 * w));
  return { uToX: g.uToX, unit: w, whiteTipY, blackTipY, thumbTipY, deepY: g.strikeY + 0.3 * w };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A closed smooth curve through points (Catmull-Rom as cubic Béziers). */
function smoothClosed(ctx: Ctx, pts: Pt[]): void {
  const n = pts.length;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x,
      p2.y,
    );
  }
  ctx.closePath();
}

interface Shape {
  path: (ctx: Ctx) => void;
  /** The same outline as a polygon (curves sampled), canvas px: for overlap checks. */
  poly: () => Pt[];
}

/** Points along smoothClosed's curve (the same Catmull-Rom Béziers), `per` per segment. */
function sampleClosed(pts: Pt[], per = 4): Pt[] {
  const n = pts.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    for (let j = 0; j < per; j++) {
      const s = j / per;
      const r = 1 - s;
      out.push({
        x: r * r * r * p1.x + 3 * r * r * s * c1.x + 3 * r * s * s * c2.x + s * s * s * p2.x,
        y: r * r * r * p1.y + 3 * r * r * s * c1.y + 3 * r * s * s * c2.y + s * s * s * p2.y,
      });
    }
  }
  return out;
}

/** One side of a finger and its round tip, as points for a smooth closed outline. */
interface FingerOutline {
  pts: Pt[];
  /** Left/right side points at each joint (for shading bands), canvas px. */
  left: Pt[];
  right: Pt[];
  radii: number[];
}

/** Half-width of finger f at joint i, px, before joint widening. The thumb is seen on its side: narrower. */
function fingerRadius(sk: Skeleton, f: number, i: number): number {
  const spec = FINGERS[f - 1];
  const n = 3;
  const r = ((spec.width[0] + (spec.width[1] - spec.width[0]) * (i / n)) / 2) * sk.k;
  return f === 1 ? r * (i === 0 ? 1.5 : i === 1 ? 1.0 : 0.8) : r;
}

/**
 * The outline of one finger: tapered sides with a little extra width at each
 * joint (PIP +6%, DIP +3%, the outer MCP head of the index and little finger
 * +8%, all growing as the joint bends), a round tip that narrows when it is
 * seen end-on, and a round base.
 */
function fingerShape(sk: Skeleton, f: number, from = 0): FingerOutline {
  const fs = sk.fingers[f];
  const js = fs.joints.slice(from);
  const n = js.length - 1;
  const radii = js.map((_, i) => fingerRadius(sk, f, i + from));
  // Fingertip seen end-on (distal bone steeper than 55°): narrower and rounder.
  const tipSteep = f > 1 ? Math.max(0, Math.min(1, ((fs.phi[2] ?? 0) - 55 * (Math.PI / 180)) / (15 * (Math.PI / 180)))) : 0;
  radii[n] *= 1 - 0.12 * tipSteep;
  if (n > 0 && Math.hypot(js[n].x - js[n - 1].x, js[n].y - js[n - 1].y) < radii[n - 1]) radii[n] = Math.max(radii[n], 0.92 * radii[n - 1]);
  const bend = (i: number) => (i === 1 ? Math.sin(Math.max(0, fs.mcp) * (Math.PI / 180)) : i === 2 ? Math.sin(Math.max(0, fs.pip) * (Math.PI / 180)) : 0);
  const widen = [0, 0.06 * (0.5 + bend(2)), 0.03 * (0.5 + bend(2)), 0];
  const left: Pt[] = [];
  const right: Pt[] = [];
  const pts: Pt[] = [];
  const sideL: Pt[] = [];
  const sideR: Pt[] = [];
  let lastDir = { x: 0, y: -1 };
  const dirAt = (i: number) => {
    const a = js[Math.max(0, i - 1)];
    const b = js[Math.min(n, i + 1)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return lastDir;
    dx /= len;
    dy /= len;
    lastDir = { x: dx, y: dy };
    return lastDir;
  };
  // The outer MCP head (index: thumb side, little: the far side) lies on the hand's outline.
  const outerSide = f === 2 ? -1 : f === 5 ? 1 : 0; // -1 = left of the finger (thumb side for the RH)
  const mcpBulge = 0.08 * (0.4 + 0.6 * bend(1));
  for (let i = 0; i <= n; i++) {
    const d = dirAt(i);
    const r = radii[i] * (1 + (widen[i] ?? 0));
    let rl = r;
    let rr = r;
    if (i === 0 && outerSide) {
      // Mirrored hands: "thumb side" is screen-left for the right hand, screen-right for the left.
      const leftIsOuter = (outerSide < 0) === (sk.dir > 0);
      if (leftIsOuter) rl *= 1 + mcpBulge;
      else rr *= 1 + mcpBulge;
    }
    left.push({ x: js[i].x + d.y * rl, y: js[i].y - d.x * rl });
    right.push({ x: js[i].x - d.y * rr, y: js[i].y + d.x * rr });
    // A fingertip seen end-on: the last joint and the tip nearly coincide, so the round
    // cap takes over from the joint (no shoulder, no squared-off end).
    const endOn = i === n - 1 && Math.hypot(js[n].x - js[i].x, js[n].y - js[i].y) < radii[i];
    if (!endOn) {
      sideL.push(left[i]);
      sideR.push(right[i]);
    }
    const segLen = i < n ? Math.hypot(js[i + 1].x - js[i].x, js[i + 1].y - js[i].y) : 0;
    if (i < n && segLen > 1.2 * radii[i]) {
      // Extra stations 25% and 75% along the bone at the plain radius, so the joint
      // widening stays a local swelling instead of a straight taper (only where the
      // bone shows long enough from above to have a middle).
      const dn = dirAt(i + 1);
      for (const s of [0.25, 0.75]) {
        const c = lerpPt(js[i], js[i + 1], s);
        const rs = radii[i] + (radii[i + 1] - radii[i]) * s;
        const dx = d.x + (dn.x - d.x) * s;
        const dy = d.y + (dn.y - d.y) * s;
        const dl = Math.hypot(dx, dy) || 1;
        sideL.push({ x: c.x + (dy / dl) * rs, y: c.y - (dx / dl) * rs });
        sideR.push({ x: c.x - (dy / dl) * rs, y: c.y + (dx / dl) * rs });
      }
    }
  }
  const dEnd = dirAt(n);
  const end = Math.atan2(dEnd.y, dEnd.x);
  const d0 = dirAt(0);
  const start = Math.atan2(d0.y, d0.x);
  // Drop side points that crowd each other (a bone seen end-on): they kink the curve.
  const thin = (arr: Pt[]) => {
    const out: Pt[] = [];
    for (const p of arr) if (!out.length || Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) > 0.35 * radii[n]) out.push(p);
    return out;
  };
  const sl = thin(sideL);
  const sr = thin(sideR);
  pts.push(...sl);
  for (const s of [-0.5, -0.3, -0.12, 0.12, 0.3, 0.5]) {
    const a = end + s * Math.PI * 0.999;
    pts.push({ x: js[n].x + Math.cos(a) * radii[n], y: js[n].y + Math.sin(a) * radii[n] });
  }
  for (let i = sr.length - 1; i >= 0; i--) pts.push(sr[i]);
  for (const s of [0.75, 1, 1.25]) {
    const a = start + s * Math.PI;
    pts.push({ x: js[0].x + Math.cos(a) * radii[0], y: js[0].y + Math.sin(a) * radii[0] });
  }
  return { pts, left, right, radii };
}

/** The thumb from its MCP joint to the tip (what shows through the palm when it tucks under). */
function thumbPhalanges(sk: Skeleton): FingerOutline {
  return fingerShape(sk, 1, 1);
}

/** All the pieces of one hand's silhouette, in canvas px. Unioned when painted. */
function handShapes(sk: Skeleton, outlines: FingerOutline[], wristShift: Pt, wristRot: number, shift: Pt = { x: 0, y: 0 }, palmOnly = false): Shape[] {
  const { toWorld } = sk;
  const shapes: Shape[] = [];
  const W = (a: number, v: number) => {
    const p = toWorld(a, v);
    return { x: p.x + shift.x, y: p.y + shift.y };
  };
  const sh = (p: Pt) => ({ x: p.x + shift.x, y: p.y + shift.y });
  // Forearm rotation shows as a slightly narrower palm.
  const narrow = Math.cos((sk.palm.roll * Math.PI) / 180);
  const P = (a: number, v: number) => W(a * narrow, v);

  // Palm + wrist stub. The wrist end trails (or leads) the palm and turns less.
  const palmPts: Pt[] = [
    P(-36, -6), P(-33, 3), P(-19, 7), P(-9, 9), P(10, 6), P(25, 0), P(34, -9),
    P(36, -30), P(32, -58), P(26, -84),
  ];
  const wristAt = (a: number, v: number): Pt => {
    const p = W(a, v);
    // Rotate the stub about the wrist centre by wristRot (the palm turns, the forearm less so).
    const c = W(0, -88);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const cs = Math.cos(wristRot);
    const sn = Math.sin(wristRot);
    return { x: c.x + dx * cs - dy * sn + wristShift.x, y: c.y + dx * sn + dy * cs + wristShift.y };
  };
  palmPts.push(wristAt(24, -88 - FOREARM), wristAt(-22, -88 - FOREARM));
  palmPts.push(P(-24, -84), P(-31, -64), P(-37, -34));
  shapes.push({ path: (ctx) => smoothClosed(ctx, palmPts), poly: () => sampleClosed(palmPts) });
  if (palmOnly) return shapes;

  // Webs between the long fingers, so they grow out of the palm instead of being stuck on.
  for (let f = 2; f <= 4; f++) {
    const a = sk.fingers[f].joints;
    const b = sk.fingers[f + 1].joints;
    const a0 = sh(a[0]);
    const b0 = sh(b[0]);
    const pa = sh(lerpPt(a[0], a[1], 0.2));
    const pb = sh(lerpPt(b[0], b[1], 0.2));
    shapes.push({
      path: (ctx) => {
        ctx.moveTo(a0.x, a0.y);
        ctx.lineTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.lineTo(b0.x, b0.y);
        ctx.closePath();
      },
      poly: () => [a0, pa, pb, b0],
    });
  }

  for (let f = 1; f <= 5; f++) {
    const pts = outlines[f].pts.map(sh);
    shapes.push({ path: (ctx) => smoothClosed(ctx, pts), poly: () => sampleClosed(pts) });
  }

  // The thumb web: from the thumb's first joint to the index knuckle, so the thumb
  // stays one piece with the palm whether it reaches out or tucks under.
  const th = sk.fingers[1].joints.map(sh);
  const idx = sh(sk.fingers[2].joints[0]);
  const webA = lerpPt(th[1], th[2], 0.25);
  const cmc = th[0];
  const inner = W(-22, -18);
  const w2 = W(-20, -40);
  shapes.push({
    path: (ctx) => {
      ctx.moveTo(cmc.x, cmc.y);
      ctx.lineTo(th[1].x, th[1].y);
      ctx.lineTo(webA.x, webA.y);
      ctx.quadraticCurveTo(inner.x, inner.y, idx.x, idx.y);
      ctx.lineTo(w2.x, w2.y);
      ctx.closePath();
    },
    poly: () => {
      const out = [cmc, th[1], webA];
      for (let i = 1; i < 8; i++) {
        const s = i / 8;
        const r = 1 - s;
        out.push({ x: r * r * webA.x + 2 * r * s * inner.x + s * s * idx.x, y: r * r * webA.y + 2 * r * s * inner.y + s * s * idx.y });
      }
      out.push(idx, w2);
      return out;
    },
  });
  return shapes;
}

function lerpPt(a: Pt, b: Pt, s: number): Pt {
  return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
}

/** Stroke the two sides of a finger from its base to the tip (faint lines between touching fingers). */
function fingerSides(ctx: Ctx, o: FingerOutline): void {
  for (const pts of [o.left, o.right]) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
}

const RAD = Math.PI / 180;
/** Lightness of a surface at angle phi to the keys, lit from above: 1 flat, ~0.65 pointing straight down. */
const slopeLight = (phi: number) => 0.65 + 0.35 * Math.cos(phi);

/**
 * Light and shade inside the silhouette (drawn source-atop, so it only lands on
 * the hand): slope shading per bone, knuckle highlights that appear as a joint
 * bends, flexion creases, the valleys between knuckles, the thumb's shaded side
 * and the forearm's roll. Kept subtle: lightness stays within ~0.6-1.1.
 */
function shadeHand(ctx: Ctx, sk: Skeleton, outlines: FingerOutline[]): void {
  const shade = (a: number) => `rgba(${SKIN.shade},${a.toFixed(3)})`;
  const light = (a: number) => `rgba(${SKIN.light},${a.toFixed(3)})`;
  // Slope shading: each bone darkens with its angle to the keys, blending across the joints.
  for (let f = 2; f <= 5; f++) {
    const fs = sk.fingers[f];
    const o = outlines[f];
    const js = fs.joints;
    const L = fs.phi.map(slopeLight);
    // The proximal bone is near level (lightness ~0.97): only the middle and end bones are shaded.
    for (let i = 1; i < 3; i++) {
      const a = js[i];
      const b = js[i + 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 0.3 && i < 2) continue;
      // One flat tone per bone (gradient objects are slow in software canvas); adjoining
      // bones differ by only a few percent, so the steps don't show.
      const l = Math.max(0.78, L[i]);
      ctx.fillStyle = shade(1 - l);
      ctx.beginPath();
      ctx.moveTo(o.left[i].x, o.left[i].y);
      ctx.lineTo(o.left[i + 1].x, o.left[i + 1].y);
      ctx.lineTo(o.right[i + 1].x, o.right[i + 1].y);
      ctx.lineTo(o.right[i].x, o.right[i].y);
      ctx.closePath();
      if (i === 2) ctx.arc(b.x, b.y, o.radii[3] * 1.05, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Knuckle highlights (MCP heads, then PIP), strength by how far the joint is bent.
  const creases: number[][] = [];
  const pips: number[][] = [];
  for (let f = 2; f <= 5; f++) {
    const fs = sk.fingers[f];
    const js = fs.joints;
    const w = FINGERS[f - 1].width[0] * sk.k;
    const hl = (p: Pt, r: number, a: number) => {
      if (a < 0.01) return;
      const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      gr.addColorStop(0, light(a));
      gr.addColorStop(1, light(0));
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    hl(lerpPt(js[0], js[1], 0.08), 0.6 * w, 0.55 * Math.sin(Math.max(0, fs.mcp) * RAD) + 0.1);
    // The PIP head: a small flat highlight (cheap), strength by how far it's bent.
    if (fs.pip > 20) pips.push([js[1].x, js[1].y, 0.3 * w]);
    // Flexion creases: a short darker band just past each bent joint (the skin folding),
    // collected and drawn in one stroke below.
    for (const [j, ang] of [[1, fs.pip], [2, fs.dip]] as const) {
      const a = Math.sin(Math.max(0, ang) * RAD);
      if (a < 0.25) continue;
      const seg = Math.hypot(js[j + 1].x - js[j].x, js[j + 1].y - js[j].y);
      const c = lerpPt(js[j], js[j + 1], Math.min(0.35, (0.3 * fingerRadius(sk, f, j)) / Math.max(1, seg)));
      const o = outlines[f];
      const dx = o.right[j].x - o.left[j].x;
      const dy = o.right[j].y - o.left[j].y;
      creases.push([c.x - dx * 0.42, c.y - dy * 0.42, c.x + dx * 0.42, c.y + dy * 0.42]);
    }
  }
  if (pips.length) {
    ctx.fillStyle = light(0.14);
    ctx.beginPath();
    for (const [x, y, r] of pips) (ctx.moveTo(x + r, y), ctx.arc(x, y, r, 0, Math.PI * 2));
    ctx.fill();
  }
  if (creases.length) {
    ctx.lineCap = 'butt';
    ctx.strokeStyle = shade(0.12);
    ctx.lineWidth = Math.max(1, 0.12 * FINGERS[2].width[0] * sk.k);
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of creases) (ctx.moveTo(x0, y0), ctx.lineTo(x1, y1));
    ctx.stroke();
  }
  // Valleys between the knuckle heads.
  for (let f = 2; f <= 4; f++) {
    const a = sk.fingers[f].joints[0];
    const b = sk.fingers[f + 1].joints[0];
    const m = lerpPt(a, b, 0.5);
    const bendA = Math.sin(Math.max(0, (sk.fingers[f].mcp + sk.fingers[f + 1].mcp) / 2) * RAD);
    const r = 0.5 * Math.hypot(b.x - a.x, b.y - a.y);
    const gr = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, r);
    gr.addColorStop(0, shade(0.1 + 0.12 * bendA));
    gr.addColorStop(1, shade(0));
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // The thumb lies on its side: its outer edge, away from the light, is darker.
  {
    const js = sk.fingers[1].joints;
    const o = outlines[1];
    const p0 = js[1];
    const p1 = js[3];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    // Outer = away from the index finger.
    const idx = sk.fingers[2].joints[0];
    let nx = -dy / len;
    let ny = dx / len;
    if ((idx.x - p0.x) * nx + (idx.y - p0.y) * ny > 0) (nx = -nx), (ny = -ny);
    const r = o.radii[1];
    const gr = ctx.createLinearGradient(p0.x, p0.y, p0.x + nx * r, p0.y + ny * r);
    gr.addColorStop(0, shade(0));
    gr.addColorStop(1, shade(0.22));
    ctx.fillStyle = gr;
    ctx.beginPath();
    smoothClosed(ctx, o.pts.slice());
    ctx.fill();
  }
  // Forearm roll: the side rolled down toward the keys is a little darker.
  if (Math.abs(sk.palm.roll) > 0.5) {
    const a = sk.toWorld(-40, -30);
    const b = sk.toWorld(40, -30);
    const gr = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    const s = Math.min(1, Math.abs(sk.palm.roll) / 10) * 0.16;
    // + roll = rolled toward screen-right: the screen-right side is lower, darker.
    const rightDark = (sk.palm.roll > 0) === (b.x > a.x);
    gr.addColorStop(0, shade(rightDark ? 0 : s));
    gr.addColorStop(1, shade(rightDark ? s : 0));
    ctx.fillStyle = gr;
    ctx.fillRect(Math.min(a.x, b.x) - 200, Math.min(a.y, b.y) - 400, Math.abs(b.x - a.x) + 400, 800);
  }
}

function paintHand(ctx: Ctx, sk: Skeleton, shapes: Shape[], outlines: FingerOutline[], edgeW: number, detail = true): void {
  // Edge pass, then the body on top: the edge only survives on the outside of the union.
  ctx.lineJoin = 'round';
  ctx.strokeStyle = SKIN.edge;
  ctx.lineWidth = edgeW * 2;
  ctx.beginPath();
  for (const s of shapes) s.path(ctx);
  ctx.stroke();
  // Body: fingers first, their separation lines, then the palm on top so the lines
  // stop where the fingers join it (shapes[0] is the palm).
  ctx.fillStyle = SKIN.fill;
  for (let i = 1; i < shapes.length; i++) {
    // One fill per piece: pieces wind different ways, so a single path would leave holes.
    ctx.beginPath();
    shapes[i].path(ctx);
    ctx.fill();
  }
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = SKIN.edge;
  ctx.lineWidth = edgeW * 0.8;
  for (let f = 2; f <= 5; f++) fingerSides(ctx, outlines[f]);
  ctx.restore();
  ctx.fillStyle = SKIN.fill;
  ctx.beginPath();
  shapes[0].path(ctx);
  ctx.fill();
  // Light and shade, only where the hand is.
  // (Not on the faint motion-trail copies of a fast glide: nobody sees it there.)
  if (detail) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    shadeHand(ctx, sk, outlines);
    ctx.restore();
  }
  // The thumb shows through the palm when it passes under (the hand is translucent):
  // inside the palm it gets a shaded body and a clear outline.
  ctx.save();
  ctx.beginPath();
  shapes[0].path(ctx);
  ctx.clip();
  ctx.beginPath();
  smoothClosed(ctx, thumbPhalanges(sk).pts);
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = SKIN.edge;
  ctx.fill();
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = SKIN.edge;
  ctx.lineWidth = edgeW * 1.1;
  ctx.stroke();
  ctx.restore();
  // Pressing fingertips glow softly in the hand's colour (the colour of its falling bars).
  for (let f = 1; f <= 5; f++) {
    const fs = sk.fingers[f];
    if (fs.press < 0.02) continue;
    const tip = fs.joints[fs.joints.length - 1];
    const r = outlines[f].radii[outlines[f].radii.length - 1];
    ctx.globalAlpha = fs.press * 0.6;
    ctx.fillStyle = GLOW[sk.hand];
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, r * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/**
 * Soft contact shadow on the keys: the hand's outline shifted by its height
 * (light from the upper left and front), so a fingertip on its key sits on its
 * shadow and a lifted finger or a leaping hand separates from it. Three stacked
 * fills instead of a blur filter (blur is slow in software canvas).
 */
function drawShadow(ctx: CanvasRenderingContext2D, sk: Skeleton, wristShift: Pt, wristRot: number, alpha: number): void {
  const off = (z: number): Pt => ({ x: 0.15 * Math.max(0, z) * sk.k, y: 0.35 * Math.max(0, z) * sk.k });
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Palm: one soft-edged fill, shifted by the knuckles' height.
  const palm = handShapes(sk, [], wristShift, wristRot, off(sk.palm.h), true)[0];
  ctx.beginPath();
  palm.path(ctx);
  ctx.globalAlpha = alpha * 0.15;
  ctx.fill();
  // Fingers: each joint shifted by its own height, drawn as thick round strokes in one go
  // (a fingertip on its key sits on its shadow; a lifted or curled one separates from it).
  ctx.beginPath();
  for (let f = 1; f <= 5; f++) {
    const fs = sk.fingers[f];
    fs.joints.forEach((j, i) => {
      const o = off(fs.z[i]);
      if (i) ctx.lineTo(j.x + o.x, j.y + o.y);
      else ctx.moveTo(j.x + o.x, j.y + o.y);
    });
  }
  ctx.globalAlpha = alpha * 0.18;
  ctx.lineWidth = FINGERS[2].width[1] * sk.k * 1.1;
  ctx.stroke();
  ctx.restore();
}

/**
 * The solved hand at t and its silhouette pieces. The wrist trails the hand for small
 * moves, and leads it (the arm moves first) when the hand shifts to a new position.
 * Cheap: no second solve.
 */
function handBody(anim: HandAnimator, pose: HandPose, t: number, tf: TipFrame) {
  const sk = solveSkeleton(pose, tf);
  // The forearm turns FOREARM_GAIN as much as the palm: the stub turns back by the rest.
  const wristRot = -sk.palm.rot * (1 - FOREARM_GAIN);
  const avgX = (p: HandPose) => {
    let d = 0;
    for (let f = 1; f <= 5; f++) d += tf.uToX(p.fingers[f].u);
    return d / 5;
  };
  const prevPose = anim.pose(pose.hand, t - WRIST_LAG);
  const trail = prevPose ? avgX(prevPose) - avgX(pose) : 0;
  let lead = 0;
  const shiftW = Math.min(1, Math.max(0, (pose.glideDist - 1) / 2));
  if (shiftW > 0) {
    const nextPose = anim.pose(pose.hand, t + WRIST_LEAD);
    if (nextPose) lead = avgX(nextPose) - avgX(pose);
  }
  const wristShift: Pt = { x: (trail * (1 - shiftW) + lead * shiftW) * 0.35, y: 0 };
  const outlines = [null as unknown as FingerOutline, ...[1, 2, 3, 4, 5].map((f) => fingerShape(sk, f))];
  const shapes = handShapes(sk, outlines, wristShift, wristRot);
  return { sk, wristShift, wristRot, outlines, shapes };
}

/**
 * One hand's silhouette at song time t as polygons (canvas px; their union is the
 * drawn shape, before the wrist fade): what the overlap checks measure.
 */
export function handSilhouette(anim: HandAnimator, hand: PlayHand, t: number, g: HandGeometry): { sk: Skeleton; polys: Pt[][] } | null {
  const pose = anim.pose(hand, t);
  if (!pose) return null;
  const { sk, shapes } = handBody(anim, pose, t, tipFrame(g));
  return { sk, polys: shapes.map((s) => s.poly()) };
}

function drawOne(
  ctx: CanvasRenderingContext2D,
  anim: HandAnimator,
  pose: HandPose,
  t: number,
  g: HandGeometry,
  tf: TipFrame,
  alpha: number,
  ghost = false,
): void {
  const { sk, wristShift, wristRot, outlines, shapes } = handBody(anim, pose, t, tf);
  const edgeW = Math.max(0.7, tf.unit * 0.035);

  // Bounds: every joint plus the palm/wrist.
  const pts: Pt[] = [];
  for (let f = 1; f <= 5; f++) pts.push(...sk.fingers[f].joints);
  for (const [a, v] of [[-45, 20], [45, 20], [-45, -150], [45, -150]] as const) pts.push(sk.toWorld(a, v));
  const pad = 30 * sk.k + Math.abs(wristShift.x) + Math.abs(wristShift.y);
  // Whole pixels, so the fade slices below meet without seams.
  const minX = Math.floor(Math.min(...pts.map((p) => p.x)) - pad);
  const maxX = Math.ceil(Math.max(...pts.map((p) => p.x)) + pad);
  const minY = Math.floor(Math.min(...pts.map((p) => p.y)) - pad);
  let maxY = Math.ceil(Math.max(...pts.map((p) => p.y)) + pad);
  if (g.floorY !== undefined) maxY = Math.min(maxY, Math.floor(g.floorY));
  if (maxY <= minY) return;
  const pr = g.pixelRatio ?? 1;
  const cw = Math.ceil((maxX - minX) * pr);
  const ch = Math.ceil((maxY - minY) * pr);
  if (cw <= 0 || ch <= 0) return;
  ctx.save();
  if (g.floorY !== undefined) {
    ctx.beginPath();
    ctx.rect(-1e5, -1e5, 2e5, g.floorY + 1e5);
    ctx.clip();
  }
  if (!ghost) drawShadow(ctx, sk, wristShift, wristRot, alpha);
  const sc = scratchCanvas(cw, ch);
  const sctx = sc.getContext('2d') as Ctx;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.globalCompositeOperation = 'source-over';
  sctx.clearRect(0, 0, cw, ch);
  sctx.setTransform(pr, 0, 0, pr, -minX * pr, -minY * pr);
  // Paint opaque, then lay down translucent: overlaps stay one even tone.
  paintHand(sctx, sk, shapes, outlines, edgeW, !ghost);
  // Lay it down, fading the wrist stub out toward the player: the band below the palm
  // goes down in horizontal slices of falling opacity (much cheaper than compositing
  // a gradient mask into the scratch canvas, which cost several ms a frame). Above the
  // live player's control bar, the fade finishes before the bar.
  const yA = sk.toWorld(0, -62).y;
  let yB = sk.toWorld(0, -88 - FOREARM).y + wristShift.y;
  if (g.floorY !== undefined) yB = Math.min(yB, g.floorY);
  const fadeTop = Math.round(Math.max(minY, Math.min(maxY, Math.min(yA, yB - 6 * sk.k))));
  const fadeBot = Math.round(Math.max(fadeTop, Math.min(maxY, yB)));
  const slice = (y0: number, y1: number, a: number) => {
    if (y1 <= y0 || a <= 0.003) return;
    const sy = Math.round((y0 - minY) * pr);
    const sh = Math.min(ch - sy, Math.round((y1 - minY) * pr) - sy);
    if (sh <= 0) return;
    ctx.globalAlpha = alpha * a;
    ctx.drawImage(sc as CanvasImageSource, 0, sy, cw, sh, minX, minY + sy / pr, cw / pr, sh / pr);
  };
  slice(minY, fadeTop, 1);
  const N = 24;
  for (let i = 0; i < N; i++) {
    const y0 = fadeTop + Math.round(((fadeBot - fadeTop) * i) / N);
    const y1 = fadeTop + Math.round(((fadeBot - fadeTop) * (i + 1)) / N);
    slice(y0, y1, 1 - (i + 0.5) / N);
  }
  ctx.restore();
}

/**
 * Draw both hands at song time t. Fast glides get two faint trailing copies
 * (motion smoothing), still computed purely from t.
 */
export function drawHands(
  ctx: CanvasRenderingContext2D,
  anim: HandAnimator,
  t: number,
  g: HandGeometry,
  show: Record<PlayHand, boolean> = { left: true, right: true },
): void {
  const tf = tipFrame(g);
  // The hand on top goes last (only matters for a forced crossing; otherwise they never meet).
  const order: PlayHand[] = anim.onTop(t) === 'left' ? ['right', 'left'] : ['left', 'right'];
  for (const hand of order) {
    if (!show[hand]) continue;
    const pose = anim.pose(hand, t);
    if (!pose) continue;
    if (pose.speed > 10) {
      for (const [dt, a] of [[0.04, 0.1], [0.02, 0.17]] as const) {
        const ghost = anim.pose(hand, t - dt);
        if (ghost) drawOne(ctx, anim, ghost, t - dt, g, tf, a, true);
      }
    }
    drawOne(ctx, anim, pose, t, g, tf, HAND_ALPHA);
  }
}
