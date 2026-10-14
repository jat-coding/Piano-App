import type { NoteEvent, Song } from '../types';
import type { Gate, PlaybackEngine } from '../audio/playback';
import { NoteListener } from './listener';

/**
 * Play along: the song only moves on when the player hits the right keys, heard
 * through the mic (or a MIDI keyboard). Drives the engine's wait mode, keeps the
 * score, and records everything the session video needs: the song-time ↔ clock
 * timeline (with all the waits), every hit and every wrong key.
 */

/** Where the sound comes from: the mic's samples (or a WAV in the tuning script). */
export interface SpectrumSource {
  readonly sampleRate: number;
  readonly fftSize: number;
  /** Seconds, on the same clock as the recording. */
  now(): number;
  /** Clock time of the newest sample received so far. */
  latest(): number;
  /** Linear magnitude spectrum (fftSize/2 bins) of the fftSize samples ending at clock time t. */
  readAt(t: number, mag: Float32Array): void;
}

/**
 * The sound is looked at every HOP_S seconds of audio, however often the screen
 * draws: on a phone in Low Power Mode (30 frames a second) or a slow frame, the
 * listener still sees every step, so it hears the same thing at any frame rate.
 */
export const HOP_S = 1 / 60;
const MAX_BACKLOG_S = 0.5; // after a long stall, skip ahead rather than replay it all

export type Phase = 'quiet' | 'listen' | 'countdown' | 'running' | 'tail' | 'done' | 'error';

export interface SessionScore {
  /** Share of the notes reached that were hit without a wrong key first (0..1). */
  accuracy: number;
  bestStreak: number;
  /** Notes hit cleanly / notes reached / notes in the song (the hands being played). */
  clean: number;
  reached: number;
  total: number;
  complete: boolean;
}

export interface WrongKey {
  at: number;
  midi: number;
}

const QUIET_S = 1.0; // room sound sampled for the noise floor
const LISTEN_TIMEOUT_S = 15;
export const COUNTDOWN_S = 3;
const TAIL_S = 1.2; // keep recording after the last note so it rings out
const FOLLOW = 4; // chords listened for normally: the one the song is on and three more
// Stuck for this long while the player keeps playing: they've gone on (the app missed
// a note, or they know the part by heart). Listen further ahead to find them again.
const LOST_S = 1.2;
const HORIZON_S = 4;
const HORIZON_GATES = 24;
const ROLL_S = 0.08; // onsets this close together are one chord (a slightly rolled one)
const HISTORY_S = 2; // heard onsets kept for finding the player again
const LOOK_BEHIND = 0.6; // song-s: keys just played are never "wrong"
const LOOK_AHEAD = 1.5; // song-s: nor are keys coming up soon
const MAX_SESSION_S = 20 * 60;
// The same key again this soon is a transcription echo, not something a player can
// strike twice (and the two bars read as one): it doesn't have to be played.
const RESTRIKE_S = 0.13;

export interface SessionHooks {
  onPhase?: (p: Phase) => void;
  onWrong?: (midi: number) => void;
  onHit?: (midis: number[]) => void;
}

export class PlayAlongSession {
  phase: Phase;
  error = '';
  readonly listener: NoteListener | null;
  private mag: Float32Array | null;
  private phaseAt = 0;
  /** Clock time (source.now) when the song started (countdown ended). */
  songStart = 0;
  endAt = 0;
  /** Countdown seconds left, for the UI. */
  countdown = 0;

  // ---- recording for the video ----
  /** Flattened [clock, songTime] pairs, one per frame while running. */
  timeline: number[] = [];
  /** Per note: clock time it was hit (Infinity = not hit / not required). */
  hitAt: Float64Array;
  /** Per note: 1 if the player has to play it (its hand wasn't muted). */
  required: Uint8Array;
  wrongs: WrongKey[] = [];
  /** MIDI key presses (for a MIDI-only session's sound). */
  midiPresses: { at: number; midi: number; velocity: number }[] = [];
  /** Detection diagnostics: per hit chord, clock time of the onset that completed it and when it released. */
  hitLog: { from: number; to: number; onsetAt: number; releasedAt: number; skipped: boolean }[] = [];

  // ---- scoring ----
  private wrongSinceRelease = false;
  private clean = 0;
  private reached = 0;
  private streak = 0;
  bestStreak = 0;
  readonly total: number;
  /** Notes that are quick repeats of the same key (see RESTRIKE_S): not required. */
  readonly echoes: Set<NoteEvent>;

