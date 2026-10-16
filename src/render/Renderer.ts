import type { NoteEvent, Song, Hand } from '../types';
import { computeKeyboard, indexKeys, isBlackKey, type KeyGeometry } from './keyboard';
import { HandAnimator } from '../hands/handPose';
import { drawHands, type HandGeometry } from '../hands/drawHands';
import { keyU } from '../hands/fingering';
import * as P from './perspective';

/** Cascade palette — keep in sync with :root in index.css (the video export reuses it). */
export const COLORS = {
  bg: '#14110d', // warm ebony
  bgTop: '#0f0c09',
  guide: 'rgba(194,162,74,0.06)', // faint brass octave lines
  glow: 'rgba(194,162,74,0.12)', // candlelight pooling above the keys
  strike: 'rgba(214,190,120,0.85)', // brass strike line
  felt: '#7a2f33', // burgundy felt strip
  whiteKey: '#efe5cf', // ivory
  whiteKeyLo: '#d8c9a7', // ivory in shadow
  blackKey: '#1a1510', // ebony
  blackKeySheen: 'rgba(216,190,120,0.10)',
  press: '#d8be78', // brass — on-screen key press
  keyBorder: '#0c0a07',
  right: '#d39a52', // honey amber
  rightDark: '#a06a28',
  left: '#5f8a96', // dusty teal-blue
  leftDark: '#3c5b64',
  wrong: '#c4473f', // play along: a wrong key
};

/** Hands never shrink below this many CSS px per white key (88 keys on a phone are narrow). */
const MIN_HAND_UNIT = 12;

/** A lit key (a finger is on it), and by which hand. */
interface Lit {
  hand: Hand;
}

function handRgb(hand: Hand): string {
  return hand === 'left' ? '95,138,150' : '211,154,82';
}

/** Space the page keeps over the canvas edges (control bar, notch/home-indicator safe areas). */
export interface StageInsets {
  left: number;
  right: number;
  bottom: number;
}

export function noteColor(hand: Hand, black: boolean): string {
  if (hand === 'left') return black ? COLORS.leftDark : COLORS.left;
  // right + unknown both render as right/orange
  return black ? COLORS.rightDark : COLORS.right;
}

export interface RenderOptions {
  pixelsPerSecond: number;
  /** Which hands are visible. */
  showLeft: boolean;
  showRight: boolean;
  glow: boolean;
  impacts: boolean;
  showHands: boolean;
  /** 'perspective' = lanes recede to a vanishing point, with a floor reflection. */
  viewStyle: P.ViewStyle;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
}

