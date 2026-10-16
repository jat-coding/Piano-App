import * as Tone from 'tone';
import type { NoteEvent, Song } from '../types';
import { sustainedEnds } from './sustain';

export const SALAMANDER = 'https://tonejs.github.io/audio/salamander/';

// A sparse sample map across the range; the Sampler pitches between them.
export const SAMPLE_URLS: Record<string, string> = {
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
// Play along: when every key of the next chord was played this far (song-s) before
// the song got there, jump to it instead of making the player wait for the picture.
const EARLY_SNAP = 0.12;

// "Scratching" while the notes are dragged: each note sounds briefly as it crosses
// the strike line, rate-limited so a fast drag never turns into mush.
const SCRATCH_DUR = 0.09; // s held before release
const SCRATCH_RELEASE = 0.12; // s fade-out (normal playback uses 1s)
const SCRATCH_BURST = 6; // token bucket: at most this many notes at once…
const SCRATCH_RATE = 24; // …refilled at this many notes per second
const SCRATCH_PER_STEP = 3; // at most this many new notes per drag step / frame
const SCRATCH_VOICES = 6; // at most this many scratch notes sounding together
const SCRATCH_REPEAT = 0.06; // s before the same key may sound again
const NORMAL_RELEASE = 1;

/** A chord the player has to play: when, which keys, and its note index range [from, to). */
export interface Gate {
  time: number;
  midis: number[];
  from: number;
  to: number;
}

export interface ScratchStats {
  crossed: number; // notes that crossed the strike line
  played: number; // notes actually sounded
  dropped: number; // notes skipped by the rate limit / voice cap
  times: number[]; // performance.now() of each sounded note (last 500)
}

/**
 * Drives audio off a single "song clock" that the renderer also reads, so the
 * picture and the sound can never drift. Speed changes scale the clock — sample
 * pitch is untouched (each note is just a sample triggered at its own pitch).
 */
export class PlaybackEngine {
  private sampler: Tone.Sampler | null = null;
  private song: Song | null = null;
  /** Song-s each note stops sounding with the sustain pedal, by note index (null = no pedal data). */
  private ringEnds: Float64Array | null = null;

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

  // ---- play along (interactive mode) ----
  /** Never sound the song's notes (the player plays everything). */
  silent = false;
  /** Song-seconds ahead of the next chord in which a right key already counts. */
  earlyWindow = 0;
  private early = new Set<number>();
  /**
   * Called when a chord is released, with the note index range [from, to). `skipped` =
   * the player went on past it and it was never heard (see skipGates).
   */
  onRelease: ((from: number, to: number, skipped: boolean) => void) | null = null;
  private skipping = false;
  /** Notes the player doesn't have to play (treated like a muted hand). */
  ignored: Set<NoteEvent> | null = null;

  // ---- scrubbing (drag the notes) ----
  private scrubbing = false;
  private tokens = SCRATCH_BURST;
  private tokensAt = 0;
  private voiceEnds: number[] = [];
  private lastByKey = new Map<number, number>();
  scratchStats: ScratchStats = { crossed: 0, played: 0, dropped: 0, times: [] };

  async init(): Promise<void> {
    if (this.sampler) return;
    await new Promise<void>((resolve) => {
      this.sampler = new Tone.Sampler({
        urls: SAMPLE_URLS,
        baseUrl: SALAMANDER,
        release: NORMAL_RELEASE,
        onload: () => {
          this.loaded = true;
          resolve();
        },
      }).toDestination();
    });
  }

  setSong(song: Song | null): void {
    this.song = song;
    this.ringEnds = song ? sustainedEnds(song.notes, song.pedals) : null;
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

  /** Start a drag-scrub: notes sound short and dry until endScrub(). */
  beginScrub(): void {
    this.scrubbing = true;
    if (this.sampler) this.sampler.release = SCRATCH_RELEASE;
  }

  endScrub(): void {
    this.scrubbing = false;
    if (this.sampler) this.sampler.release = NORMAL_RELEASE;
  }

  /**
   * Move the clock to t without cutting notes that are already sounding, and
   * "scratch" every note whose onset crossed the strike line on the way, in
   * either direction. Returns the clamped time.
   */
  scrubTo(t: number): number {
    const from = this._songTime;
    const to = Math.max(0, Math.min(t, this.song?.duration ?? 0));
    if (to === from) return to;
    this._songTime = to;
    this.clearGate();
    if (!this.song) return to;
    const notes = this.song.notes;
    this.cursor = this.lowerBound(notes, to);
    if (this.scrubbing) this.scratch(notes, from, to);
    return to;
  }

  private scratch(notes: NoteEvent[], from: number, to: number): void {
    // Onsets in (from, to] going forward, [to, from) going back.
    const fwd = to > from;
    let i0: number;
    let i1: number;
    if (fwd) {
      i0 = this.upperBound(notes, from);
      i1 = this.upperBound(notes, to);
    } else {
      i0 = this.lowerBound(notes, to);
      i1 = this.lowerBound(notes, from);
    }
    if (i1 <= i0) return;

    // Most recently crossed first: those are the ones under the finger now.
    const crossed: NoteEvent[] = [];
    if (fwd) for (let i = i1 - 1; i >= i0; i--) crossed.push(notes[i]);
    else for (let i = i0; i < i1; i++) crossed.push(notes[i]);

    const now = performance.now() / 1000;
    this.tokens = Math.min(SCRATCH_BURST, this.tokens + (now - this.tokensAt) * SCRATCH_RATE);
    this.tokensAt = now;
    this.voiceEnds = this.voiceEnds.filter((e) => e > now);

    let played = 0;
    for (const n of crossed) {
      if (this.isMuted(n)) continue;
      this.scratchStats.crossed++;
      const last = this.lastByKey.get(n.midi) ?? -Infinity;
      if (
        played >= SCRATCH_PER_STEP ||
        this.tokens < 1 ||
        this.voiceEnds.length >= SCRATCH_VOICES ||
        now - last < SCRATCH_REPEAT
      ) {
        this.scratchStats.dropped++;
        continue;
      }
      if (!this.sampler || !this.loaded) {
        this.scratchStats.dropped++;
        continue;
      }
      try {
        this.sampler.triggerAttackRelease(
          Tone.Frequency(n.midi, 'midi').toNote(),
          SCRATCH_DUR,
          undefined,
          n.velocity * 0.7,
        );
      } catch {
        this.scratchStats.dropped++;
        continue;
      }
      played++;
      this.tokens -= 1;
      this.lastByKey.set(n.midi, now);
      this.voiceEnds.push(now + SCRATCH_DUR + SCRATCH_RELEASE);
      const st = this.scratchStats;
      st.played++;
      st.times.push(now * 1000);
      if (st.times.length > 500) st.times.shift();
    }
  }

  /**
   * Called from MIDI/mic input: register a key the player pressed. Returns true if
   * it answered the chord the song is waiting on (or, with earlyWindow, the next one).
   */
  notePlayed(midi: number): boolean {
    if (this._waiting) {
      if (!this.expected.has(midi)) return false;
      this.satisfied.add(midi);
      return true;
    }
    if (!this.practice || this.earlyWindow <= 0) return false;
    const next = this.nextGate();
    if (!next || next.time - this._songTime > this.earlyWindow || !next.midis.includes(midi)) return false;
    this.early.add(midi);
    return true;
  }

  /** Index of the next note the song will reach (everything before it was played/passed). */
  get cursorIndex(): number {
    return this.cursor;
  }

  /** The next chord the player must play, and when it's due (song-s). Muted hands are left out. */
  nextGate(): Gate | null {
    return this.gatesAhead(1)[0] ?? null;
  }

  /** Up to n upcoming chords from the cursor. Chords of only muted notes are passed over. */
  gatesAhead(n: number): Gate[] {
    const notes = this.song?.notes;
    const out: Gate[] = [];
    if (!notes) return out;
    for (let c = this.cursor; c < notes.length && out.length < n; ) {
      const time = notes[c].startTime;
      const midis: number[] = [];
      let i = c;
      for (; i < notes.length && notes[i].startTime - time <= CHORD_EPS; i++) {
        if (!this.isMuted(notes[i]) && !midis.includes(notes[i].midi)) midis.push(notes[i].midi);
      }
      if (midis.length) out.push({ time, midis, from: c, to: i });
      c = i; // all muted — the song plays through it
    }
    return out;
  }

  /**
   * The player has gone on past chords the app never heard (a missed detection, or a
   * stray note in a transcription): pass `missed` chords without credit, then release
   * `heard` chords as played, and carry on from there.
   */
  skipGates(missed: number, heard: number): void {
    const notes = this.song?.notes;
    if (!notes || !this.practice) return;
    const gates = this.gatesAhead(missed + heard);
    if (gates.length < missed + heard) return;
    this._waiting = false;
    this.expected.clear();
    this.satisfied.clear();
    this.early.clear();
    gates.forEach((g, k) => {
      this.skipping = k < missed;
      this.cursor = g.from;
      this._songTime = Math.max(this._songTime, g.time);
      this.releaseGate(notes);
    });
    this.skipping = false;
  }

  /** Keys still needed for the chord being waited on, or the upcoming one inside earlyWindow. */
  pendingMidis(): number[] {
    if (this._waiting) return this.expectedMidis();
    if (!this.practice || this.earlyWindow <= 0) return [];
    const next = this.nextGate();
    if (!next || next.time - this._songTime > this.earlyWindow) return [];
    return next.midis.filter((m) => !this.early.has(m));
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
    this.early.clear();
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
        this.trigger(this.cursor);
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

    // Every key of the next chord already played, well ahead: catch the picture up.
    if (this.early.size) {
      const g = this.nextGate();
      if (g && g.time - this._songTime > EARLY_SNAP && g.midis.every((m) => this.early.has(m))) {
        this._songTime = g.time;
      }
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
    // Keys played a moment early already count.
    for (const m of this.early) if (this.expected.has(m)) this.satisfied.add(m);
    this.early.clear();
    if (this.expected.size === 0 || this.expectedMidis().length === 0) {
      // Nothing to wait for (all muted) — play through.
      this.releaseGate(notes);
    } else {
      this._waiting = true;
    }
  }

  private releaseGate(notes: NoteEvent[]): void {
    const gateTime = this.cursor < notes.length ? notes[this.cursor].startTime : this._songTime;
    const from = this.cursor;
    while (
      this.cursor < notes.length &&
      notes[this.cursor].startTime - gateTime <= CHORD_EPS
    ) {
      this.trigger(this.cursor);
      this.cursor++;
    }
    this._waiting = false;
    this.expected.clear();
    this.satisfied.clear();
    this.onRelease?.(from, this.cursor, this.skipping);
  }

  isMuted(n: NoteEvent): boolean {
    if (this.ignored?.has(n)) return true;
    if (n.hand === 'left') return this.muteLeft;
    return this.muteRight; // right + unknown
  }

  /** Note-seconds note i sounds for: its own length, or longer while the sustain pedal holds it. */
  ringDuration(i: number): number {
    const n = this.song!.notes[i];
    return this.ringEnds ? this.ringEnds[i] - n.startTime : n.duration;
  }

  private trigger(i: number): void {
    if (this.silent || !this.sampler || !this.loaded || !this.song) return;
    const n = this.song.notes[i];
    if (this.isMuted(n)) return;
    const name = Tone.Frequency(n.midi, 'midi').toNote();
    // Sustain in real seconds so the sound matches the on-screen note length (or the pedal).
    const dur = Math.max(0.05, this.ringDuration(i) / this._rate);
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

  /** First index with startTime > t. */
  private upperBound(notes: NoteEvent[], t: number): number {
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].startTime <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
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
