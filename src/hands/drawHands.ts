import type { HandAnimator, HandPose } from './handPose';
import type { PlayHand } from './fingering';

/**
 * Stylised hands seen from above, in Cascade's own look: translucent ivory
 * tinted per hand (amber right, teal-blue left), brass joints, fingertips that
 * glow in the hand colour while a key is down. Drawn per frame from a HandPose,
 * so it stays a pure function of song time.
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

const TINT: Record<PlayHand, { fill: string; edge: string; glow: string; rgb: string }> = {
  right: { fill: '#e9c793', edge: '#8a5a22', glow: '#f0b968', rgb: '211,154,82' },
  left: { fill: '#b3cdd2', edge: '#33525b', glow: '#8fc3d1', rgb: '95,138,150' },
};
const BRASS = 'rgba(194,162,74,0.9)';

// Per finger 1..5, in white-key widths.
const WIDTH = [0, 0.8, 0.7, 0.72, 0.66, 0.58];
const KNUCKLE_OFF = [0, 0, -1.2, -0.4, 0.4, 1.15]; // across the palm, right hand
const ARCH = [0, 0, -0.05, -0.2, -0.08, 0.3]; // knuckle line curve

const HAND_ALPHA = 0.8;
const PALM_LEN = 2.8; // knuckles to wrist, white keys

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

interface Pts {
  tip: { x: number; y: number }[];
  knuckle: { x: number; y: number }[];
  palmX: number;
  kY: number;
  dir: number;
  w: number;
}

/** The hand's size unit: the white-key width, but never below the geometry's minimum. */
export function handUnit(g: HandGeometry): number {
  return Math.max(g.whiteW, g.minUnit ?? 0);
}

function layout(pose: HandPose, g: HandGeometry): Pts {
  const w = handUnit(g);
  const dir = pose.hand === 'right' ? 1 : -1;
  const blackTipY = Math.max(g.strikeY + g.blackH * 0.35, g.strikeY + g.blackH - 0.75 * w);
  // Knuckles just in front of the keys; on very long keys, the hand sits on them
  // so a finger can still reach a black key without growing.
  const kY = Math.min(g.strikeY + g.kbH + 0.9 * w, blackTipY + 3.6 * w);
  // White keys are played just in front of the black keys, as pianists do.
  const whiteTipY = Math.min(
    g.strikeY + g.kbH * 0.92,
    Math.max(g.strikeY + g.blackH + 0.4 * w, Math.min(kY - 2.5 * w, g.strikeY + g.kbH - 0.45 * w)),
  );
  const tip: Pts['tip'] = [{ x: 0, y: 0 }];
  for (let f = 1; f <= 5; f++) {
    const fp = pose.fingers[f];
    let y = whiteTipY + (blackTipY - whiteTipY) * fp.depth;
    if (f === 1) y += 0.55 * w * (1 - fp.depth); // the thumb is shorter
    y += 0.12 * w * fp.press; // the pad flattens onto the key
    tip.push({ x: g.uToX(fp.u), y });
  }
  // Palm centre follows the long fingers, pulled toward the thumb when it
  // reaches out, so a wide stretch spreads the whole hand instead of the thumb.
  const longMid = (tip[2].x + tip[3].x + tip[4].x + tip[5].x) / 4;
  const outer = (tip[1].x + tip[5].x) / 2 + dir * 0.3 * w;
  const palmX = longMid + (outer - longMid) * 0.6;
  const spread = Math.min(1.3, Math.max(0.85, Math.abs(tip[5].x - tip[1].x) / (4.4 * w)));
  const knuckle: Pts['knuckle'] = [{ x: 0, y: 0 }];
  knuckle.push({ x: palmX - dir * 1.45 * spread * w, y: kY + 1.0 * w }); // thumb base
  for (let f = 2; f <= 5; f++) {
    const base = palmX + dir * KNUCKLE_OFF[f] * spread * w;
    knuckle.push({ x: base + (tip[f].x - base) * 0.28, y: kY + ARCH[f] * w });
  }
  return { tip, knuckle, palmX, kY, dir, w };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function fingerPath(ctx: Ctx, p: Pts, f: number, widthScale = 1): void {
  const k = p.knuckle[f];
  const t = p.tip[f];
  const w = p.w * WIDTH[f] * widthScale;
  const segs = f === 1 ? [0.55] : [0.48, 0.78];
  // A slight outward bow so the finger reads as jointed, not a stick.
  const nx = -(t.y - k.y);
  const ny = t.x - k.x;
  const len = Math.hypot(nx, ny) || 1;
  const bow = (f === 1 ? 0.1 : 0.04) * p.w * p.dir * (f === 1 ? -1 : 1);
  const pts = [k, ...segs.map((s) => ({ x: k.x + (t.x - k.x) * s + (nx / len) * bow, y: k.y + (t.y - k.y) * s + (ny / len) * bow })), t];
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i + 1 < pts.length; i++) {
    ctx.lineWidth = w * (1 - 0.1 * i);
    ctx.beginPath();
    ctx.moveTo(pts[i].x, pts[i].y);
    ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
    ctx.stroke();
  }
}

