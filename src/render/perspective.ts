/**
 * Perspective ("road into the distance") view: the ONE copy of the projection math.
 * Both the live Renderer and the export ExportFrameRenderer draw their lanes, the
 * vanishing-point glow and the reflection through this module, so the app and the
 * exported video can't drift apart (see the 2026-10-12 phase-9 lesson in VERIFY.md).
 *
 * Only the note field is projected. The keyboard and the hands stay flat at the
 * bottom, exactly as in the classic view (as in the reference reel), so tap-to-play
 * hit-testing and hand placement keep their screen coordinates.
 *
 * A note `dist` flat pixels above the strike line (dist = secondsAhead * pps) sits at
 * depth scale s = D / (D + dist): s = 1 on the strike line, s → 0 at the vanishing
 * point. Screen y = vpY + (strikeY - vpY) * s; screen x pulls toward vpX by the same s.
 */

export type ViewStyle = 'classic' | 'perspective';

export interface Perspective {
  vpX: number;
  vpY: number;
  strikeY: number;
  /** Top of the note field; nothing is drawn above it. */
  topY: number;
  /** Depth constant in flat pixels: how far up a note has to be to shrink to half size. */
  depth: number;
}

/** Fraction of the note field kept free under the keyboard for the reflection. */
export const REFLECTION_FRACTION = 0.13;

export function makePerspective(width: number, topY: number, strikeY: number): Perspective {
  const field = Math.max(1, strikeY - topY);
  // The vanishing point sits a little above the top edge, so lanes still read as
  // separate at the top of the frame (like the reference reel).
  const vpY = topY - field * 0.12;
  return { vpX: width / 2, vpY, strikeY, topY, depth: (strikeY - vpY) * 0.7 };
}

/** Depth scale (1 at the strike line) for a note `dist` flat px above it. */
export function depthScale(p: Perspective, dist: number): number {
  return p.depth / (p.depth + Math.max(0, dist));
}

export function projY(p: Perspective, dist: number): number {
  return p.vpY + (p.strikeY - p.vpY) * depthScale(p, dist);
}

export function projX(p: Perspective, x: number, dist: number): number {
  return p.vpX + (x - p.vpX) * depthScale(p, dist);
}

/** The flat distance (px above the strike line) that projects onto the top of the field. */
export function maxDist(p: Perspective): number {
  const s = (p.topY - p.vpY) / (p.strikeY - p.vpY);
  return s <= 0 ? Infinity : p.depth * (1 / s - 1);
}

/**
 * Trace a note bar (key-space x0..x1, flat distances dNear..dFar above the strike line)
 * as its projected trapezoid. Returns the screen-space bottom edge for labels.
 */
export function traceBar(
  ctx: CanvasRenderingContext2D,
  p: Perspective,
  x0: number,
  x1: number,
  dNear: number,
  dFar: number,
): { yBottom: number; yTop: number; xl: number; xr: number } {
  const yb = projY(p, dNear);
  const yt = projY(p, dFar);
  const bl = projX(p, x0, dNear);
  const br = projX(p, x1, dNear);
  ctx.beginPath();
  ctx.moveTo(bl, yb);
  ctx.lineTo(br, yb);
  ctx.lineTo(projX(p, x1, dFar), yt);
  ctx.lineTo(projX(p, x0, dFar), yt);
  ctx.closePath();
  return { yBottom: yb, yTop: yt, xl: bl, xr: br };
}

