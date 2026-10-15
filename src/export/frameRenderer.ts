import type { Hand, NoteEvent, Song } from '../types';
import { computeKeyboard, indexKeys, isBlackKey, keyboardRange, type KeyGeometry } from '../render/keyboard';
import { COLORS, noteColor } from '../render/Renderer';
import type { VideoPicture } from './videoSource';
import { HandAnimator } from '../hands/handPose';
import { drawHands, type HandGeometry } from '../hands/drawHands';
import { keyU } from '../hands/fingering';
import type { SessionTrack } from '../interactive/recording';

/** 'full' = falling notes fill the frame; 'video' = source video on top, notes below. */
export type ExportLayout = 'full' | 'video';

export const EXPORT_W = 1080;
export const EXPORT_H = 1920;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const DISPLAY = "'Fraunces', Georgia, 'Times New Roman', serif";
const INK = '#14110d';
const IVORY = '#f1e7d0';
/** Hands never shrink below this many px per white key, however wide the zoom. */
const MIN_HAND_UNIT = 34;
// Play-along sessions
const WRONG = '#c4473f'; // a wrong key's red
const WRONG_RGB = '196,71,63';
const WAIT_RGB = '167,184,106'; // the green of a key the song is waiting on (as in the app)
const WRONG_FLASH = 0.3; // s a wrong key stays red
const BURST_S = 0.5; // s a hit's little burst lasts

/** A key that is lit (a finger is on it), and by which hand. */
interface Lit {
  hand: Hand;
}

export function handRgb(hand: Hand): string {
  return hand === 'left' ? '95,138,150' : '211,154,82';
}

export function noteName(midi: number): string {
  return NAMES[((midi % 12) + 12) % 12];
}