  // ---- following the player ----
  private lastOnsetAt = 0;
  private waitingSince = -1;
  /** Keys heard so far for each upcoming chord, keyed by the chord's first note index. */
  private heard = new Map<number, Set<number>>();
  /** Recent onsets the listener heard (keys grouped per onset), for finding the player again. */
  private groups: { at: number; midis: Set<number> }[] = [];

  constructor(
    private engine: PlaybackEngine,
    private song: Song,
    private source: SpectrumSource | null,
    private hooks: SessionHooks = {},
    private clock: () => number = () => performance.now() / 1000,
    /** A listener already calibrated on this mic (Try again): skip the mic check. */
    calibrated: NoteListener | null = null,
  ) {
    const n = song.notes.length;
    this.hitAt = new Float64Array(n).fill(Infinity);
    this.required = new Uint8Array(n);
    const lastOn = new Map<number, number>();
    const echoes = new Set<NoteEvent>();
    for (const note of song.notes) {
      const prev = lastOn.get(note.midi);
      if (prev != null && note.startTime - prev < RESTRIKE_S) echoes.add(note);
      else lastOn.set(note.midi, note.startTime);
    }
    this.echoes = echoes;
    let total = 0;
    song.notes.forEach((note, i) => {
      if (!echoes.has(note) && !engine.isMuted(note)) {
        this.required[i] = 1;
        total++;
      }
    });
    this.total = total;
    if (source) {
      this.listener = new NoteListener(source.sampleRate, source.fftSize);
      this.mag = new Float32Array(source.fftSize / 2);
      this.phase = 'quiet';
      if (calibrated?.isCalibrated && calibrated.binHz === this.listener.binHz) {
        this.listener.copyCalibration(calibrated);
        this.phase = 'countdown';
      }
    } else {
      this.listener = null;
      this.mag = null;
      this.phase = 'countdown';
    }
    this.phaseAt = this.now();
  }

  now(): number {
    return this.source ? this.source.now() : this.clock();
  }

  get running(): boolean {
    return this.phase === 'running' || this.phase === 'tail';
  }

  /** Seconds the song has been held on the current chord (0 if it isn't waiting). */
  get waitingFor(): number {
    return this.waitingSince < 0 ? 0 : this.now() - this.waitingSince;
  }

  get meter(): number {
    return this.listener?.meter ?? 0;
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.phaseAt = this.now();
    this.hooks.onPhase?.(p);
  }

  /** Call once per frame BEFORE engine.tick(). */
  tick(): void {
    const src = this.source;
    const mag = this.mag;
    if (src && mag) {
      // Every audio step since the last frame, in order (see HOP_S).
      const last = src.latest();
      if (this.nextHop < 0 || last - this.nextHop > MAX_BACKLOG_S) this.nextHop = last;
      while (this.nextHop <= last && this.phase !== 'done' && this.phase !== 'error') {
        src.readAt(this.nextHop, mag);
        this.step(this.nextHop, mag);
        this.nextHop += HOP_S;
      }
    }
    this.step(this.now(), null);
  }

  /** Clock time of the next audio step to look at (-1 = start from the newest sound). */
  private nextHop = -1;

  /** One step: `mag` = the sound at time `now`, or null for a frame with only the clock. */
  private step(now: number, mag: Float32Array | null): void {
    const L = this.listener;
    switch (this.phase) {
      case 'quiet':
        if (mag) L!.calibrateFrame(mag);
        if (now - this.phaseAt >= QUIET_S) {
          L!.finishCalibration();
          this.setPhase('listen');
        }
        return;
      case 'listen':
        if (mag && L!.heardOnset(mag)) {
          this.setPhase('countdown');
        } else if (now - this.phaseAt > LISTEN_TIMEOUT_S) {
          this.error = "I didn't hear a note. Check the microphone isn't muted or covered, and play a bit louder.";
          this.setPhase('error');
        }
        return;
      case 'countdown':
        // Keep the listener's frame history fresh so the first note's onset is clean.
        if (L && mag) L.frame(mag, now, { expected: [], allowed: new Set() });
        this.countdown = Math.max(0, COUNTDOWN_S - (now - this.phaseAt));
        if (this.countdown <= 0) this.begin();
        return;
      case 'running':
        if (L && mag) this.listen(now, mag);
        if (now - this.songStart > MAX_SESSION_S) this.finish();
        return;
      case 'tail':
        if (now - this.endAt >= TAIL_S) this.setPhase('done');
        return;
    }
  }

  private begin(): void {
    const e = this.engine;
    e.loopA = null;
    e.loopB = null;
    e.seek(0);
    e.setPractice(true);
    e.silent = true;
    e.ignored = this.echoes;
    e.earlyWindow = 0; // the session follows the player itself (see follow())
    e.onRelease = (from, to, skipped) => this.released(from, to, skipped);
    this.songStart = this.now();
    this.timeline = [this.songStart, 0];
    this.wrongSinceRelease = false;
    this.setPhase('running');
    void e.play();
  }

