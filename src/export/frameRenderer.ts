import type { Hand, NoteEvent, Song } from '../types';
import { MIN_MIDI, MAX_MIDI } from '../types';
import { computeKeyboard, indexKeys, isBlackKey, type KeyGeometry } from '../render/keyboard';
import { COLORS, noteColor } from '../render/Renderer';
import type { VideoPicture } from './videoSource';
import { HandAnimator } from '../hands/handPose';
import { drawHands, type HandGeometry } from '../hands/drawHands';
import { keyU } from '../hands/fingering';

/** 'full' = falling notes fill the frame; 'video' = source video on top, notes below. */
export type ExportLayout = 'full' | 'video';

export const EXPORT_W = 1080;
export const EXPORT_H = 1920;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const DISPLAY = "'Fraunces', Georgia, 'Times New Roman', serif";
const INK = '#14110d';
const IVORY = '#f1e7d0';

export function noteName(midi: number): string {
  return NAMES[((midi % 12) + 12) % 12];
}

/** The song's pitch range plus a little margin, snapped to white keys, at least ~2 octaves. */
export function keyboardRange(notes: NoteEvent[]): { lo: number; hi: number } {
  if (!notes.length) return { lo: 48, hi: 84 };
  let lo = MAX_MIDI;
  let hi = MIN_MIDI;
  for (const n of notes) {
    if (n.midi < lo) lo = n.midi;
    if (n.midi > hi) hi = n.midi;
  }
  lo = Math.max(MIN_MIDI, lo - 2);
  hi = Math.min(MAX_MIDI, hi + 2);
  // Too narrow a range makes comically wide keys — widen around the centre.
  while (hi - lo < 24) {
    if (lo > MIN_MIDI) lo--;
    if (hi < MAX_MIDI) hi++;
    if (lo === MIN_MIDI && hi === MAX_MIDI) break;
  }
  while (lo > MIN_MIDI && isBlackKey(lo)) lo--;
  while (hi < MAX_MIDI && isBlackKey(hi)) hi++;
  return { lo, hi };
}

/**
 * Deterministic 1080x1920 frame painter for video export. Unlike the live
 * Renderer it has no wall clock at all: a frame is a pure function of
 * (song, time, video frame), so every export of a song is identical.
 */
