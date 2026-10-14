/**
 * Hears the player through the mic by checking for the notes the song EXPECTS next,
 * rather than transcribing from scratch. Fed one magnitude spectrum per animation
 * frame (an AnalyserNode, or an offline STFT in the tuning script).
 *
 * 1. Onsets: spectral flux (new energy since the last two frames, above the room's
 *    noise floor) must jump. A held or decaying note adds no flux, so it can't count twice.
 * 2. The flux since the onset (up to ~85ms) is summed. Each candidate pitch is scored by
 *    a weighted geometric mean of how much that flux stands out at its first four
 *    harmonics, so missing harmonics sink the score. That
 *    keeps out the octave errors piano harmonics cause. Low notes, whose fundamental is
 *    weak, are judged on harmonics 2–5.
 * 3. An expected key counts as soon as it shows up shortly after an onset. Once an
 *    onset window closes, the energy the song's own nearby notes explain is removed.
 *    If a strong pitch is left that the song doesn't have here, it's a wrong key.
 */

export const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

const LO_MIDI = 21;
const HI_MIDI = 108;
const F_MIN = 25; // Hz — bins below this are rumble
const F_MAX = 5000; // Hz — harmonics above this are too weak to help
const TOL = 0.025; // harmonic search window, ± fraction of the frequency (≈ half a semitone)
const PEAK_SEARCH = 0.045; // ± fraction searched for the peak a partial belongs to
const WINDOW = 0.085; // s of flux summed for matching (an onset fills the FFT window in ~this)
const RETRIGGER = 0.1; // s before the same key can match again…
const REARM = 0.3; // …and only once its own score has fallen below this share of its match
const EVENT_LEN = 0.075; // s after an onset before it's checked for wrong keys
const ONSET_REL = 0.05; // an onset's new energy must be this share of the room's current level
const MATCH_REL = 0.22; // expected key must reach this share of the strongest pitch
const NEIGHBOUR = 1.6; // …and not be dwarfed by the key next to it (that's leakage)
const WRONG_RESIDUAL = 0.22; // share of the onset's energy the song can't explain
const WRONG_MIN = 2.0; // and the onset must be this many times the onset threshold
const WRONG_LO = 41; // F2: wrong keys below this aren't reported
const WRONG_H2 = 0.12; // a wrong key's 2nd harmonic must reach this share of its fundamental…
const WRONG_H2_BELOW = 1000; // Hz: …for keys below this
const HARM_W = [1, 1, 0.5, 0.5]; // weight of each harmonic in the score (low ones matter most)
const LOW_HARM = 0.25; // a key's 1st/2nd harmonic must reach this share of its strongest
const CONTRAST_BAND = 0.12; // ± fraction of f a partial is compared against (≈ 2 semitones)
const SETTLE = 0.025; // s into an onset before keys are judged (the first frame is mostly thump)
const SUBS = [12, 19, 24]; // a lower note this far down covers a key's harmonics
const OVERTONES = [12, 19, 24, 28, 31]; // …and a key this far up is covered by a lower one's

export interface ListenTargets {
  /** Keys still needed for the next chord(s). */
  expected: number[];
  /** Is this pair of keys played together (same chord)? Leakage checks skip such pairs. */
  together?: (a: number, b: number) => boolean;
  /** Keys that are in the song nearby (just played, sounding, or coming soon): never "wrong". */
  allowed: Set<number>;
}

export interface ListenResult {
  /** Expected keys heard in this frame (newly). */
  matched: number[];
  /** Keys heard that the song doesn't have here (reported once an onset window closes). */
  wrong: number[];
  /** When the onset behind these began (same clock as `at`). */
  onsetAt: number;
}

export class NoteListener {
  readonly binHz: number;
  private nBins: number;
  private kLo: number;
  private kHi: number;
  private noise: Float32Array;
  private prev: Float32Array;
  private prev2: Float32Array;
  private flux: Float32Array;
  private acc: Float32Array;
  private resid: Float32Array;
  private cum: Float64Array;
  private ring: { at: number; flux: Float32Array }[] = [];

