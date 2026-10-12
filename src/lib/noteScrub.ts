import type { PlaybackEngine } from '../audio/playback';

const DRAG_SLOP = 9; // px a press must travel before it counts as a drag, not a tap
const FLICK_WINDOW = 0.1; // s of recent movement that sets the release speed
const FLICK_MIN = 300; // px/s release speed that starts a coast
const MAX_COAST = 5000; // px/s
const FRICTION = 3; // 1/s — coast speed decays as e^(-FRICTION·t)
const COAST_STOP = 12; // px/s — a coast slower than this is over
const WHEEL_IDLE = 0.25; // s after the last wheel event that ends a wheel scrub
const LINE_PX = 16; // wheel deltaMode 1 (lines) → px

type State = 'idle' | 'pressed' | 'dragging' | 'coasting' | 'wheel';

export interface NoteScrubHost {
  engine: PlaybackEngine;
  /** Current fall speed — 1 px of finger travel = 1/pps song seconds. */
  pixelsPerSecond(): number;
  /** A tap on the notes (no drag). */
  onTap(): void;
  /** Normal playback stops while scrubbing… */
  onPause(): void;
  /** …and comes back afterwards if it was playing before. */
  onResume(): void;
}

/**
 * Drag the falling notes to move through the song: drag down = forward, up = back,
 * 1:1 with the finger. A flick coasts and slows, a touch stops it, the song's start
 * and end are a soft stop. A press that never travels DRAG_SLOP is a tap. Only the
 * clock moves — the renderer still draws purely from engine.songTime.
 */
export class NoteScrub {
  private state: State = 'idle';
  private pointerId = -1;
  private startY = 0;
  private startX = 0;
  private anchorTime = 0; // song time when the drag began
  private samples: { t: number; y: number }[] = [];
  private velocity = 0; // px/s while coasting (+ = notes moving down = forward)
  /** Last release, for the headless tests: speed (px/s) and the movement it was read from. */
  lastRelease = { v: 0, samples: 0, sinceLastMove: 0 };
  private homing = false; // coast is braking into the start/end
  private lastStep = 0;
  private lastWheel = 0;
  private inSession = false; // a scrub is under way (playback paused for it)
  private wasPlaying = false;

  constructor(private host: NoteScrubHost) {}

  /** Busy scrubbing or coasting — the caller should route presses here. */
  get active(): boolean {
    return this.state !== 'idle';
  }
  get coasting(): boolean {
    return this.state === 'coasting';
  }

  pointerDown(id: number, x: number, y: number, t: number): void {
    if (this.state === 'pressed' || this.state === 'dragging') return; // second finger
    // A touch during a coast (or a wheel scrub) stops it; the session carries on
    // until the finger lifts, so a tap here doesn't also toggle play/pause.
    this.velocity = 0;
    this.state = 'pressed';
    this.pointerId = id;
    this.startX = x;
    this.startY = y;
    this.samples = [{ t, y }];
  }

  pointerMove(id: number, x: number, y: number, t: number): void {
    if (id !== this.pointerId) return;
    if (this.state === 'pressed') {
      if (Math.hypot(x - this.startX, y - this.startY) < DRAG_SLOP) return;
      this.begin();
      this.anchorTime = this.host.engine.songTime;
      this.state = 'dragging';
    }
    if (this.state !== 'dragging') return;
    this.samples.push({ t, y });
    while (this.samples.length > 2 && t - this.samples[0].t > FLICK_WINDOW) this.samples.shift();
    this.host.engine.scrubTo(this.anchorTime + (y - this.startY) / this.host.pixelsPerSecond());
  }

