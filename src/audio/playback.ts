import * as Tone from 'tone';
import type { NoteEvent, Song } from '../types';

const SALAMANDER = 'https://tonejs.github.io/audio/salamander/';

// A sparse sample map across the range; the Sampler pitches between them.
const SAMPLE_URLS: Record<string, string> = {
  A0: 'A0.mp3', C1: 'C1.mp3', 'D#1': 'Ds1.mp3', 'F#1': 'Fs1.mp3',
  A1: 'A1.mp3', C2: 'C2.mp3', 'D#2': 'Ds2.mp3', 'F#2': 'Fs2.mp3',
  A2: 'A2.mp3', C3: 'C3.mp3', 'D#3': 'Ds3.mp3', 'F#3': 'Fs3.mp3',
  A3: 'A3.mp3', C4: 'C4.mp3', 'D#4': 'Ds4.mp3', 'F#4': 'Fs4.mp3',
  A4: 'A4.mp3', C5: 'C5.mp3', 'D#5': 'Ds5.mp3', 'F#5': 'Fs5.mp3',
  A5: 'A5.mp3', C6: 'C6.mp3', 'D#6': 'Ds6.mp3', 'F#6': 'Fs6.mp3',
  A6: 'A6.mp3', C7: 'C7.mp3', 'D#7': 'Ds7.mp3', 'F#7': 'Fs7.mp3',
  A7: 'A7.mp3', C8: 'C8.mp3',
};

const CHORD_EPS = 0.04; // notes within 40ms count as one chord/gate

/**
 * Drives audio off a single "song clock" that the renderer also reads, so the
 * picture and the sound can never drift. Speed changes scale the clock — sample
 * pitch is untouched (each note is just a sample triggered at its own pitch).
 */
export class PlaybackEngine {
  private sampler: Tone.Sampler | null = null;
  private song: Song | null = null;

  private _songTime = 0;
  private _rate = 1;
  private _playing = false;
  private lastWall = 0;
  private cursor = 0; // index of next note to trigger

  muteLeft = false;
  muteRight = false;

  // ---- A–B loop ----
  loopA: number | null = null;
  loopB: number | null = null;

  // ---- practice / wait mode ----
  practice = false;
  private _waiting = false;
  private expected = new Set<number>();
  private satisfied = new Set<number>();

  loaded = false;

  async init(): Promise<void> {
    if (this.sampler) return;
    await new Promise<void>((resolve) => {
      this.sampler = new Tone.Sampler({
        urls: SAMPLE_URLS,
        baseUrl: SALAMANDER,
        release: 1,
        onload: () => {
          this.loaded = true;
          resolve();
        },
      }).toDestination();
    });
  }

  setSong(song: Song | null): void {
    this.song = song;
    this.loopA = null;
    this.loopB = null;
    this.seek(0);
  }

  get songTime(): number {
    return this._songTime;
  }
  get playing(): boolean {
    return this._playing;
  }
  get rate(): number {
    return this._rate;
  }
  get waiting(): boolean {
    return this._waiting;
  }
  /** Midis the player still needs to press to release the current gate. */
  expectedMidis(): number[] {
    return [...this.expected].filter((m) => !this.satisfied.has(m));
  }

  setRate(r: number): void {
    this._rate = Math.max(0.1, Math.min(2, r));
  }

  setPractice(on: boolean): void {
    this.practice = on;
    this.clearGate();
  }

  /** Unlock the AudioContext on a user gesture (e.g. tapping a key). */
  async unlock(): Promise<void> {
    await Tone.start();
  }

  async play(): Promise<void> {
    if (this._playing) return;
    await Tone.start(); // unlock AudioContext on user gesture
    this.lastWall = performance.now() / 1000;
    this._playing = true;
  }

  pause(): void {
    this._playing = false;
    this.sampler?.releaseAll();
  }

  seek(t: number): void {
    const dur = this.song?.duration ?? 0;
    this._songTime = Math.max(0, Math.min(t, dur));
    this.sampler?.releaseAll();
    this.cursor = this.song ? this.lowerBound(this.song.notes, this._songTime) : 0;
    this.clearGate();
  }