  // calibration
  private calFrames = 0;
  private oSum = 0;
  private oSq = 0;
  private calibrated = false;
  /** Onset threshold (sum of flux). */
  threshold = 0;

  private lastOnset = -Infinity;
  private eventStart = -Infinity;
  private eventOpen = false;
  private eventPeak = 0;
  private eventMatched = new Set<number>();
  /** Keys that matched and haven't died down since: key → [time, score at the match]. */
  private spent = new Map<number, [number, number]>();
  /** Keys that died down again: they wait for an onset that starts after this time. */
  private rearmed = new Map<number, number>();
  private runStart = -Infinity;
  /** Keys matched since the current onset run began. */
  private runMatched = new Set<number>();
  private wasOnset = false;
  /** Smoothed overall level (sum of magnitudes) — onsets must stand out against it. */
  private level = 0;
  /** 0..1 mic level for a meter. */
  meter = 0;
  /** Onsets seen (for tests/diagnostics). */
  onsets = 0;

  constructor(sampleRate: number, fftSize: number) {
    this.binHz = sampleRate / fftSize;
    this.nBins = fftSize / 2;
    this.kLo = Math.max(1, Math.floor(F_MIN / this.binHz));
    this.kHi = Math.min(this.nBins - 1, Math.ceil(F_MAX / this.binHz));
    this.noise = new Float32Array(this.nBins);
    this.prev = new Float32Array(this.nBins);
    this.prev2 = new Float32Array(this.nBins);
    this.flux = new Float32Array(this.nBins);
    this.acc = new Float32Array(this.nBins);
    this.resid = new Float32Array(this.nBins);
    this.cum = new Float64Array(this.nBins + 2);
  }

  get isCalibrated(): boolean {
    return this.calibrated;
  }

  /** Feed a frame of room sound (the player is quiet). Builds the noise floor. */
  calibrateFrame(mag: Float32Array): void {
    const o = this.computeFlux(mag, false);
    this.calFrames++;
    for (let k = this.kLo; k <= this.kHi; k++) this.noise[k] += mag[k];
    if (this.calFrames > 2) {
      this.oSum += o;
      this.oSq += o * o;
    }
    this.updateMeter(mag);
  }

  finishCalibration(): void {
    const n = Math.max(1, this.calFrames);
    for (let k = this.kLo; k <= this.kHi; k++) this.noise[k] = (this.noise[k] / n) * 2;
    const m = Math.max(1, this.calFrames - 2);
    const mean = this.oSum / m;
    const sd = Math.sqrt(Math.max(0, this.oSq / m - mean * mean));
    // Above the room's own flicker, and never so low that numeric dust triggers it.
    this.threshold = Math.max(mean + 8 * sd, mean * 4, 2e-6 * (this.kHi - this.kLo));
    this.calibrated = true;
  }

  /** Reuse another listener's noise floor and threshold (same mic, same room). */
  copyCalibration(other: NoteListener): void {
    this.noise.set(other.noise);
    this.threshold = other.threshold;
    this.calibrated = true;
  }

  /** Did this frame contain a clear onset? Used for "play any note" during calibration. */
  heardOnset(mag: Float32Array): boolean {
    const o = this.computeFlux(mag, true);
    this.updateMeter(mag);
    const hit = o > this.threshold * 1.5 && o > 2 * ONSET_REL * this.level;
    this.trackLevel(mag);
    return hit;
  }