export { keyboardRange } from '../render/keyboard';

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
    /** A play-along session: frames follow its timeline (waits, hits, wrong keys, score). */
    private session: SessionTrack | null = null,
    /** The source video's upright height / width, when known ('video' layout only). */
    videoAspect?: number,
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
    const handUnit = Math.max(this.whiteW, MIN_HAND_UNIT);
    this.videoH = layout === 'video' ? videoBandHeight(videoAspect) : 0;
    this.notesTop = this.videoH;
    const kbMin = layout === 'video' ? 150 : 200;
    const kbMax = layout === 'video' ? 240 : 340;
    this.kbH = Math.round(Math.max(kbMin, Math.min(kbMax, this.whiteW * 5)));
    this.footerTop = EXPORT_H - footer;
    // Room under the keys for the palms (fingers lie on the keys, wrists below them).
    const handRoom = showHands ? Math.round(Math.min(EXPORT_H * 0.12, handUnit * 3.6)) : 0;
    this.handRoomTop = this.footerTop - handRoom;
    this.strikeY = this.handRoomTop - this.kbH;
    if (showHands && song.notes.length) {
      // Notes off the zoomed keyboard (stray transcription notes) aren't played by the hands.
      this.hands = new HandAnimator(song.notes, { skip: (i) => !this.keyByMidi.has(song.notes[i].midi) });
      const u0 = keyU(lo) - 0.5;
      const ww = this.whiteW;
      this.handGeom = {
        uToX: (u) => (u - u0) * ww,
        whiteW: ww,
        minUnit: MIN_HAND_UNIT,
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

    // In a play-along session, t is video time; the song stands still while it waits.
    const s = this.session;
    const songT = s ? s.songAt(t) : t;
    this.drawOctaveGuides();
    const due = new Set<number>();
    const active = this.drawNotes(songT, t, due);
    this.drawStrike(active);
    if (s) this.drawBursts(t);
    this.drawKeyboard(active, t, due);
    this.drawFooter();
    if (this.hands && this.handGeom) {
      // Life-size wrists run past the hand room: they slip under the footer's edge.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, EXPORT_W, this.footerTop);
      ctx.clip();
      drawHands(ctx, this.hands, songT, this.handGeom);
      ctx.restore();
    }
    if (s && t >= s.cardFrom) this.drawScoreCard(t - s.cardFrom);
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

  private drawNotes(t: number, v: number, due: Set<number>): Map<number, Lit> {
    const { ctx, pps } = this;
    const s = this.session;
    const notes = this.notes;
    const active = new Map<number, Lit>();
    const ahead = (this.strikeY - this.notesTop) / pps;
    const radius = Math.min(10, this.whiteW * 0.2);

    for (let i = lowerBound(notes, t - 30); i < notes.length; i++) {
      const n = notes[i];
      if (n.startTime > t + ahead) break;
      // The bar takes the colour of the hand that plays it (the hands may re-split a note).
      const hand = this.hands ? this.hands.handOf(i) : n.hand;
      const end = n.startTime + n.duration;
      if (end < t) continue;
      const key = this.keyByMidi.get(n.midi);
      const bottomY = this.strikeY - (n.startTime - t) * pps;
      const topY = bottomY - Math.max(n.duration * pps, 6);
      const drawTop = Math.max(topY, this.notesTop);
      const drawBottom = Math.min(bottomY, this.strikeY);
      const h = drawBottom - drawTop;
      if (!key) {
        // A stray note off the zoomed keyboard: a thin sliver at that edge, so
        // nothing heard goes unshown, without widening the whole keyboard for it.
        if (h > 0) this.drawEdgeNote(n, drawTop, h);
        continue;
      }
      // From `sus` on, no finger is on the key: the pedal holds the note.
      const sus = this.hands ? this.hands.sustainFrom(i) : Infinity;
      // Only a key with its finger on it lights up. Once just the pedal holds the note the key
      // looks unpressed (a lit key with no finger on it reads as the wrong hand); the bar's
      // hollow tail shows that it still sounds.
      // Play along: a key lights only once the player has hit it; until then the song
      // waits on it and the key is outlined green.
      const hit = !s || s.hitAt[i] <= v;
      if (s && !hit && s.required[i] && Math.abs(n.startTime - t) < 0.03) due.add(n.midi);
      if (hit && t >= n.startTime && t < (this.hands ? this.hands.litEnd(i) : end) && t < sus && !active.has(n.midi)) active.set(n.midi, { hand });
      if (h <= 0) continue;

      const black = isBlackKey(n.midi);
      const w = black ? key.w : key.w * 0.86;
      const x = key.cx - w / 2;
      const fill = noteColor(hand, black);
      // The part of the bar after the finger lets go is drawn hollow (held by the pedal).
      const susY = sus < end ? Math.max(drawTop, Math.min(drawBottom, this.strikeY - (sus - t) * pps)) : drawTop;
      if (susY > drawTop) this.drawHeldTail(hand, x, drawTop, w, susY - drawTop + (susY < drawBottom ? radius : 0), radius);
      const sh = drawBottom - susY;
      if (sh > 0) {
        ctx.fillStyle = fill;
        roundRect(ctx, x, susY, w, sh, radius);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = 2;
        roundRect(ctx, x + 1, susY + 1, w - 2, sh - 2, radius);
        ctx.stroke();
        // Soft highlight down the left edge so bars read as solid, not flat stickers.
        ctx.fillStyle = 'rgba(255,240,210,0.16)';
        ctx.fillRect(x + 3, susY + 3, Math.max(2, w * 0.14), Math.max(0, sh - 6));
        this.drawLetter(n.midi, black, x, w, drawBottom, sh);
      } else if (bottomY <= this.strikeY) {
        // Not reachable by any finger at all: hollow from the start, still named.
        this.drawLetter(n.midi, black, x, w, drawBottom, drawBottom - drawTop, IVORY);
      }
    }
    return active;
  }

  /** A note's pedal-held stretch: a hollow outline in the hand colour over a faint wash. */
  private drawHeldTail(hand: Hand, x: number, y: number, w: number, h: number, radius: number): void {
    const { ctx } = this;
    const rgb = handRgb(hand);
    ctx.fillStyle = `rgba(${rgb},0.2)`;
    roundRect(ctx, x, y, w, h, radius);
    ctx.fill();
    ctx.strokeStyle = `rgba(${rgb},0.9)`;
    ctx.lineWidth = 3;
    roundRect(ctx, x + 1.5, y + 1.5, w - 3, h - 3, radius);
    ctx.stroke();
  }

  private drawEdgeNote(n: NoteEvent, top: number, h: number): void {
    const { ctx } = this;
    const w = Math.max(6, this.whiteW * 0.22);
    const x = n.midi < this.keys[0].midi ? 2 : EXPORT_W - w - 2;
    ctx.fillStyle = `rgba(${handRgb(n.hand)},0.6)`;
    roundRect(ctx, x, top, w, h, w / 2);
    ctx.fill();
  }

  /** The note's letter, printed at the leading (bottom) end of its bar. */
  private drawLetter(midi: number, black: boolean, x: number, w: number, bottom: number, h: number, color?: string): void {
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
    ctx.fillStyle = color ?? (black ? IVORY : INK);
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

  private drawStrike(active: Map<number, Lit>): void {
    const { ctx, strikeY } = this;
    // Light rising off every held key, in the hand's colour.
    for (const [midi, { hand }] of active) {
      const key = this.keyByMidi.get(midi);
      if (!key) continue;
      const g = ctx.createLinearGradient(0, strikeY - 70, 0, strikeY);
      const c = handRgb(hand);
      g.addColorStop(0, `rgba(${c},0)`);
      g.addColorStop(1, `rgba(${c},0.45)`);
      ctx.fillStyle = g;
      ctx.fillRect(key.cx - key.w, strikeY - 70, key.w * 2, 70);
    }
    ctx.fillStyle = COLORS.strike;
    ctx.fillRect(0, strikeY - 2, EXPORT_W, 3);
  }

  private drawKeyboard(active: Map<number, Lit>, v = 0, due: Set<number> = new Set()): void {
    const { ctx, strikeY, kbH } = this;
    const labelSize = Math.max(14, Math.min(26, this.whiteW * 0.42));
    const wrong = this.wrongAt(v);

    for (const key of this.keys) {
      if (key.black) continue;
      const lit = active.get(key.midi);
      const hand = lit?.hand;
      const red = wrong.get(key.midi);
      ctx.fillStyle = hand ? noteColor(hand, false) : this.whiteKeyGrad;
      ctx.fillRect(key.x, strikeY, key.w, kbH);
      if (red) {
        ctx.fillStyle = `rgba(${WRONG_RGB},${0.35 + 0.6 * red})`;
        ctx.fillRect(key.x, strikeY, key.w, kbH);
      }
      ctx.strokeStyle = COLORS.keyBorder;
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.round(key.x) + 1, strikeY, key.w, kbH);
      if (due.has(key.midi)) this.drawDue(key.x, strikeY, key.w, kbH, v);

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
      const lit = active.get(key.midi);
      const hand = lit?.hand;
      const red = wrong.get(key.midi);
      ctx.fillStyle = red ? WRONG : hand ? noteColor(hand, true) : COLORS.blackKey;
      roundRect(ctx, key.x, strikeY, key.w, blackH, 5);
      ctx.fill();
      if (red) {
        ctx.strokeStyle = COLORS.keyBorder;
        ctx.lineWidth = 2;
        roundRect(ctx, key.x, strikeY, key.w, blackH, 5);
        ctx.stroke();
        continue;
      }
      if (!hand) {
        ctx.fillStyle = 'rgba(216,190,120,0.14)';
        roundRect(ctx, key.x + 3, strikeY + 6, key.w - 6, blackH * 0.2, 3);
        ctx.fill();
      }
      ctx.strokeStyle = COLORS.keyBorder;
      ctx.lineWidth = 2;
      roundRect(ctx, key.x, strikeY, key.w, blackH, 5);
      ctx.stroke();
      if (due.has(key.midi)) this.drawDue(key.x, strikeY, key.w, blackH, v);
    }
  }

  /** Keys flashing red at video time v (wrong keys), with how strongly (1 → 0). */
  private wrongAt(v: number): Map<number, number> {
    const out = new Map<number, number>();
    const w = this.session?.wrong;
    if (!w) return out;
    for (const e of w) {
      if (e.v > v) break;
      const age = v - e.v;
      if (age < WRONG_FLASH) out.set(e.midi, Math.max(out.get(e.midi) ?? 0, 1 - age / WRONG_FLASH));
    }
    return out;
  }

  /** A key the song is waiting on: a pulsing green outline (as in the app). */
  private drawDue(x: number, y: number, w: number, h: number, v: number): void {
    const { ctx } = this;
    const pulse = 0.5 + 0.5 * Math.sin(v * 5.5);
    ctx.save();
    ctx.strokeStyle = `rgba(${WAIT_RGB},${0.65 + 0.35 * pulse})`;
    ctx.lineWidth = 5;
    ctx.shadowColor = `rgba(${WAIT_RGB},0.9)`;
    ctx.shadowBlur = 10 + 10 * pulse;
    roundRect(ctx, x + 3, y + 3, w - 6, h - 6, 6);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * A little burst of sparks off each key as it's hit, like the app's impact effect.
   * Drawn from the hit's time alone (seeded per hit), so every export is identical.
   */
  private drawBursts(v: number): void {
    const hits = this.session!.hits;
    const { ctx } = this;
    let i = hits.length;
    while (i > 0 && hits[i - 1].v > v) i--;
    for (let k = i - 1; k >= 0 && v - hits[k].v < BURST_S; k--) {
      const h = hits[k];
      const key = this.keyByMidi.get(h.midi);
      if (!key) continue;
      const age = v - h.v;
      const color = noteColor(h.hand, false);
      let seed = (h.midi * 7919 + Math.round(h.v * 1000)) >>> 0;
      const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      for (let p = 0; p < 9; p++) {
        const angle = -Math.PI / 2 + (rand() - 0.5) * 1.7;
        const speed = 160 + rand() * 260;
        const life = 0.35 + rand() * 0.15;
        if (age > life) continue;
        const x = key.cx + Math.cos(angle) * speed * age;
        const y = this.strikeY + Math.sin(angle) * speed * age + 0.5 * 700 * age * age;
        const a = 1 - age / life;
        ctx.globalAlpha = a;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 2.5 + a * 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** The score, over the last frame of the session (fades in over 0.4s). */
  private drawScoreCard(age: number): void {
    const { ctx } = this;
    const s = this.session!.score;
    const a = Math.min(1, age / 0.4);
    ctx.save();
    ctx.globalAlpha = a * 0.78;
    ctx.fillStyle = '#0b0907';
    ctx.fillRect(0, 0, EXPORT_W, EXPORT_H);
    ctx.globalAlpha = a;
    const cw = 820;
    const ch = 700;
    const x = (EXPORT_W - cw) / 2;
    const y = (EXPORT_H - ch) / 2 - 60;
    const g = ctx.createLinearGradient(0, y, 0, y + ch);
    g.addColorStop(0, '#3a2018');
    g.addColorStop(1, '#1d100c');
    ctx.fillStyle = g;
    roundRect(ctx, x, y, cw, ch, 36);
    ctx.fill();
    ctx.strokeStyle = 'rgba(216,190,120,0.55)';
    ctx.lineWidth = 3;
    roundRect(ctx, x + 1.5, y + 1.5, cw - 3, ch - 3, 36);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#c2a24a';
    ctx.font = `500 44px ${DISPLAY}`;
    ctx.fillText(this.song.name, EXPORT_W / 2, y + 100, cw - 80);
    ctx.fillStyle = 'rgba(241,231,208,0.7)';
    ctx.font = `500 34px ${DISPLAY}`;
    ctx.fillText(s.complete ? 'played through' : 'played along', EXPORT_W / 2, y + 152, cw - 80);

    ctx.fillStyle = IVORY;
    ctx.font = `600 190px ${DISPLAY}`;
    ctx.fillText(`${Math.round(s.accuracy * 100)}%`, EXPORT_W / 2, y + 370);
    ctx.fillStyle = '#d8be78';
    ctx.font = `500 40px ${DISPLAY}`;
    ctx.fillText('accuracy', EXPORT_W / 2, y + 425);

    ctx.fillStyle = 'rgba(216,190,120,0.35)';
    ctx.fillRect(x + 120, y + 470, cw - 240, 2);

    ctx.fillStyle = IVORY;
    ctx.font = `600 72px ${DISPLAY}`;
    ctx.fillText(String(s.bestStreak), EXPORT_W / 2 - 190, y + 575);
    ctx.fillText(`${s.clean}/${s.total}`, EXPORT_W / 2 + 190, y + 575, 340);
    ctx.fillStyle = '#d8be78';
    ctx.font = `500 32px ${DISPLAY}`;
    ctx.fillText('best streak', EXPORT_W / 2 - 190, y + 625);
    ctx.fillText('clean notes', EXPORT_W / 2 + 190, y + 625);
    ctx.restore();
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

/**
 * Height of the top band for the original video. A wide (landscape) recording gets
 * a band of its own shape, so the whole keyboard shows with no side crop; a tall
 * (portrait) one is capped at half the frame and cropped top/bottom instead, like
 * the hand-made comparison. Unknown shape: half the frame.
 */
export function videoBandHeight(aspect?: number): number {
  if (!aspect || !Number.isFinite(aspect) || aspect <= 0) return EXPORT_H / 2;
  const h = Math.min(EXPORT_H / 2, Math.max(EXPORT_H * 0.28, EXPORT_W * aspect));
  return Math.round(h / 2) * 2;
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