  pointerUp(id: number, t: number, cancelled = false): void {
    if (id !== this.pointerId) return;
    this.pointerId = -1;
    if (this.state === 'pressed') {
      this.state = 'idle';
      if (this.inSession) this.end();
      else if (!cancelled) this.host.onTap();
      return;
    }
    if (this.state !== 'dragging') return;
    const v = cancelled ? 0 : this.releaseVelocity(t);
    this.lastRelease = { v, samples: this.samples.length, sinceLastMove: t - this.samples[this.samples.length - 1].t };
    if (Math.abs(v) >= FLICK_MIN) {
      this.velocity = Math.max(-MAX_COAST, Math.min(MAX_COAST, v));
      this.homing = false;
      this.lastStep = t;
      this.state = 'coasting';
    } else {
      this.state = 'idle';
      this.end();
    }
  }

  /** deltaY as reported by a wheel event; a trackpad swipe down moves forward. */
  wheel(deltaY: number, deltaMode: number, t: number): void {
    if (this.state === 'pressed' || this.state === 'dragging') return;
    if (this.state === 'idle') this.begin();
    this.velocity = 0;
    this.state = 'wheel';
    this.lastWheel = t;
    const px = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * 400 : deltaY;
    const e = this.host.engine;
    e.scrubTo(e.songTime - px / this.host.pixelsPerSecond());
  }

  /** Once per animation frame, before the engine ticks. t in seconds. */
  step(t: number, duration: number): void {
    if (this.state === 'wheel' && t - this.lastWheel > WHEEL_IDLE) {
      this.state = 'idle';
      this.end();
      return;
    }
    if (this.state !== 'coasting') return;
    const dt = Math.min(0.1, Math.max(0, t - this.lastStep));
    this.lastStep = t;
    const pps = this.host.pixelsPerSecond();
    const e = this.host.engine;

    // Soft stop: if the glide left would carry past the start/end, slow it so it
    // comes to rest exactly there instead of hitting the wall.
    const room = (this.velocity > 0 ? duration - e.songTime : e.songTime) * pps;
    // Latched: once braking, rounding must not let it decide it will fall short.
    if (Math.abs(this.velocity) / FRICTION >= room) this.homing = true;
    const homing = this.homing;
    if (homing) this.velocity = Math.sign(this.velocity) * room * FRICTION;

    const decay = Math.exp(-FRICTION * dt);
    const travel = (this.velocity / FRICTION) * (1 - decay); // exact for exponential decay
    this.velocity *= decay;
    const now = e.scrubTo(e.songTime + travel / pps);

    const atEdge = (now <= 0 && this.velocity < 0) || (now >= duration && this.velocity > 0);
    if (Math.abs(this.velocity) < COAST_STOP || atEdge || room < 0.5) {
      // The braked glide only reaches the edge in the limit; finish the last few px.
      if (homing) e.scrubTo(this.velocity > 0 ? duration : 0);
      this.velocity = 0;
      this.state = 'idle';
      this.end();
    }
  }

  /** End a coast or wheel scrub now (e.g. the slim bar was grabbed), resuming as usual. */
  stop(): void {
    if (this.state !== 'coasting' && this.state !== 'wheel') return;
    this.velocity = 0;
    this.state = 'idle';
    this.end();
  }

  /** Drop everything without resuming (song changed, export opened). */
  reset(): void {
    if (this.inSession) this.host.engine.endScrub();
    this.inSession = false;
    this.state = 'idle';
    this.pointerId = -1;
    this.velocity = 0;
  }

  private releaseVelocity(t: number): number {
    const s = this.samples;
    // Finger held still before lifting → no flick.
    if (s.length < 2 || t - s[s.length - 1].t > FLICK_WINDOW) return 0;
    const a = s[0];
    const b = s[s.length - 1];
    const dt = b.t - a.t;
    return dt > 0 ? (b.y - a.y) / dt : 0;
  }

  private begin(): void {
    if (this.inSession) return;
    this.inSession = true;
    this.wasPlaying = this.host.engine.playing;
    if (this.wasPlaying) this.host.onPause();
    this.host.engine.beginScrub();
  }

  private end(): void {
    if (!this.inSession) return;
    this.inSession = false;
    this.host.engine.endScrub();
    if (this.wasPlaying) this.host.onResume();
  }
}