  /** Call once per frame AFTER engine.tick(), with the song time it returned. */
  afterTick(songTime: number): void {
    if (!this.running) return;
    const now = this.now();
    this.timeline.push(now, songTime);
    const e = this.engine;
    if (e.waiting) {
      if (this.waitingSince < 0) this.waitingSince = now;
    } else {
      this.waitingSince = -1;
    }
    if (this.phase === 'running' && !e.playing && songTime >= this.song.duration - 1e-6) this.finish();
  }

  /** A MIDI key (or on-screen key) pressed during the session. */
  keyPressed(midi: number, velocity = 0.8): void {
    if (this.phase !== 'running') return;
    const now = this.now();
    this.midiPresses.push({ at: now, midi, velocity });
    this.lastOnsetAt = now;
    const gates = this.upcoming();
    if (this.follow([midi], gates, now).length) return;
    if (!this.allowedNow(gates).has(midi)) this.markWrong(midi, now);
  }

  /** End the session now (Stop button, or the song finished). */
  finish(): void {
    if (this.phase !== 'running') return;
    this.endAt = this.now();
    this.setPhase('tail');
    this.engine.pause();
  }

  /** Put the engine back to normal playback. Call when the session UI closes. */
  dispose(): void {
    const e = this.engine;
    e.silent = false;
    e.ignored = null;
    e.earlyWindow = 0;
    e.onRelease = null;
    if (this.phase !== 'done' && this.phase !== 'error') this.phase = 'done';
  }

  get score(): SessionScore {
    return {
      accuracy: this.reached ? this.clean / this.reached : 0,
      bestStreak: this.bestStreak,
      clean: this.clean,
      reached: this.reached,
      total: this.total,
      complete: this.reached >= this.total,
    };
  }

  // ---- internals ----

  private listen(now: number, mag: Float32Array): void {
    const gates = this.upcoming();
    const expected: number[] = [];
    for (const g of gates) {
      const got = this.heard.get(g.from);
      for (const m of g.midis) if (!got?.has(m) && !expected.includes(m)) expected.push(m);
    }
    const together = (a: number, b: number) => gates.some((g) => g.midis.includes(a) && g.midis.includes(b));
    const r = this.listener!.frame(mag, now, { expected, together, allowed: this.allowedNow(gates) });
    if (!r) return;
    if (r.matched.length) {
      this.lastOnsetAt = r.onsetAt;
      this.follow(r.matched, gates, r.onsetAt);
    }
    for (const m of r.wrong) this.markWrong(m, r.onsetAt);
  }

  /**
   * The chords the player could be on: the one the song is at and the next few due
   * soon after. While the song has been stuck a while, many more (see LOST_S).
   */
  private upcoming(): Gate[] {
    const e = this.engine;
    const lost = this.waitingFor >= LOST_S;
    const gates = e.gatesAhead(lost ? HORIZON_GATES : FOLLOW);
    const t = e.songTime;
    const out = gates.filter((g, k) => k === 0 || g.time - t <= (lost ? HORIZON_S : LOOK_AHEAD));
    for (const from of this.heard.keys()) if (!out.some((g) => g.from === from)) this.heard.delete(from);
    return out;
  }

  /**
   * Move the song along from keys just heard. Each key counts toward the earliest
   * upcoming chord that still needs it (a chord can come in over several onsets).
   * - The chord the song is on complete → released right away; if the player is a
   *   little ahead of the picture, the song jumps up to them.
   * - It isn't, but the two chords after it are → the player has gone on and the app
   *   missed that one: it passes as a miss and the song catches up.
   * - Stuck a while (LOST_S): if the latest onset is chord j further on and an onset
   *   just before it was chord j-1, the song catches up to there.
   * Returns the keys that matched something.
   */
  private follow(midis: number[], gates: Gate[], at: number): number[] {
    const e = this.engine;
    if (!gates.length) return [];
    const lastG = this.groups[this.groups.length - 1];
    if (lastG && at - lastG.at <= ROLL_S) for (const m of midis) lastG.midis.add(m);
    else this.groups.push({ at, midis: new Set(midis) });
    while (this.groups.length && at - this.groups[0].at > HISTORY_S) this.groups.shift();

    const near = gates.slice(0, FOLLOW);
    const used: number[] = [];
    for (const m of midis) {
      for (const g of near) {
        let got = this.heard.get(g.from);
        if (!g.midis.includes(m) || got?.has(m)) continue;
        if (!got) this.heard.set(g.from, (got = new Set()));
        got.add(m);
        used.push(m);
        break;
      }
    }
    const done = (g: Gate | undefined) => !!g && g.midis.every((m) => this.heard.get(g.from)?.has(m));
    const [g0, g1, g2] = near;
    if (done(g0)) {
      e.skipGates(0, 1);
      // Chords right after it may already be complete too (heard while it was held).
      let next = e.gatesAhead(1)[0];
      while (next && done(next)) {
        e.skipGates(0, 1);
        next = e.gatesAhead(1)[0];
      }
      return used;
    }
    if (done(g1) && done(g2)) {
      e.skipGates(1, 2);
      return used;
    }
    if (gates.length > FOLLOW || this.waitingFor >= LOST_S) {
      const j = this.findPlayer(gates);
      if (j > 0) {
        e.skipGates(j, 1);
        return used;
      }
    }
    // Partial chord: show progress on the green keys.
    if (e.waiting) for (const m of this.heard.get(g0.from) ?? []) e.notePlayed(m);
    return used;
  }

