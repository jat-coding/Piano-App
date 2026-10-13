import type { HandAnimator, HandPose } from './handPose';
import type { PlayHand } from './fingering';
import { FINGERS, solveSkeleton, type Pt, type Skeleton, type TipFrame } from './skeleton';

/**
 * Hands seen from above as simple silhouettes: one smooth translucent shape per
 * hand (palm, wrist stub, five tapered fingers with rounded tips), tinted per
 * hand (amber right, teal-blue left) with a subtle edge so it reads against the
 * notes. No nails, knuckles or other detail. The outline is rebuilt every frame
 * from the kinematic skeleton (skeleton.ts), so it bends the way a hand does
 * and stays a pure function of song time.
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
}

const TINT: Record<PlayHand, { fill: string; edge: string; glow: string }> = {
  right: { fill: '#e9c793', edge: '#7a4c1a', glow: '#f6c77c' },
  left: { fill: '#b3cdd2', edge: '#2b4a53', glow: '#9fd2e0' },
};

const HAND_ALPHA = 0.74;
/** Wrist stub below the palm, mm (fades out). */
const FOREARM = 46;
/** How long the wrist trails the palm, seconds. */
const WRIST_LAG = 0.07;

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
}

/** All the pieces of one hand's silhouette, in canvas px. Unioned when painted. */
function handShapes(sk: Skeleton, wristShift: Pt, wristRot: number): Shape[] {
  const { toWorld } = sk;
  const shapes: Shape[] = [];
  const W = (a: number, v: number) => toWorld(a, v);

  // Palm + wrist stub. The wrist end trails the palm (wristShift) and turns less.
  const palmPts: Pt[] = [
    W(-36, -6), W(-33, 3), W(-19, 7), W(-9, 9), W(10, 6), W(25, 0), W(34, -9),
    W(36, -30), W(32, -58), W(26, -84),
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
  palmPts.push(W(-24, -84), W(-31, -64), W(-37, -34));
  shapes.push({ path: (ctx) => smoothClosed(ctx, palmPts) });

  // Webs between the long fingers, so they grow out of the palm instead of being stuck on.
  for (let f = 2; f <= 4; f++) {
    const a = sk.fingers[f].joints;
    const b = sk.fingers[f + 1].joints;
    const pa = lerpPt(a[0], a[1], 0.2);
    const pb = lerpPt(b[0], b[1], 0.2);
    shapes.push({
      path: (ctx) => {
        ctx.moveTo(a[0].x, a[0].y);
        ctx.lineTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.lineTo(b[0].x, b[0].y);
        ctx.closePath();
      },
    });
  }

  // Fingers: one tapered outline each along the solved bones, rounded at both ends.
  for (let f = 1; f <= 5; f++) {
    const js = sk.fingers[f].joints;
    const radii = js.map((_, i) => fingerRadius(sk, f, i));
    shapes.push({ path: (ctx) => fingerOutline(ctx, js, radii) });
  }

  // The thumb web: from the thumb's first joint to the index knuckle, so the thumb
  // stays one piece with the palm whether it reaches out or tucks under.
  const th = sk.fingers[1].joints;
  const idx = sk.fingers[2].joints[0];
  const webA = lerpPt(th[1], th[2], 0.25);
  const cmc = th[0];
  const inner = W(-22, -18);
  shapes.push({
    path: (ctx) => {
      ctx.moveTo(cmc.x, cmc.y);
      ctx.lineTo(th[1].x, th[1].y);
      ctx.lineTo(webA.x, webA.y);
      ctx.quadraticCurveTo(inner.x, inner.y, idx.x, idx.y);
      ctx.lineTo(W(-20, -40).x, W(-20, -40).y);
      ctx.closePath();
    },
  });
  return shapes;
}

/** Half-width of finger f at joint i, px. The thumb's metacarpal is buried in the ball of the thumb: wider. */
function fingerRadius(sk: Skeleton, f: number, i: number): number {
  const spec = FINGERS[f - 1];
  const n = sk.fingers[f].joints.length - 1;
  const r = ((spec.width[0] + (spec.width[1] - spec.width[0]) * (i / n)) / 2) * sk.k;
  return f === 1 ? r * (i === 0 ? 1.5 : i === 1 ? 1.1 : 1) : r;
}

/** Closed outline through a chain of joints with per-joint radii (sides, round tip, round base). */
function fingerOutline(ctx: Ctx, js: Pt[], radii: number[]): void {
  const n = js.length - 1;
  const left: Pt[] = [];
  const right: Pt[] = [];
  let lastDir = { x: 0, y: -1 };
  for (let i = 0; i <= n; i++) {
    const a = js[Math.max(0, i - 1)];
    const b = js[Math.min(n, i + 1)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) ({ x: dx, y: dy } = lastDir);
    else (dx /= len), (dy /= len), (lastDir = { x: dx, y: dy });
    left.push({ x: js[i].x + dy * radii[i], y: js[i].y - dx * radii[i] });
    right.push({ x: js[i].x - dy * radii[i], y: js[i].y + dx * radii[i] });
  }
  const end = Math.atan2(js[n].y - js[n - 1].y, js[n].x - js[n - 1].x);
  const start = Math.atan2(js[1].y - js[0].y, js[1].x - js[0].x);
  ctx.moveTo(left[0].x, left[0].y);
  for (let i = 1; i <= n; i++) ctx.lineTo(left[i].x, left[i].y);
  ctx.arc(js[n].x, js[n].y, radii[n], end - Math.PI / 2, end + Math.PI / 2);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
  ctx.arc(js[0].x, js[0].y, radii[0], start + Math.PI / 2, start + (3 * Math.PI) / 2);
  ctx.closePath();
}

function lerpPt(a: Pt, b: Pt, s: number): Pt {
  return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
}

/** Stroke the two sides of a finger (from joint `from` to the tip), optionally round the tip. */
function fingerSides(ctx: Ctx, sk: Skeleton, f: number, from: number, cap = false): void {
  const js = sk.fingers[f].joints;
  const spec = FINGERS[f - 1];
  const n = js.length - 1;
  const rad = (i: number) => ((spec.width[0] + (spec.width[1] - spec.width[0]) * (i / n)) / 2) * sk.k;
  const side: Pt[][] = [[], []];
  for (let i = from; i <= n; i++) {
    const a = js[Math.max(0, i - 1)];
    const b = js[Math.min(n, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const r = rad(i) * (i === n && !cap ? 0.7 : 1);
    side[0].push({ x: js[i].x - (dy / len) * r, y: js[i].y + (dx / len) * r });
    side[1].push({ x: js[i].x + (dy / len) * r, y: js[i].y - (dx / len) * r });
  }
  if (cap) {
    const tip = js[n];
    const prev = js[n - 1];
    const ang = Math.atan2(tip.y - prev.y, tip.x - prev.x);
    ctx.beginPath();
    side[0].forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.arc(tip.x, tip.y, rad(n), ang + Math.PI / 2, ang - Math.PI / 2, true);
    for (let i = side[1].length - 1; i >= 0; i--) ctx.lineTo(side[1][i].x, side[1][i].y);
    ctx.stroke();
    return;
  }
  for (const pts of side) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
}

function paintHand(ctx: Ctx, sk: Skeleton, shapes: Shape[], edgeW: number): void {
  const tint = TINT[sk.hand];
  // Edge pass, then the body on top: the edge only survives on the outside of the union.
  ctx.lineJoin = 'round';
  ctx.strokeStyle = tint.edge;
  ctx.fillStyle = tint.edge;
  ctx.lineWidth = edgeW * 2;
  ctx.beginPath();
  for (const s of shapes) s.path(ctx);
  ctx.stroke();
  // Body: fingers first, their separation lines, then the palm on top so the lines
  // stop where the fingers join it (shapes[0] is the palm).
  ctx.fillStyle = tint.fill;
  for (let i = 1; i < shapes.length; i++) {
    ctx.beginPath();
    shapes[i].path(ctx);
    ctx.fill();
  }
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = tint.edge;
  ctx.lineWidth = edgeW;
  for (let f = 2; f <= 5; f++) fingerSides(ctx, sk, f, 0);
  ctx.restore();
  ctx.fillStyle = tint.fill;
  ctx.beginPath();
  shapes[0].path(ctx);
  ctx.fill();
  // The thumb shows through the palm when it passes under (the hand is translucent):
  // inside the palm it gets a shaded body and a clear outline.
  ctx.save();
  ctx.beginPath();
  shapes[0].path(ctx);
  ctx.clip();
  const th = sk.fingers[1].joints;
  ctx.beginPath();
  fingerOutline(ctx, th.slice(1), th.slice(1).map((_, i) => fingerRadius(sk, 1, i + 1)));
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = tint.edge;
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = tint.edge;
  ctx.lineWidth = edgeW * 1.2;
  ctx.stroke();
  ctx.restore();
  // Pressing fingertips glow softly in the hand colour.
  for (let f = 1; f <= 5; f++) {
    const fs = sk.fingers[f];
    if (fs.press < 0.02) continue;
    const tip = fs.joints[fs.joints.length - 1];
    const r = (FINGERS[f - 1].width[1] / 2) * sk.k;
    ctx.globalAlpha = fs.press * 0.75;
    ctx.fillStyle = tint.glow;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, r * 0.85, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawOne(
  ctx: CanvasRenderingContext2D,
  anim: HandAnimator,
  pose: HandPose,
  t: number,
  g: HandGeometry,
  tf: TipFrame,
  alpha: number,
): void {
  const sk = solveSkeleton(pose, tf);
  // The wrist trails: it lags behind where the fingers were a moment ago (cheap: no second solve).
  const prevPose = anim.pose(pose.hand, t - WRIST_LAG);
  let wristShift: Pt = { x: 0, y: 0 };
  const wristRot = -sk.palm.rot * 0.5;
  if (prevPose) {
    let d = 0;
    for (let f = 1; f <= 5; f++) d += tf.uToX(prevPose.fingers[f].u) - tf.uToX(pose.fingers[f].u);
    wristShift = { x: (d / 5) * 0.35, y: 0 };
  }
  const shapes = handShapes(sk, wristShift, wristRot);
  const edgeW = Math.max(0.8, tf.unit * 0.045);

  // Bounds: every joint plus the palm/wrist.
  const pts: Pt[] = [];
  for (let f = 1; f <= 5; f++) pts.push(...sk.fingers[f].joints);
  for (const [a, v] of [[-45, 20], [45, 20], [-45, -150], [45, -150]] as const) pts.push(sk.toWorld(a, v));
  const pad = 30 * sk.k + Math.abs(wristShift.x) + Math.abs(wristShift.y);
  // Whole pixels, so the fade slices below meet without seams.
  const minX = Math.floor(Math.min(...pts.map((p) => p.x)) - pad);
  const maxX = Math.ceil(Math.max(...pts.map((p) => p.x)) + pad);
  const minY = Math.floor(Math.min(...pts.map((p) => p.y)) - pad);
  const maxY = Math.ceil(Math.max(...pts.map((p) => p.y)) + pad);
  const pr = g.pixelRatio ?? 1;
  const cw = Math.ceil((maxX - minX) * pr);
  const ch = Math.ceil((maxY - minY) * pr);
  if (cw <= 0 || ch <= 0) return;
  const sc = scratchCanvas(cw, ch);
  const sctx = sc.getContext('2d') as Ctx;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.globalCompositeOperation = 'source-over';
  sctx.clearRect(0, 0, cw, ch);
  sctx.setTransform(pr, 0, 0, pr, -minX * pr, -minY * pr);
  // Paint opaque, then lay down translucent: overlaps stay one even tone.
  paintHand(sctx, sk, shapes, edgeW);
  // Lay it down, fading the wrist stub out toward the player: the band below the palm
  // goes down in horizontal slices of falling opacity (much cheaper than compositing
  // a gradient mask into the scratch canvas, which cost several ms a frame).
  const yA = sk.toWorld(0, -62).y;
  const yB = sk.toWorld(0, -88 - FOREARM).y + wristShift.y;
  const fadeTop = Math.round(Math.max(minY, Math.min(maxY, yA)));
  const fadeBot = Math.round(Math.max(fadeTop, Math.min(maxY, yB)));
  const slice = (y0: number, y1: number, a: number) => {
    if (y1 <= y0 || a <= 0.003) return;
    const sy = Math.round((y0 - minY) * pr);
    const sh = Math.min(ch - sy, Math.round((y1 - minY) * pr) - sy);
    if (sh <= 0) return;
    ctx.globalAlpha = alpha * a;
    ctx.drawImage(sc as CanvasImageSource, 0, sy, cw, sh, minX, minY + sy / pr, cw / pr, sh / pr);
  };
  ctx.save();
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
  for (const hand of ['left', 'right'] as PlayHand[]) {
    if (!show[hand]) continue;
    const pose = anim.pose(hand, t);
    if (!pose) continue;
    if (pose.speed > 10) {
      for (const [dt, a] of [[0.04, 0.1], [0.02, 0.17]] as const) {
        const ghost = anim.pose(hand, t - dt);
        if (ghost) drawOne(ctx, anim, ghost, t - dt, g, tf, a);
      }
    }
    drawOne(ctx, anim, pose, t, g, tf, HAND_ALPHA);
  }
}