  /** Feed one frame while playing. `at` is a timestamp (s) on the caller's clock. */
  frame(mag: Float32Array, at: number, targets: ListenTargets): ListenResult | null {
    const o = this.computeFlux(mag, true);
    this.updateMeter(mag);
    const onset = o > this.threshold && o > ONSET_REL * this.level;
    this.trackLevel(mag);

    // Sliding sum of the last WINDOW seconds of flux.
    const f = this.ring.length >= 8 ? this.ring.shift()!.flux : new Float32Array(this.nBins);
    f.set(this.flux);
    this.ring.push({ at, flux: f });
    while (this.ring.length && at - this.ring[0].at > WINDOW) this.ring.shift();

    if (onset && !this.wasOnset) {
      this.runStart = at;
      this.runMatched.clear();
    }
    this.wasOnset = onset;
    if (onset) {
      if (at - this.lastOnset > WINDOW) this.onsets++;
      this.lastOnset = at;
      if (!this.eventOpen) {
        this.eventOpen = true;
        this.eventStart = at;
        this.eventPeak = 0;
        this.eventMatched.clear();
      }
    }
    if (this.eventOpen) this.eventPeak = Math.max(this.eventPeak, o);
    if (at - this.lastOnset > WINDOW && !this.eventOpen && !this.spent.size) return null;

    const { acc } = this;
    acc.fill(0);
    // Only this onset's energy: a note struck just before it would otherwise still be in
    // the window, and could count again for a later chord.
    for (const r of this.ring) {
      if (r.at < this.runStart - 1e-6) continue;
      for (let k = this.kLo; k <= this.kHi; k++) acc[k] += r.flux[k];
    }
    const { sal, max } = this.salienceAll(acc);

    // A struck key's flux lingers in the window for a while: it may match again only
    // once its own score has died down, so one strike can't count for two chords.
    for (const [m, sp] of this.spent) {
      const now = sal[m - LO_MIDI];
      if (now > sp[1]) sp[1] = now; // score keeps rising while the window fills
      else if (at - sp[0] >= RETRIGGER && now < REARM * sp[1]) {
        this.spent.delete(m);
        this.rearmed.set(m, at);
      }
    }

    const matched: number[] = [];
    if (at - this.lastOnset <= WINDOW && at - this.runStart >= SETTLE - 1e-6) {
      for (const m of targets.expected) {
        if (matched.includes(m) || this.spent.has(m)) continue;
        if (this.runStart <= (this.rearmed.get(m) ?? -Infinity)) continue; // its own fading tail
        if (this.isPresent(m, sal, max, targets)) {
          matched.push(m);
          this.runMatched.add(m);
          this.rearmed.delete(m);
          this.spent.set(m, [at, sal[m - LO_MIDI]]);
          this.eventMatched.add(m);
        }
      }
    }

    let wrong: number[] = [];
    if (this.eventOpen && at - this.eventStart >= EVENT_LEN) {
      wrong = this.wrongKeys(sal, max, targets);
      this.eventOpen = false;
    }
    if (!matched.length && !wrong.length) return null;
    return { matched, wrong, onsetAt: this.eventOpen ? this.eventStart : this.lastOnset };
  }

  /** Flux = new energy since the last two frames, above the noise floor. Returns its sum. */
  private computeFlux(mag: Float32Array, useNoise: boolean): number {
    const { prev, prev2, flux, noise } = this;
    let o = 0;
    for (let k = this.kLo; k <= this.kHi; k++) {
      const base = Math.max(prev[k], prev2[k], useNoise ? noise[k] : 0);
      const f = mag[k] > base ? mag[k] - base : 0;
      flux[k] = f;
      o += f;
    }
    this.prev2.set(prev);
    this.prev.set(mag);
    return o;
  }

  private trackLevel(mag: Float32Array): void {
    let sum = 0;
    for (let k = this.kLo; k <= this.kHi; k++) sum += mag[k];
    // Fast attack, slow release: a loud ringing chord raises the bar for a while.
    this.level = sum > this.level ? sum : this.level * 0.97 + sum * 0.03;
  }

  private updateMeter(mag: Float32Array): void {
    let sum = 0;
    for (let k = this.kLo; k <= this.kHi; k++) sum += mag[k] * mag[k];
    const db = 10 * Math.log10(sum + 1e-12);
    const v = Math.max(0, Math.min(1, (db + 60) / 50));
    this.meter = Math.max(v, this.meter * 0.9);
  }

  private bins(f: number): [number, number] {
    const w = Math.max(this.binHz, f * TOL);
    return [Math.max(this.kLo, Math.floor((f - w) / this.binHz)), Math.min(this.kHi, Math.ceil((f + w) / this.binHz))];
  }