/**
 * Canvas 2D falling-note renderer. Time-driven: every note's position is a
 * pure function of (note.startTime - currentTime), so seek/scrub/speed are free.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;

  private song: Song | null = null;
  private keys: KeyGeometry[] = [];
  private keyByMidi = new Map<number, KeyGeometry>();
  private keyboardHeight = 0;
  private strikeY = 0;
  private whiteW = 0;
  private handRoom = 0;
  private laidOutHands = false;
  private laidOutStyle: P.ViewStyle = 'classic';
  // Perspective view: projection for the note field, and the reflection strip under the hands.
  private persp: P.Perspective | null = null;
  private reflH = 0;
  private insets: StageInsets = { left: 0, right: 0, bottom: 0 };
  // Fingering + hand poses for the current song, built the first time hands are drawn.
  private hands: HandAnimator | null = null;

  opts: RenderOptions = {
    pixelsPerSecond: 220,
    showLeft: true,
    showRight: true,
    glow: true,
    impacts: true,
    showHands: true,
    viewStyle: 'classic',
  };

  // Impact particles (own wall clock so they don't warp with seek/speed).
  private particles: Particle[] = [];
  private prevActive = new Set<number>();
  private lastWall = 0;
  // Keys the player must press in wait-mode (highlighted on the keyboard).
  private expected = new Set<number>();
  // Transient highlights for keys tapped on the on-screen keyboard.
  private flashes = new Map<number, number>();
  // Play along: keys flashing red (wrong), until performance.now() passes the value.
  private wrongs = new Map<number, number>();
  /**
   * Play along: a note lights its key only once this says it was played (the song waits
   * on it until then). Null = every note lights as the song reaches it.
   */
  litFilter: ((index: number) => boolean) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
  }

  setSong(song: Song | null): void {
    this.song = song;
    this.hands = null;
    this.particles = [];
    this.prevActive.clear();
  }

  setExpected(midis: number[]): void {
    this.expected = new Set(midis);
  }

  /** Map a canvas point to a piano key, or null if it's above the keyboard. */
  keyAtPoint(x: number, y: number): number | null {
    if (y < this.strikeY || y > this.strikeY + this.keyboardHeight) return null;
    const blackH = this.keyboardHeight * 0.62;
    // Black keys sit on top, so test them first within their shorter height.
    if (y <= this.strikeY + blackH) {
      for (const k of this.keys) {
        if (k.black && x >= k.x && x <= k.x + k.w) return k.midi;
      }
    }
    for (const k of this.keys) {
      if (!k.black && x >= k.x && x <= k.x + k.w) return k.midi;
    }
    return null;
  }

  /** Briefly light a key the player pressed on the on-screen keyboard. */
  flashKey(midi: number): void {
    this.flashes.set(midi, performance.now() + 170);
  }

  /** Flash a key red: the player hit it, but the song doesn't have it here. */
  flashWrong(midi: number): void {
    this.wrongs.set(midi, performance.now() + 320);
  }

  /**
   * Keep the keyboard and hands clear of whatever overlays the canvas edges: the
   * control bar at the bottom, and the safe areas (notch, home indicator).
   */
  setInsets(insets: StageInsets): void {
    const i = this.insets;
    if (i.left === insets.left && i.right === insets.right && i.bottom === insets.bottom) return;
    this.insets = { ...insets };
    if (this.cssW) this.layout();
  }

  /** Resize backing store for crisp retina rendering; recompute key geometry. */
  resize(cssW: number, cssH: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.layout();
  }

  private layout(): void {
    const { cssW, cssH, insets } = this;
    const left = Math.min(insets.left, cssW * 0.2);
    const right = Math.min(insets.right, cssW * 0.2);
    const kb = computeKeyboard(cssW - left - right);
    for (const k of kb.keys) {
      k.x += left;
      k.cx += left;
    }
    this.keys = kb.keys;
    this.keyByMidi = indexKeys(kb.keys);
    this.whiteW = kb.whiteWidth;

    // Keyboard occupies ~16% of height, clamped to a sane pixel range.
    this.keyboardHeight = Math.max(70, Math.min(150, cssH * 0.16));
    // With hands on, leave a strip under the keys for the palms.
    this.laidOutHands = this.opts.showHands;
    const unit = Math.max(this.whiteW, MIN_HAND_UNIT);
    this.handRoom = this.opts.showHands ? Math.round(Math.max(14, Math.min(110, unit * 3))) : 0;
    // Everything sits above the bottom safe area (home indicator).
    const bottom = Math.min(insets.bottom, cssH * 0.45);
    // Perspective: keep a strip under the hands for the floor reflection.
    this.laidOutStyle = this.opts.viewStyle;
    const persp = this.opts.viewStyle === 'perspective';
    this.reflH = persp ? Math.round((cssH - bottom) * P.REFLECTION_FRACTION) : 0;
    this.strikeY = cssH - bottom - this.keyboardHeight - this.handRoom - this.reflH;
    this.persp = persp ? P.makePerspective(cssW, 0, this.strikeY) : null;
  }

  /** Draw one frame at the given transport time (seconds). */
  draw(currentTime: number): void {
    const { ctx, cssW, cssH } = this;
    if (this.opts.showHands !== this.laidOutHands || this.opts.viewStyle !== this.laidOutStyle) this.layout();
    const now = performance.now() / 1000;
    const dt = this.lastWall ? Math.min(now - this.lastWall, 0.05) : 0;
    this.lastWall = now;

    // Warm ebony wash, darker at the top.
    const bgGrad = ctx.createLinearGradient(0, 0, 0, cssH);
    bgGrad.addColorStop(0, COLORS.bgTop);
    bgGrad.addColorStop(1, COLORS.bg);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, cssW, cssH);

    // Candlelight pooling just above the keys.
    const pool = ctx.createRadialGradient(
      cssW / 2,
      this.strikeY,
      0,
      cssW / 2,
      this.strikeY,
      Math.max(cssW, cssH) * 0.5,
    );
    pool.addColorStop(0, COLORS.glow);
    pool.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, cssW, this.strikeY);
    if (this.persp) P.drawVanishingGlow(ctx, this.persp, cssW);

    this.drawOctaveGuides();

    if (this.opts.showHands && this.song?.notes.length && !this.hands) this.hands = new HandAnimator(this.song.notes);
    const active = this.song ? this.drawFallingNotes(currentTime) : new Map<number, Lit>();

    // Spawn a burst for any key that just became active this frame.
    if (this.opts.impacts) {
      for (const [midi, { hand }] of active) {
        if (!this.prevActive.has(midi)) this.spawnImpact(midi, hand);
      }
    }
    this.prevActive = new Set(active.keys());

    this.drawStrikeLine();
    if (this.opts.impacts) this.updateAndDrawParticles(dt);
    this.drawKeyboard(active);
    if (this.opts.showHands) this.drawHandLayer(currentTime);
    if (this.persp) {
      const floor = this.strikeY + this.keyboardHeight + this.handRoom;
      P.drawReflection(ctx, this.canvas, this.dpr, cssW, this.strikeY, floor - this.strikeY, floor, this.reflH, COLORS.bgTop);
    }
  }

  private drawHandLayer(currentTime: number): void {
    const { ctx, cssW } = this;
    const top = this.strikeY + this.keyboardHeight;
    ctx.fillStyle = COLORS.bgTop;
    ctx.fillRect(0, top, cssW, this.cssH - top);
    if (!this.song || !this.song.notes.length || !this.hands) return;
    const x0 = this.keys[0].x;
    const u0 = keyU(this.keys[0].midi) - 0.5;
    const ww = this.whiteW;
    const g: HandGeometry = {
      uToX: (u) => x0 + (u - u0) * ww,
      whiteW: ww,
      minUnit: MIN_HAND_UNIT,
      strikeY: this.strikeY,
      kbH: this.keyboardHeight,
      blackH: this.keyboardHeight * 0.62,
      pixelRatio: this.dpr,
      // The control bar overlays the canvas below the hand room: the wrists fade out above it.
      floorY: this.strikeY + this.keyboardHeight + this.handRoom,
    };
    drawHands(ctx, this.hands, currentTime, g, { left: this.opts.showLeft, right: this.opts.showRight });
  }

  private spawnImpact(midi: number, hand: Hand): void {
    const key = this.keyByMidi.get(midi);
    if (!key) return;
    const color = noteColor(hand, false);
    const count = 7;
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const speed = 40 + Math.random() * 90;
      this.particles.push({
        x: key.cx,
        y: this.strikeY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.5 + Math.random() * 0.3,
        maxLife: 0.8,
        color,
      });
    }
  }

  private updateAndDrawParticles(dt: number): void {
    const { ctx } = this;
    const next: Particle[] = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy += 220 * dt; // gravity
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      next.push(p);

      const alpha = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      const size = 1 + alpha * 2.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.particles = next;
  }

  private drawOctaveGuides(): void {
    const { ctx } = this;
    if (this.persp) {
      const xs = this.keys.filter((k) => !k.black && k.midi % 12 === 0).map((k) => Math.round(k.x) + 0.5);
      P.drawLaneGuides(ctx, this.persp, xs, 'rgba(194,162,74,0.16)', 1);
      return;
    }
    ctx.strokeStyle = COLORS.guide;
    ctx.lineWidth = 1;
    for (const key of this.keys) {
      if (!key.black && key.midi % 12 === 0) {
        // Each C — draw a faint vertical guide.
        ctx.beginPath();
        ctx.moveTo(Math.round(key.x) + 0.5, 0);
        ctx.lineTo(Math.round(key.x) + 0.5, this.strikeY);
        ctx.stroke();
      }
    }
  }

  private drawFallingNotes(currentTime: number): Map<number, Lit> {
    const { ctx } = this;
    const notes = this.song!.notes;
    const pps = this.opts.pixelsPerSecond;
    const active = new Map<number, Lit>();
    // With hands shown, a note's tail after its finger lets go is drawn as held by the pedal.
    const hands = this.opts.showHands ? this.hands : null;

    const persp = this.persp;
    const visibleAhead = (persp ? P.maxDist(persp) : this.strikeY) / pps; // seconds of lookahead on screen
    const maxLookback = 12; // seconds — covers long sustained notes

    // Binary search: first note with startTime >= currentTime - maxLookback.
    let start = this.lowerBound(notes, currentTime - maxLookback);

    for (let i = start; i < notes.length; i++) {
      const n = notes[i];
      if (n.startTime > currentTime + visibleAhead) break; // nothing further is on screen

      // Show/hide follows the hand that plays the note (the hands may re-split it).
      const shown = hands ? hands.handOf(i) : n.hand;
      if (shown === 'left' && !this.opts.showLeft) continue;
      if ((shown === 'right' || shown === 'unknown') && !this.opts.showRight) continue;

      const key = this.keyByMidi.get(n.midi);
      if (!key) continue;

      const bottomY = this.strikeY - (n.startTime - currentTime) * pps;
      const height = Math.max(n.duration * pps, 3);
      const topY = bottomY - height;
      if (topY > this.strikeY || (!persp && bottomY < 0)) continue;

      const end = n.startTime + n.duration;
      const sus = hands ? hands.sustainFrom(i) : Infinity;
      // The bar takes the colour of the hand that plays it (the hands may re-split a note).
      const hand = hands ? hands.handOf(i) : n.hand;
      // Note is being played when the strike line is within its span.
      // Only a key with its finger on it lights up. Once just the pedal holds the note the key
      // looks unpressed (a lit key with no finger on it reads as the wrong hand); the bar's
      // hollow tail shows that it still sounds. In a play-along session (litFilter set) a key
      // lights only once the player has hit it.
      const lit = currentTime >= n.startTime && currentTime <= (hands ? hands.litEnd(i) : end) && currentTime < sus;
      if (lit && !active.has(n.midi) && (!this.litFilter || this.litFilter(i))) active.set(n.midi, { hand });

      const black = isBlackKey(n.midi);
      const w = key.w * (black ? 1 : 0.9);
      const x = key.cx - w / 2;
      if (persp) {
        this.drawPerspectiveBar(persp, n.startTime - currentTime, n.duration, sus - currentTime, sus >= end, x, w, hand, black);
        continue;
      }
      const drawTop = Math.max(topY, 0);
      const drawBottom = Math.min(bottomY, this.strikeY);
      if (drawBottom - drawTop <= 0) continue;
      // Hollow from where the finger lets go (the pedal holds the rest).
      const susY = sus < end ? Math.max(drawTop, Math.min(drawBottom, this.strikeY - (sus - currentTime) * pps)) : drawTop;
      if (susY > drawTop) {
        const rgb = handRgb(hand);
        ctx.fillStyle = `rgba(${rgb},0.2)`;
        this.roundRect(x, drawTop, w, susY - drawTop, 5);
        ctx.fill();
        ctx.strokeStyle = `rgba(${rgb},0.9)`;
        ctx.lineWidth = 1.5;
        this.roundRect(x + 0.75, drawTop + 0.75, w - 1.5, susY - drawTop - 1.5, 5);
        ctx.stroke();
      }
      const drawH = drawBottom - susY;
      if (drawH <= 0) continue;

      const fill = noteColor(hand, black);
      if (this.opts.glow) {
        ctx.shadowColor = fill;
        ctx.shadowBlur = 5;
      }
      ctx.fillStyle = fill;
      this.roundRect(x, susY, w, drawH, 5);
      ctx.fill();
      ctx.shadowBlur = 0;

      // 1px darker border for definition.
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      this.roundRect(x + 0.5, susY + 0.5, w - 1, drawH - 1, 5);
      ctx.stroke();
    }

    return active;
  }

  /** One note bar in the perspective view: the same colours, projected toward the vanishing point. */
  private drawPerspectiveBar(
    p: P.Perspective,
    ahead: number,
    duration: number,
    susAhead: number,
    noSus: boolean,
    x: number,
    w: number,
    hand: Hand,
    black: boolean,
  ): void {
    const { ctx } = this;
    const pps = this.opts.pixelsPerSecond;
    const far = P.maxDist(p);
    const dNear = Math.max(0, ahead * pps);
    const dFar = Math.min(far, ahead * pps + Math.max(duration * pps, 3));
    if (dFar <= dNear) return;
    // Hollow from where the finger lets go (the pedal holds the rest).
    const dSus = noSus ? dFar : Math.max(dNear, Math.min(dFar, susAhead * pps));
    if (dSus < dFar) {
      const rgb = handRgb(hand);
      P.traceBar(ctx, p, x, x + w, dSus, dFar);
      ctx.fillStyle = `rgba(${rgb},0.2)`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${rgb},0.9)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (dSus <= dNear) return;
    const fill = noteColor(hand, black);
    P.traceBar(ctx, p, x, x + w, dNear, dSus);
    if (this.opts.glow) {
      ctx.shadowColor = fill;
      ctx.shadowBlur = 5;
    }
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawStrikeLine(): void {
    const { ctx, cssW, strikeY } = this;
    const grad = ctx.createLinearGradient(0, strikeY - 8, 0, strikeY);
    grad.addColorStop(0, 'rgba(214,190,120,0)');
    grad.addColorStop(1, 'rgba(214,190,120,0.16)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, strikeY - 8, cssW, 8);

    ctx.strokeStyle = COLORS.strike;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, strikeY);
    ctx.lineTo(cssW, strikeY);
    ctx.stroke();
  }

  private drawKeyboard(active: Map<number, Lit>): void {
    const { ctx, cssW, strikeY, keyboardHeight } = this;
    const now = performance.now();

    // Ivory white keys with a soft top-to-bottom shade.
    for (const key of this.keys) {
      if (key.black) continue;
      const lit = active.get(key.midi);
      const hand = lit?.hand;
      const flashed = (this.flashes.get(key.midi) ?? 0) > now;
      const wrong = (this.wrongs.get(key.midi) ?? 0) > now;
      if (wrong) {
        ctx.fillStyle = COLORS.wrong;
        ctx.fillRect(key.x, strikeY, key.w, keyboardHeight);
      } else if (hand) {
        ctx.fillStyle = noteColor(hand, false);
        ctx.fillRect(key.x, strikeY, key.w, keyboardHeight);
      } else if (flashed) {
        ctx.fillStyle = COLORS.press;
        ctx.fillRect(key.x, strikeY, key.w, keyboardHeight);
      } else {
        const g = ctx.createLinearGradient(0, strikeY, 0, strikeY + keyboardHeight);
        g.addColorStop(0, COLORS.whiteKey);
        g.addColorStop(1, COLORS.whiteKeyLo);
        ctx.fillStyle = g;
        ctx.fillRect(key.x, strikeY, key.w, keyboardHeight);
      }
      ctx.strokeStyle = COLORS.keyBorder;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(key.x) + 0.5, strikeY, key.w, keyboardHeight);
      if (this.expected.has(key.midi)) this.drawExpected(key.x, strikeY, key.w, keyboardHeight, 4);
    }

    // Burgundy felt strip running along the top of the keys.
    ctx.fillStyle = COLORS.felt;
    ctx.fillRect(0, strikeY, cssW, 3);

    // Ebony black keys with a faint brass sheen along the top.
    const blackH = keyboardHeight * 0.62;
    for (const key of this.keys) {
      if (!key.black) continue;
      const lit = active.get(key.midi);
      const hand = lit?.hand;
      const flashed = (this.flashes.get(key.midi) ?? 0) > now;
      const wrong = (this.wrongs.get(key.midi) ?? 0) > now;
      ctx.fillStyle = wrong ? COLORS.wrong : hand ? noteColor(hand, true) : flashed ? COLORS.press : COLORS.blackKey;
      this.roundRect(key.x, strikeY, key.w, blackH, 3);
      ctx.fill();
      if (wrong) {
        /* plain red */
      } else if (!hand && !flashed) {
        ctx.fillStyle = COLORS.blackKeySheen;
        this.roundRect(key.x + 1, strikeY + 1, key.w - 2, blackH * 0.18, 2);
        ctx.fill();
      }
      ctx.strokeStyle = COLORS.keyBorder;
      ctx.lineWidth = 1;
      this.roundRect(key.x, strikeY, key.w, blackH, 3);
      ctx.stroke();
      if (this.expected.has(key.midi)) this.drawExpected(key.x, strikeY, key.w, blackH, 3);
    }
  }

  /** Pulsing outline on a key the player needs to press (wait-mode). */
  private drawExpected(x: number, y: number, w: number, h: number, r: number): void {
    const { ctx } = this;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
    ctx.save();
    ctx.strokeStyle = `rgba(167, 184, 106, ${0.6 + 0.4 * pulse})`;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = 'rgba(167, 184, 106, 0.85)';
    ctx.shadowBlur = 7 + 7 * pulse;
    this.roundRect(x + 1.5, y + 1.5, w - 3, h - 3, r);
    ctx.stroke();
    ctx.restore();
  }

  /** First index with notes[i].startTime >= t (binary search). */
  private lowerBound(notes: NoteEvent[], t: number): number {
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].startTime < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const rad = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }
}