/** Warm glow pooling at the vanishing point and a soft light column down the road. */
export function drawVanishingGlow(ctx: CanvasRenderingContext2D, p: Perspective, width: number): void {
  const field = p.strikeY - p.topY;
  const g = ctx.createRadialGradient(p.vpX, p.topY, 0, p.vpX, p.topY, Math.max(width * 0.6, field * 0.6));
  g.addColorStop(0, 'rgba(250,170,70,0.62)');
  g.addColorStop(0.3, 'rgba(214,120,40,0.22)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, p.topY, width, field);
  // The road itself: a warm wedge from the vanishing point down to the keys, bright at the far end.
  const half = width * 0.2;
  const w = ctx.createLinearGradient(0, p.topY, 0, p.strikeY);
  w.addColorStop(0, 'rgba(232,150,60,0.34)');
  w.addColorStop(0.6, 'rgba(214,140,60,0.08)');
  w.addColorStop(1, 'rgba(214,140,60,0.02)');
  ctx.fillStyle = w;
  ctx.beginPath();
  ctx.moveTo(p.vpX, p.vpY);
  ctx.lineTo(p.vpX + half, p.strikeY);
  ctx.lineTo(p.vpX - half, p.strikeY);
  ctx.closePath();
  ctx.fill();
  // Light streaks inside the beam (fixed, so nothing flickers between frames).
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 9; i++) {
    const u = (i / 8) * 2 - 1; // -1..1 across the beam
    const spread = half * 0.85 * u + half * 0.08 * Math.sin(i * 2.3);
    const a = 0.05 + 0.04 * ((i * 7) % 3);
    const sg = ctx.createLinearGradient(0, p.topY, 0, p.topY + field * 0.75);
    sg.addColorStop(0, `rgba(255,170,80,${a})`);
    sg.addColorStop(1, 'rgba(255,170,80,0)');
    ctx.strokeStyle = sg;
    ctx.lineWidth = Math.max(1, width * 0.004);
    ctx.beginPath();
    ctx.moveTo(p.vpX, p.vpY);
    ctx.lineTo(p.vpX + spread, p.strikeY);
    ctx.stroke();
  }
  ctx.restore();
}

/** Lane guide lines: from each given key x on the strike line toward the vanishing point. */
export function drawLaneGuides(
  ctx: CanvasRenderingContext2D,
  p: Perspective,
  xs: number[],
  color: string,
  lineWidth: number,
): void {
  const far = maxDist(p);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  for (const x of xs) {
    ctx.moveTo(x, p.strikeY);
    ctx.lineTo(projX(p, x, far), p.topY);
  }
  ctx.stroke();
}

/**
 * Glossy floor reflection: mirror the band [srcTop, srcTop + srcH) (keyboard + hands)
 * upside down into [dstTop, dstTop + dstH), fading out downward. Works in device pixels;
 * `scale` is the canvas's CSS→device ratio (dpr live, 1 in export).
 */
export function drawReflection(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  scale: number,
  width: number,
  srcTop: number,
  srcH: number,
  dstTop: number,
  dstH: number,
  bg: string,
): void {
  if (srcH <= 0 || dstH <= 0) return;
  ctx.save();
  ctx.fillStyle = bg;
  ctx.fillRect(0, dstTop, width, dstH);
  ctx.globalAlpha = 0.3;
  // Flip: source row srcTop+srcH lands at dstTop, row srcTop at dstTop+dstH.
  ctx.translate(0, dstTop + dstH);
  ctx.scale(1, -1);
  ctx.drawImage(
    canvas,
    0,
    Math.round(srcTop * scale),
    Math.round(width * scale),
    Math.round(srcH * scale),
    0,
    0,
    width,
    dstH,
  );
  ctx.restore();
  // Fade into the floor.
  const f = ctx.createLinearGradient(0, dstTop, 0, dstTop + dstH);
  f.addColorStop(0, 'rgba(15,12,9,0.1)');
  f.addColorStop(0.55, 'rgba(15,12,9,0.75)');
  f.addColorStop(1, 'rgba(15,12,9,1)');
  ctx.fillStyle = f;
  ctx.fillRect(0, dstTop, width, dstH);
  // A thin glossy edge where the keys meet the floor.
  const edge = ctx.createLinearGradient(0, 0, width, 0);
  edge.addColorStop(0, 'rgba(232,170,90,0)');
  edge.addColorStop(0.5, 'rgba(232,170,90,0.3)');
  edge.addColorStop(1, 'rgba(232,170,90,0)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, dstTop, width, 1.5);
}