  /**
   * The partial at f: the largest value of `spec` within ±TOL of f, but only if the
   * peak it belongs to is really centred there. A key a semitone away is only a few
   * bins off, and its peak's slope reaches into this window: the peak's interpolated
   * centre (searched over a wider ±PEAK_SEARCH) has to land within ±TOL of f.
   */
  private peak(spec: Float32Array, f: number): number {
    const [lo, hi] = this.bins(f);
    let best = 0;
    for (let k = lo; k <= hi; k++) if (spec[k] > best) best = spec[k];
    if (best <= 0) return 0;
    const kc = f / this.binHz;
    const w = Math.max(2, kc * PEAK_SEARCH);
    const a = Math.max(this.kLo + 1, Math.floor(kc - w));
    const b = Math.min(this.kHi - 1, Math.ceil(kc + w));
    let kp = a;
    for (let k = a; k <= b; k++) if (spec[k] > spec[kp]) kp = k;
    const y0 = spec[kp - 1];
    const y1 = spec[kp];
    const y2 = spec[kp + 1];
    const den = y0 - 2 * y1 + y2;
    const centre = kp + (den < 0 ? (0.5 * (y0 - y2)) / den : 0);
    return Math.abs(centre - kc) <= Math.max(0.6, kc * TOL) ? best : 0;
  }

  /**
   * How much the peak near f stands out from the spectrum around it (±CONTRAST_BAND).
   * The thump of a hammer puts energy everywhere at once; a string's partial is a
   * peak. Scoring the stand-out keeps the thump from lighting up every key.
   */
  private contrast(spec: Float32Array, f: number, spacing = f): number {
    const p = this.peak(spec, f);
    if (p <= 0) return 0;
    // The surroundings: ±CONTRAST_BAND (at least 8 bins) but inside the gap to the
    // neighbouring harmonics, minus the peak's own spread (the search window plus the
    // analysis window's main lobe, ±3 bins). Low notes' harmonics are too close
    // together for that: there the plain peak is used.
    const kc = f / this.binHz;
    const half = Math.min(Math.max(8, kc * CONTRAST_BAND), (0.7 * spacing) / this.binHz);
    const own = Math.max(1, kc * TOL) + 3;
    if (half < own + 2) return p;
    const cum = this.cum;
    const sum = (a: number, b: number) => {
      a = Math.max(this.kLo, Math.round(a));
      b = Math.min(this.kHi, Math.round(b));
      return b >= a ? [cum[b + 1] - cum[a], b - a + 1] : [0, 0];
    };
    const [s1, n1] = sum(kc - half, kc - own - 1);
    const [s2, n2] = sum(kc + own + 1, kc + half);
    const mean = n1 + n2 ? (s1 + s2) / (n1 + n2) : 0;
    return p > mean ? p - mean : 0;
  }

  /** Weighted geometric mean of each key's harmonics' stand-out in `spec`. */
  private salienceAll(spec: Float32Array): { sal: Float32Array; max: number } {
    let specMax = 0;
    const cum = this.cum;
    cum[this.kLo] = 0;
    for (let k = this.kLo; k <= this.kHi; k++) {
      if (spec[k] > specMax) specMax = spec[k];
      cum[k + 1] = cum[k] + spec[k];
    }
    const eps = specMax * 0.01 + 1e-12;
    const sal = new Float32Array(HI_MIDI - LO_MIDI + 1);
    let max = 0;
    for (let m = LO_MIDI; m <= HI_MIDI; m++) {
      const f0 = midiHz(m);
      const h0 = f0 < 80 ? 2 : 1; // weak fundamental down low
      let logSum = 0;
      let wSum = 0;
      for (let j = 0; j < HARM_W.length; j++) {
        const f = f0 * (h0 + j);
        if (f > F_MAX) break;
        logSum += HARM_W[j] * Math.log(this.contrast(spec, f, f0) + eps);
        wSum += HARM_W[j];
      }
      const s = wSum ? Math.exp(logSum / wSum) : 0;
      sal[m - LO_MIDI] = s;
      if (s > max) max = s;
    }
    return { sal, max };
  }