function jointsOf(p: Pts, f: number): { x: number; y: number }[] {
  const k = p.knuckle[f];
  const t = p.tip[f];
  const segs = f === 1 ? [0.55] : [0.48, 0.78];
  return segs.map((s) => ({ x: k.x + (t.x - k.x) * s, y: k.y + (t.y - k.y) * s }));
}

function palmPath(ctx: Ctx, p: Pts): void {
  const { palmX: x, kY: y, dir, w } = p;
  const L = (dx: number) => x + dir * dx * w; // positions across the palm, mirrored for the left hand
  ctx.beginPath();
  ctx.moveTo(L(-1.55), y + 0.15 * w);
  ctx.quadraticCurveTo(L(-0.1), y - 0.4 * w, L(1.5), y + 0.3 * w); // knuckle line
  ctx.quadraticCurveTo(L(1.7), y + 1.5 * w, L(1.05), y + PALM_LEN * w); // little-finger side
  ctx.lineTo(L(-0.85), y + PALM_LEN * w); // wrist
  ctx.quadraticCurveTo(L(-1.95), y + 2.0 * w, L(-1.8), y + 0.95 * w); // ball of the thumb
  ctx.quadraticCurveTo(L(-1.75), y + 0.4 * w, L(-1.55), y + 0.15 * w);
  ctx.closePath();
}

