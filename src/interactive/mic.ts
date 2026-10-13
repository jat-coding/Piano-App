import type { SpectrumSource } from './session';
import { Spectrum } from './fft';

/**
 * The microphone for play along: the mic's samples, for the listener (a spectrum at
 * any moment of the last ~0.7s) and as a raw recording of everything it heard (the
 * session video's soundtrack). Everything stays on the device. Clock = the
 * AudioContext's own time, so the recording, the listener and the session timeline
 * all share one clock.
 */

export type MicErrorKind = 'denied' | 'missing' | 'insecure' | 'busy' | 'other';

export class MicError extends Error {
  constructor(
    readonly kind: MicErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const FFT_SIZE = 4096;
const CHUNK = 512; // frames per message from the recorder worklet (~11ms: the listener waits on these)
const RING = 32768; // newest samples kept for the listener (~0.7s)

// Copies the mic's samples (mono) to the main thread in CHUNK-sized pieces, stamped with
// the context frame they start at. Loaded from a Blob URL so no extra file ships.
const RECORDER = `
class CascadeRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${CHUNK}); this.n = 0; this.start = 0; }
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch[0]) {
      const a = ch[0], b = ch[1];
      for (let i = 0; i < a.length; i++) {
        if (this.n === 0) this.start = currentFrame + i;
        this.buf[this.n++] = b ? (a[i] + b[i]) * 0.5 : a[i];
        if (this.n === ${CHUNK}) {
          this.port.postMessage({ f: this.start, d: this.buf }, [this.buf.buffer]);
          this.buf = new Float32Array(${CHUNK});
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('cascade-recorder', CascadeRecorder);
`;

export class MicInput implements SpectrumSource {
  readonly fftSize = FFT_SIZE;
  private chunks: { f: number; d: Float32Array }[] = [];
  private recording = true;
  private ring = new Float32Array(RING);
  /** Context frame just after the newest sample in the ring. */
  private ringEnd = -1;
  private spectrum = new Spectrum(FFT_SIZE);

  private constructor(
    readonly ctx: AudioContext,
    private stream: MediaStream,
    private nodes: AudioNode[],
  ) {}

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  /** Ask for the mic (shows the browser's permission prompt). Call from a tap. */
  static async open(): Promise<MicInput> {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      throw new MicError('insecure', 'The microphone only works when the app is opened over a secure (https) link.');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicError('missing', "This browser doesn't give apps access to a microphone.");
    }
    // The context is made inside the same tap, so iPhone lets it start.
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      void ctx.close();
      throw micError(err);
    }
    try {
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      // Nodes only run when something pulls them: route the recorder into a muted
      // gain, so the mic is never played out loud.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      mute.connect(ctx.destination);
      const url = URL.createObjectURL(new Blob([RECORDER], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const rec = new AudioWorkletNode(ctx, 'cascade-recorder', { numberOfOutputs: 1 });
      src.connect(rec);
      rec.connect(mute);
      const mic = new MicInput(ctx, stream, [src, mute, rec]);
      rec.port.onmessage = (e) => mic.receive(e.data as { f: number; d: Float32Array });
      return mic;
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      throw new MicError('other', `The microphone couldn't be started (${(err as Error).message}).`);
    }
  }

  now(): number {
    return this.ctx.currentTime;
  }

  private receive(c: { f: number; d: Float32Array }): void {
    if (this.recording) this.chunks.push(c);
    const { ring } = this;
    for (let i = 0; i < c.d.length; i++) ring[(c.f + i) % RING] = c.d[i];
    this.ringEnd = Math.max(this.ringEnd, c.f + c.d.length);
  }

  latest(): number {
    return this.ringEnd < 0 ? this.now() : this.ringEnd / this.ctx.sampleRate;
  }

  readAt(t: number, mag: Float32Array): void {
    const { ring } = this;
    const end = Math.min(this.ringEnd, Math.round(t * this.ctx.sampleRate));
    const from = end - FFT_SIZE;
    const oldest = this.ringEnd - RING;
    this.spectrum.compute((i) => {
      const f = from + i;
      return f >= 0 && f >= oldest ? ring[f % RING] : 0;
    }, mag);
  }

  /** Drop what was recorded and start keeping sound again (a new attempt). */
  restartRecording(): void {
    this.chunks = [];
    this.recording = true;
  }

  /** Stop keeping new sound (the listener keeps working). */
  stopRecording(): void {
    this.recording = false;
  }

  /** The recorded sound between two clock times, mono at the context's rate. Gaps are silent. */
  samples(from: number, to: number): Float32Array<ArrayBuffer> {
    const sr = this.ctx.sampleRate;
    const f0 = Math.round(from * sr);
    const out = new Float32Array(Math.max(0, Math.round(to * sr) - f0));
    for (const c of this.chunks) {
      const off = c.f - f0;
      if (off >= out.length || off + c.d.length <= 0) continue;
      const a = Math.max(0, -off);
      const b = Math.min(c.d.length, out.length - off);
      out.set(c.d.subarray(a, b), off + a);
    }
    return out;
  }

  close(): void {
    this.stream.getTracks().forEach((t) => t.stop());
    for (const n of this.nodes) n.disconnect();
    void this.ctx.close();
  }
}

function micError(err: unknown): MicError {
  const name = (err as DOMException)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return new MicError(
      'denied',
      'Cascade isn’t allowed to use the microphone. Allow it for this site (on iPhone: Settings → Safari → Microphone, or the “aA” menu → Website Settings), then try again.',
    );
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return new MicError('missing', 'No microphone was found on this device.');
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return new MicError('busy', 'The microphone is busy — another app may be using it. Close it and try again.');
  }
  return new MicError('other', `The microphone couldn't be opened (${(err as Error)?.message ?? String(err)}).`);
}