  /** Called from MIDI input: register a key the player pressed. */
  notePlayed(midi: number): void {
    if (this._waiting && this.expected.has(midi)) this.satisfied.add(midi);
  }

  /** Sound a note the player pressed, so they hear their own keyboard. */
  audition(midi: number, velocity: number): void {
    if (!this.sampler || !this.loaded) return;
    try {
      this.sampler.triggerAttackRelease(Tone.Frequency(midi, 'midi').toNote(), 0.4, undefined, velocity);
    } catch {
      /* ignore */
    }
  }

  private clearGate(): void {
    this._waiting = false;
    this.expected.clear();
    this.satisfied.clear();
  }

  /**
   * Advance the clock by real elapsed time, fire any notes that became due, and
   * return the current song time. Called once per animation frame.
   */
  tick(): number {
    const now = performance.now() / 1000;
    if (!this._playing || !this.song) {
      this.lastWall = now;
      return this._songTime;
    }

    const dt = now - this.lastWall;
    this.lastWall = now;
    const notes = this.song.notes;

    if (this.practice) {
      this.tickPractice(notes, dt);
    } else {
      this._songTime += dt * this._rate;
      while (this.cursor < notes.length && notes[this.cursor].startTime <= this._songTime) {
        this.trigger(notes[this.cursor]);
        this.cursor++;
      }
    }

    // A–B loop wraps before the end check.
    if (this.loopA != null && this.loopB != null && this._songTime >= this.loopB) {
      this.seek(this.loopA);
      return this._songTime;
    }

    if (this._songTime >= this.song.duration) {
      this._songTime = this.song.duration;
      this._playing = false;
    }

    return this._songTime;
  }

  private tickPractice(notes: NoteEvent[], dt: number): void {
    if (this._waiting) {
      // Held at the gate until every required key has been pressed.
      if (this.expectedMidis().length === 0) this.releaseGate(notes);
      return;
    }

    this._songTime += dt * this._rate;

    if (this.cursor >= notes.length) return;
    const next = notes[this.cursor];
    if (this._songTime < next.startTime) return;

    // Reached the next onset — build the gate from the chord at this time.
    this._songTime = next.startTime;
    const gateTime = next.startTime;
    this.expected.clear();
    this.satisfied.clear();
    for (let i = this.cursor; i < notes.length; i++) {
      if (notes[i].startTime - gateTime > CHORD_EPS) break;
      if (this.isMuted(notes[i])) continue; // don't require a muted (solo'd-out) hand
      this.expected.add(notes[i].midi);
    }
    if (this.expected.size === 0) {
      // Nothing to wait for (all muted) — play through.
      this.releaseGate(notes);
    } else {
      this._waiting = true;
    }
  }

  private releaseGate(notes: NoteEvent[]): void {
    const gateTime = this.cursor < notes.length ? notes[this.cursor].startTime : this._songTime;
    while (
      this.cursor < notes.length &&
      notes[this.cursor].startTime - gateTime <= CHORD_EPS
    ) {
      this.trigger(notes[this.cursor]);
      this.cursor++;
    }
    this.clearGate();
  }

  private isMuted(n: NoteEvent): boolean {
    if (n.hand === 'left') return this.muteLeft;
    return this.muteRight; // right + unknown
  }

  private trigger(n: NoteEvent): void {
    if (!this.sampler || !this.loaded) return;
    if (this.isMuted(n)) return;
    const name = Tone.Frequency(n.midi, 'midi').toNote();
    // Sustain in real seconds so the sound matches the on-screen note length.
    const dur = Math.max(0.05, n.duration / this._rate);
    try {
      this.sampler.triggerAttackRelease(name, dur, undefined, n.velocity);
    } catch {
      /* sampler not ready for this voice — skip */
    }
  }

  dispose(): void {
    this.sampler?.dispose();
    this.sampler = null;
    this.loaded = false;
  }

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
}