  private isPresent(m: number, sal: Float32Array, max: number, t: ListenTargets): boolean {
    if (m < LO_MIDI || m > HI_MIDI) return false;
    const s = sal[m - LO_MIDI];
    if (max <= 0 || s < MATCH_REL * max) return false;
    // Its own lowest harmonics must be there: other notes' overtones can cover the
    // upper ones (E3's 3rd and 4th are B4 and E5).
    const f0 = midiHz(m);
    const h0 = f0 < 80 ? 2 : 1;
    const c = [0, 1, 2, 3].map((j) => this.contrast(this.acc, f0 * (h0 + j), f0));
    const top = Math.max(...c);
    if (Math.max(c[0], c[1]) < LOW_HARM * top) return false;
    // An overtone of a key already heard in this same strike.
    for (const d of OVERTONES) {
      const low = m - d;
      if (this.runMatched.has(low) && !t.together?.(m, low)) return false;
    }
    // The octave above is stronger: that's the key that was played; this one only
    // shares its harmonics (unless both are in the chord).
    const up = m + 12;
    if (up <= HI_MIDI && !t.together?.(m, up) && sal[up - LO_MIDI] >= s) return false;
    // Spectral leakage from a much louder neighbour a semitone away.
    for (const n of [m - 1, m + 1]) {
      if (n < LO_MIDI || n > HI_MIDI || t.together?.(m, n)) continue;
      if (sal[n - LO_MIDI] >= NEIGHBOUR * s) return false;
    }
    // A lower note whose overtones cover this key explains it better (the player hit
    // the octave below, say) — unless that lower note is also part of the chord.
    for (const d of SUBS) {
      const low = m - d;
      if (low < LO_MIDI || t.together?.(m, low)) continue;
      if (sal[low - LO_MIDI] < 1.1 * s) continue;
      // …and only if that lower key's own fundamental is really there.
      const lf = midiHz(low) * (midiHz(low) < 80 ? 2 : 1);
      const lc = [1, 2, 3].map((h) => this.contrast(this.acc, lf * h, midiHz(low)));
      if (lc[0] >= LOW_HARM * Math.max(...lc)) return false;
    }
    return true;
  }

  private wrongKeys(sal: Float32Array, max: number, t: ListenTargets): number[] {
    if (max <= 0 || this.eventPeak < this.threshold * WRONG_MIN) return [];
    // Take out everything the song's own nearby notes explain…
    const { acc, resid } = this;
    resid.set(acc);
    const explain = new Set<number>([...t.allowed, ...t.expected, ...this.eventMatched]);
    for (const m of explain) {
      if (m < LO_MIDI || m > HI_MIDI || sal[m - LO_MIDI] < 0.15 * max) continue;
      const f0 = midiHz(m);
      for (let h = 1; h <= 12 && f0 * h <= F_MAX; h++) {
        const [lo, hi] = this.bins(f0 * h);
        for (let k = lo; k <= hi; k++) resid[k] = 0;
      }
    }
    let total = 0;
    let left = 0;
    for (let k = this.kLo; k <= this.kHi; k++) {
      total += acc[k];
      left += resid[k];
    }
    if (total <= 0 || left < WRONG_RESIDUAL * total) return [];
    // …and see if what's left is clearly a key.
    const r = this.salienceAll(resid);
    let best = -1;
    // Down low the harmonics are too close together to tell keys apart reliably.
    for (let m = WRONG_LO; m <= HI_MIDI; m++) if (best < 0 || r.sal[m - LO_MIDI] > r.sal[best - LO_MIDI]) best = m;
    if (best < 0 || explain.has(best) || r.sal[best - LO_MIDI] < 0.5 * max) return [];
    // Its own fundamental (or, down low, its 2nd harmonic) has to be there.
    const f0 = midiHz(best) * (midiHz(best) < 80 ? 2 : 1);
    if (this.peak(resid, f0) < 0.25 * this.peak(resid, f0 * 2) && this.peak(resid, f0) < 0.25 * this.peak(resid, f0 * 3)) return [];
    // …and so does its 2nd harmonic: a struck string always has one. A lone peak with no
    // overtone is two keys of the song beating against each other (a note struck while
    // its octave still rings), not a key of its own. High up the 2nd harmonic is weak.
    if (f0 < WRONG_H2_BELOW && this.peak(resid, f0 * 2) < WRONG_H2 * this.peak(resid, f0)) return [];
    return [best];
  }
}