  /**
   * Where the player is, from the last few onsets: the smallest j ≥ 1 such that the
   * latest onset is chord j and an earlier recent onset was chord i, one or two
   * chords before it (a missed bass note in between mustn't hide them). -1 if none.
   */
  private findPlayer(gates: Gate[]): number {
    const gs = this.groups;
    if (gs.length < 2 || !gates.length) return -1;
    // Keys of the chord the song is on are no evidence: the player may be replaying it.
    const g0 = new Set(gates[0].midis);
    const latest = gs[gs.length - 1];
    if ([...latest.midis].every((m) => g0.has(m))) return -1;
    const before = gs.slice(0, -1).filter((g) => !sameKeys(g.midis, latest.midis));
    const has = (g: { midis: Set<number> }, gate: Gate) => gate.midis.every((m) => g.midis.has(m));
    for (let j = 1; j < gates.length; j++) {
      if (!has(latest, gates[j])) continue;
      for (let i = j - 1; i >= Math.max(1, j - 2); i--) {
        if (before.some((g) => has(g, gates[i]))) return j;
      }
    }
    return -1;
  }

  private released(from: number, to: number, skipped: boolean): void {
    const now = this.now();
    let n = 0;
    for (let i = from; i < to; i++) {
      if (!this.required[i]) continue;
      n++;
      if (!skipped) this.hitAt[i] = now;
    }
    if (!n) return;
    this.hitLog.push({ from, to, onsetAt: this.lastOnsetAt, releasedAt: now, skipped });
    this.reached += n;
    if (skipped || this.wrongSinceRelease) {
      this.streak = 0;
    } else {
      this.clean += n;
      this.streak += n;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
    }
    this.wrongSinceRelease = false;
    if (!skipped) {
      const midis: number[] = [];
      for (let i = from; i < to; i++) if (this.required[i]) midis.push(this.song.notes[i].midi);
      this.hooks.onHit?.(midis);
    }
  }

  private markWrong(midi: number, at: number): void {
    this.wrongs.push({ at, midi });
    this.wrongSinceRelease = true;
    this.hooks.onWrong?.(midi);
  }

  /** Keys the song has right around now: just played, still sounding, or coming up. */
  private allowedNow(gates: Gate[]): Set<number> {
    const t = this.engine.songTime;
    const notes = this.song.notes;
    const out = new Set<number>();
    for (const g of gates) for (const m of g.midis) out.add(m);
    for (let i = lowerBound(notes, t - 12); i < notes.length; i++) {
      const n = notes[i];
      if (n.startTime > t + LOOK_AHEAD) break;
      if (n.startTime >= t - LOOK_BEHIND || n.startTime + n.duration >= t) out.add(n.midi);
    }
    return out;
  }

  /** Clock → song time along the recorded timeline (linear between frames). */
  songAt(clockT: number): number {
    const tl = this.timeline;
    const n = tl.length / 2;
    if (!n) return 0;
    if (clockT <= tl[0]) return tl[1];
    if (clockT >= tl[(n - 1) * 2]) return tl[(n - 1) * 2 + 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tl[mid * 2] <= clockT) lo = mid;
      else hi = mid;
    }
    const t0 = tl[lo * 2];
    const t1 = tl[hi * 2];
    const s0 = tl[lo * 2 + 1];
    const s1 = tl[hi * 2 + 1];
    return t1 > t0 ? s0 + ((s1 - s0) * (clockT - t0)) / (t1 - t0) : s1;
  }
}

function sameKeys(a: Set<number>, b: Set<number>): boolean {
  return a.size === b.size && [...a].every((m) => b.has(m));
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