function paintHand(ctx: Ctx, pose: HandPose, p: Pts): void {
  const tint = TINT[pose.hand];
  const { w } = p;
  const edgeW = Math.max(1, w * 0.07);

  // Palm, fading out toward the wrist.
  const grad = ctx.createLinearGradient(0, p.kY, 0, p.kY + PALM_LEN * w);
  grad.addColorStop(0, tint.fill);
  grad.addColorStop(0.5, tint.fill);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  const edgeGrad = ctx.createLinearGradient(0, p.kY, 0, p.kY + PALM_LEN * w);
  edgeGrad.addColorStop(0, tint.edge);
  edgeGrad.addColorStop(0.5, tint.edge);
  edgeGrad.addColorStop(1, 'rgba(0,0,0,0)');
  palmPath(ctx, p);
  ctx.fillStyle = grad;
  ctx.fill();

  // Fingers: dark outline pass, then the ivory body on top (one hand = one silhouette).
  ctx.strokeStyle = tint.edge;
  for (let f = 1; f <= 5; f++) fingerPath(ctx, p, f, 1 + (2 * edgeW) / (w * WIDTH[f]));
  ctx.strokeStyle = tint.fill;
  for (let f = 1; f <= 5; f++) fingerPath(ctx, p, f);
  // Re-fill the palm's top so finger roots blend into it.
  ctx.save();
  palmPath(ctx, p);
  ctx.clip();
  ctx.fillStyle = grad;
  ctx.fillRect(p.palmX - 3 * w, p.kY - w, 6 * w, 5 * w);
  ctx.restore();
  palmPath(ctx, p);
  ctx.strokeStyle = edgeGrad;
  ctx.lineWidth = edgeW * 2;
  ctx.save();
  ctx.clip(); // only the inner half of the outline, so it doesn't cut across the fingers
  ctx.stroke();
  ctx.restore();

  // Brass joints and knuckles.
  ctx.fillStyle = BRASS;
  const jr = Math.max(0.8, w * 0.07);
  for (let f = 1; f <= 5; f++) {
    for (const j of jointsOf(p, f)) {
      ctx.beginPath();
      ctx.arc(j.x, j.y, jr, 0, Math.PI * 2);
      ctx.fill();
    }
    const k = p.knuckle[f];
    ctx.beginPath();
    ctx.arc(k.x, k.y, jr * 1.3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Fingertips: a nail when hovering, a glowing pad when pressing.
  for (let f = 1; f <= 5; f++) {
    const t = p.tip[f];
    const press = pose.fingers[f].press;
    const r = w * WIDTH[f] * 0.5;
    if (press > 0.02) {
      ctx.fillStyle = `rgba(${tint.rgb},${0.35 * press})`;
      ctx.beginPath();
      ctx.arc(t.x, t.y, r * (1.6 + 0.4 * press), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = tint.glow;
      ctx.globalAlpha = press;
      ctx.beginPath();
      ctx.arc(t.x, t.y, r * 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = 'rgba(255,250,238,0.75)';
    ctx.beginPath();
    ctx.ellipse(t.x, t.y - r * 0.15, r * 0.48, r * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Shadow of the hovering fingers on the keys: the higher the finger, the further it falls. */
function paintShadow(ctx: CanvasRenderingContext2D, pose: HandPose, p: Pts): void {
  ctx.strokeStyle = 'rgba(10,6,2,0.28)';
  ctx.save();
  for (let f = 1; f <= 5; f++) {
    const lift = 1 - pose.fingers[f].press;
    const off = p.w * (0.08 + 0.22 * lift);
    ctx.setTransform(ctx.getTransform().translate(off * 0.6, off));
    fingerPath(ctx, p, f);
    ctx.setTransform(ctx.getTransform().translate(-off * 0.6, -off));
  }
  ctx.restore();
}

function drawOne(ctx: CanvasRenderingContext2D, pose: HandPose, g: HandGeometry, alpha: number): void {
  const p = layout(pose, g);
  const w = p.w;
  paintShadow(ctx, pose, p);

  // Draw the hand opaque into a scratch canvas, then lay it down translucent:
  // overlapping parts stay one even tone instead of stacking up.
  const xs = [...p.tip.slice(1).map((q) => q.x), p.palmX - 2.6 * w, p.palmX + 2.6 * w];
  const minX = Math.min(...xs) - w;
  const maxX = Math.max(...xs) + w;
  const minY = Math.min(...p.tip.slice(1).map((q) => q.y)) - w;
  const maxY = p.kY + (PALM_LEN + 0.2) * w;
  const pr = g.pixelRatio ?? 1;
  const cw = Math.ceil((maxX - minX) * pr);
  const ch = Math.ceil((maxY - minY) * pr);
  if (cw <= 0 || ch <= 0) return;
  const sc = scratchCanvas(cw, ch);
  const sctx = sc.getContext('2d') as Ctx;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, cw, ch);
  sctx.setTransform(pr, 0, 0, pr, -minX * pr, -minY * pr);
  paintHand(sctx, pose, p);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(sc as CanvasImageSource, 0, 0, cw, ch, minX, minY, cw / pr, ch / pr);
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
  for (const hand of ['left', 'right'] as PlayHand[]) {
    if (!show[hand]) continue;
    const pose = anim.pose(hand, t);
    if (!pose) continue;
    if (pose.speed > 10) {
      for (const [dt, a] of [[0.04, 0.1], [0.02, 0.17]] as const) {
        const ghost = anim.pose(hand, t - dt);
        if (ghost) drawOne(ctx, ghost, g, a);
      }
    }
    drawOne(ctx, pose, g, HAND_ALPHA);
  }
}