export class ExportFrameRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private notes: NoteEvent[];
  private keys: KeyGeometry[];
  private keyByMidi: Map<number, KeyGeometry>;
  private whiteW: number;

  private videoH: number; // height of the source-video band (0 in 'full')
  private notesTop: number;
  private strikeY: number;
  private kbH: number;
  private footerTop: number;
  private pps: number; // pixels per second of fall
  private bgGrad: CanvasGradient;
  private pool: CanvasGradient;
  private whiteKeyGrad: CanvasGradient;
  private hands: HandAnimator | null = null;
  private handGeom: HandGeometry | null = null;
  private handRoomTop: number;

  constructor(
    private song: Song,
    private layout: ExportLayout,
    showHands = true,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = EXPORT_W;
    this.canvas.height = EXPORT_H;
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not create a drawing surface for the video.');
    this.ctx = ctx;
    this.notes = song.notes;

    const { lo, hi } = keyboardRange(song.notes);
    const kb = computeKeyboard(EXPORT_W, lo, hi);
    this.keys = kb.keys;
    this.keyByMidi = indexKeys(kb.keys);
    this.whiteW = kb.whiteWidth;

    const footer = 84;
    this.videoH = layout === 'video' ? EXPORT_H / 2 : 0;
    this.notesTop = this.videoH;
    const kbMin = layout === 'video' ? 150 : 200;
    const kbMax = layout === 'video' ? 240 : 340;
    this.kbH = Math.round(Math.max(kbMin, Math.min(kbMax, this.whiteW * 5)));
    this.footerTop = EXPORT_H - footer;
    // Room under the keys for the palms (fingers lie on the keys, wrists below them).
    const handRoom = showHands ? Math.round(Math.min(EXPORT_H * 0.12, this.whiteW * 3.6)) : 0;
    this.handRoomTop = this.footerTop - handRoom;
    this.strikeY = this.handRoomTop - this.kbH;
    if (showHands && song.notes.length) {
      this.hands = new HandAnimator(song.notes);
      const u0 = keyU(lo) - 0.5;
      const ww = this.whiteW;
      this.handGeom = {
        uToX: (u) => (u - u0) * ww,
        whiteW: ww,
        strikeY: this.strikeY,
        kbH: this.kbH,
        blackH: this.kbH * 0.62,
      };
    }
    // How many seconds of music are visible above the keys.
    const lookahead = layout === 'video' ? 2.4 : 3.2;
    this.pps = (this.strikeY - this.notesTop) / lookahead;

    this.bgGrad = ctx.createLinearGradient(0, this.notesTop, 0, this.strikeY);
    this.bgGrad.addColorStop(0, COLORS.bgTop);
    this.bgGrad.addColorStop(1, COLORS.bg);
    this.pool = ctx.createRadialGradient(
      EXPORT_W / 2,
      this.strikeY,
      0,
      EXPORT_W / 2,
      this.strikeY,
      EXPORT_W * 0.8,
    );
    this.pool.addColorStop(0, COLORS.glow);
    this.pool.addColorStop(1, 'rgba(0,0,0,0)');
    this.whiteKeyGrad = ctx.createLinearGradient(0, this.strikeY, 0, this.strikeY + this.kbH);
    this.whiteKeyGrad.addColorStop(0, COLORS.whiteKey);
    this.whiteKeyGrad.addColorStop(1, COLORS.whiteKeyLo);
  }

  /** Paint the frame for song time t. `video` is drawn into the top half in 'video' layout. */
  draw(t: number, video?: VideoPicture | null): void {
    const { ctx } = this;
    if (this.layout === 'video') this.drawVideo(video);

    ctx.fillStyle = this.bgGrad;
    ctx.fillRect(0, this.notesTop, EXPORT_W, this.strikeY - this.notesTop);
    ctx.fillStyle = this.pool;
    ctx.fillRect(0, this.notesTop, EXPORT_W, this.strikeY - this.notesTop);

    this.drawOctaveGuides();
    const active = this.drawNotes(t);
    this.drawStrike(active);
    this.drawKeyboard(active);
    this.drawFooter();
    if (this.hands && this.handGeom) drawHands(ctx, this.hands, t, this.handGeom);
  }

  private drawVideo(video?: VideoPicture | null): void {
    const { ctx } = this;
    const h = this.videoH;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, EXPORT_W, h);
    if (video && video.width > 0 && video.height > 0) {
      // Upright size after the file's rotation (iPhone portrait clips are stored sideways).
      const sideways = video.rotation === 90 || video.rotation === 270;
      const uw = sideways ? video.height : video.width;
      const uh = sideways ? video.width : video.height;
      // Cover: fill the band, crop the overflow evenly (like the reference reels).
      const scale = Math.max(EXPORT_W / uw, h / uh);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, EXPORT_W, h);
      ctx.clip();
      ctx.translate(EXPORT_W / 2, h / 2);
      ctx.rotate((video.rotation * Math.PI) / 180);
      ctx.scale(scale, scale);
      ctx.drawImage(video.image, -video.width / 2, -video.height / 2, video.width, video.height);
      ctx.restore();
    }
    // Brass hairline between the two halves.
    ctx.fillStyle = COLORS.strike;
    ctx.fillRect(0, h - 2, EXPORT_W, 2);
  }

  private drawOctaveGuides(): void {
    const { ctx } = this;
    ctx.strokeStyle = 'rgba(194,162,74,0.13)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const key of this.keys) {
      if (!key.black && key.midi % 12 === 0) {
        const x = Math.round(key.x) + 1;
        ctx.moveTo(x, this.notesTop);
        ctx.lineTo(x, this.strikeY);
      }
    }
    ctx.stroke();
  }

  private drawNotes(t: number): Map<number, Hand> {
    const { ctx, pps } = this;
    const notes = this.notes;
    const active = new Map<number, Hand>();
    const ahead = (this.strikeY - this.notesTop) / pps;
    const radius = Math.min(10, this.whiteW * 0.2);

    for (let i = lowerBound(notes, t - 30); i < notes.length; i++) {
      const n = notes[i];
      if (n.startTime > t + ahead) break;
      const end = n.startTime + n.duration;
      if (end < t) continue;
      const key = this.keyByMidi.get(n.midi);
      if (!key) continue;
      if (t >= n.startTime && t < end) active.set(n.midi, n.hand);

      const bottomY = this.strikeY - (n.startTime - t) * pps;
      const topY = bottomY - Math.max(n.duration * pps, 6);
      const drawTop = Math.max(topY, this.notesTop);
      const drawBottom = Math.min(bottomY, this.strikeY);
      const h = drawBottom - drawTop;
      if (h <= 0) continue;

      const black = isBlackKey(n.midi);
      const w = black ? key.w : key.w * 0.86;
      const x = key.cx - w / 2;
      const fill = noteColor(n.hand, black);
      ctx.fillStyle = fill;
      roundRect(ctx, x, drawTop, w, h, radius);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 2;
      roundRect(ctx, x + 1, drawTop + 1, w - 2, h - 2, radius);
      ctx.stroke();
      // Soft highlight down the left edge so bars read as solid, not flat stickers.
      ctx.fillStyle = 'rgba(255,240,210,0.16)';
      ctx.fillRect(x + 3, drawTop + 3, Math.max(2, w * 0.14), Math.max(0, h - 6));

      this.drawLetter(n.midi, black, x, w, drawBottom, h);
    }
    return active;
  }

  /** The note's letter, printed at the leading (bottom) end of its bar. */
  private drawLetter(midi: number, black: boolean, x: number, w: number, bottom: number, h: number): void {
    const { ctx } = this;
    const letter = noteName(midi)[0];
    const sharp = black;
    // Black-key bars are narrow, so a sharp is stacked: the letter, then a small ♯ below it.
    const size = Math.min(36, Math.max(16, w * (sharp ? 0.9 : 0.72)));
    const sharpSize = Math.round(size * 0.8);
    const need = size + 8 + (sharp ? sharpSize : 0);
    if (h < need) return; // too short to hold a legible letter
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = black ? IVORY : INK;
    const cx = x + w / 2;
    let base = bottom - Math.max(6, size * 0.3);
    if (sharp) {
      ctx.font = `700 ${sharpSize}px ${DISPLAY}`;
      ctx.fillText('#', cx, base, w - 2);
      base -= sharpSize + 1;
    }
    ctx.font = `600 ${size}px ${DISPLAY}`;
    ctx.fillText(letter, cx, base, w - 2);
  }

  private drawStrike(active: Map<number, Hand>): void {
    const { ctx, strikeY } = this;
    // Light rising off every held key, in the hand's colour.
    for (const [midi, hand] of active) {
      const key = this.keyByMidi.get(midi);
      if (!key) continue;
      const g = ctx.createLinearGradient(0, strikeY - 70, 0, strikeY);
      const c = hand === 'left' ? '95,138,150' : '211,154,82';
      g.addColorStop(0, `rgba(${c},0)`);
      g.addColorStop(1, `rgba(${c},0.45)`);
      ctx.fillStyle = g;
      ctx.fillRect(key.cx - key.w, strikeY - 70, key.w * 2, 70);
    }
    ctx.fillStyle = COLORS.strike;
    ctx.fillRect(0, strikeY - 2, EXPORT_W, 3);
  }

  private drawKeyboard(active: Map<number, Hand>): void {
    const { ctx, strikeY, kbH } = this;
    const labelSize = Math.max(14, Math.min(26, this.whiteW * 0.42));

    for (const key of this.keys) {
      if (key.black) continue;
      const hand = active.get(key.midi);
      ctx.fillStyle = hand ? noteColor(hand, false) : this.whiteKeyGrad;
      ctx.fillRect(key.x, strikeY, key.w, kbH);
      ctx.strokeStyle = COLORS.keyBorder;
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.round(key.x) + 1, strikeY, key.w, kbH);

      // Letter on each white key; C also gets its octave number so you can find your place.
      const isC = key.midi % 12 === 0;
      ctx.font = `${isC ? 700 : 500} ${labelSize}px ${DISPLAY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = hand ? INK : isC ? '#7a2f33' : 'rgba(60,48,30,0.55)';
      const label = isC ? `C${Math.floor(key.midi / 12) - 1}` : noteName(key.midi);
      ctx.fillText(label, key.cx, strikeY + kbH - labelSize * 0.6, key.w - 4);
    }

    ctx.fillStyle = COLORS.felt;
    ctx.fillRect(0, strikeY, EXPORT_W, 6);

    const blackH = kbH * 0.62;
    for (const key of this.keys) {
      if (!key.black) continue;
      const hand = active.get(key.midi);
      ctx.fillStyle = hand ? noteColor(hand, true) : COLORS.blackKey;
      roundRect(ctx, key.x, strikeY, key.w, blackH, 5);
      ctx.fill();
      if (!hand) {
        ctx.fillStyle = 'rgba(216,190,120,0.14)';
        roundRect(ctx, key.x + 3, strikeY + 6, key.w - 6, blackH * 0.2, 3);
        ctx.fill();
      }
      ctx.strokeStyle = COLORS.keyBorder;
      ctx.lineWidth = 2;
      roundRect(ctx, key.x, strikeY, key.w, blackH, 5);
      ctx.stroke();
    }
  }

  private drawFooter(): void {
    const { ctx } = this;
    if (this.handRoomTop < this.footerTop) {
      ctx.fillStyle = COLORS.bgTop;
      ctx.fillRect(0, this.handRoomTop, EXPORT_W, this.footerTop - this.handRoomTop);
    }
    const top = this.footerTop;
    const h = EXPORT_H - top;
    ctx.fillStyle = '#0f0c09';
    ctx.fillRect(0, top, EXPORT_W, h);
    ctx.fillStyle = COLORS.felt;
    ctx.fillRect(0, top, EXPORT_W, 4);
    ctx.font = `500 34px ${DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#c2a24a';
    ctx.fillText(this.song.name, EXPORT_W / 2, top + h / 2 + 2, EXPORT_W - 80);
  }
}

function lowerBound(notes: NoteEvent[], t: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].startTime < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
