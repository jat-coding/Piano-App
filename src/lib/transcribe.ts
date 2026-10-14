import type { CleanupParams, RawNote } from './transcribe.worker';

export type { CleanupParams, RawNote };

/** Which engine produced a song's notes. Accuracy differs a lot, so the UI says which. */
export type TranscriptionEngine = 'transkun' | 'basic-pitch';

export const ENGINE_LABEL: Record<TranscriptionEngine, string> = {
  transkun: 'Desktop engine (high accuracy)',
  'basic-pitch': 'On-device engine',
};

export interface TranscribeResult {
  notes: RawNote[];
  engine: TranscriptionEngine;
  /** Desktop only: 'cuda' or 'cpu', as reported by the helper. */
  device?: string;
  /** Desktop only: sustain-pedal spans (cc 64/66/67). Not used by the app yet. */
  pedals?: { cc: number; startTimeSeconds: number; endTimeSeconds: number }[];
}

/** Same-origin route the :5191 preview server proxies to the desktop Transkun helper. */
const DESKTOP_URL = '/api/transcribe';
/** The desktop engine runs at this rate (Transkun's model is fixed at 44.1 kHz). */
export const DESKTOP_SR = 44100;
/** Generous: the helper may be on CPU (≈ 1.3x real time) or busy with another job. */
const DESKTOP_TIMEOUT_MS = 15 * 60 * 1000;

export const DEFAULT_CLEANUP: CleanupParams = {
  onsetThresh: 0.5,
  frameThresh: 0.3,
  minNoteLenMs: 80,
};

let worker: Worker | null = null;
let desktopAbort: AbortController | null = null;
let pending: { resolve: (n: RawNote[]) => void; reject: (e: Error) => void } | null = null;
let progressCb: ((p: number) => void) | null = null;
let backendCb: ((name: string) => void) | null = null;

function killWorker(): void {
  worker?.terminate();
  worker = null;
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === 'progress') progressCb?.(msg.percent);
    else if (msg.type === 'backend') backendCb?.(msg.name);
    else if (msg.type === 'notes') {
      pending?.resolve(msg.notes);
      pending = null;
    } else if (msg.type === 'error') {
      pending?.reject(new Error(msg.message));
      pending = null;
    }
  };
  worker.onerror = (e) => {
    // A crashed worker can't be reused — drop it so the next run starts fresh.
    pending?.reject(new Error(e.message || 'Transcription worker crashed'));
    pending = null;
    killWorker();
  };
  return worker;
}

/** Mono Float32 → 16-bit PCM WAV bytes. */
function encodeWav(audio: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + audio.length * 2);
  const v = new DataView(buf);
  const str = (o: number, t: string) => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + audio.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, audio.length * 2, true);
  for (let i = 0; i < audio.length; i++) {
    const x = Math.max(-1, Math.min(1, audio[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return buf;
}

function isRawNote(n: unknown): n is RawNote {
  const r = n as RawNote;
  return (
    !!r &&
    Number.isFinite(r.startTimeSeconds) &&
    Number.isFinite(r.durationSeconds) &&
    Number.isFinite(r.pitchMidi) &&
    Number.isFinite(r.amplitude)
  );
}

/**
 * Ask the desktop helper (Transkun) to transcribe. Returns null for ANY reason it can't
 * (no proxy on this host → 404, helper down → 502/504, HTML instead of JSON, network
 * error, timeout), so the caller falls back to the on-device engine. Throws only an
 * AbortError, when the user cancelled.
 */
async function transcribeOnDesktop(audio44: Float32Array): Promise<TranscribeResult | null> {
  const ctrl = new AbortController();
  desktopAbort = ctrl;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, DESKTOP_TIMEOUT_MS);
  try {
    const res = await fetch(DESKTOP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: encodeWav(audio44, DESKTOP_SR),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn(`Desktop engine unavailable (HTTP ${res.status}); using the on-device engine`);
      return null;
    }
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
      console.warn('Desktop engine reply was not JSON; using the on-device engine');
      return null;
    }
    const body = await res.json();
    if (!body || body.engine !== 'transkun' || !Array.isArray(body.notes) || !body.notes.every(isRawNote)) {
      console.warn('Desktop engine reply had no usable notes; using the on-device engine');
      return null;
    }
    return { notes: body.notes, engine: 'transkun', device: body.device, pedals: body.pedals };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError' && !timedOut) throw err; // user cancel
    console.warn('Desktop engine unreachable; using the on-device engine', err);
    return null;
  } finally {
    clearTimeout(timer);
    if (desktopAbort === ctrl) desktopAbort = null;
  }
}

/** Run Basic Pitch on mono 22050Hz audio in the worker. Resolves with raw timed notes. */
function transcribeOnDevice(
  audio: Float32Array,
  params: CleanupParams,
  onProgress: (percent: number) => void,
  onBackend?: (name: string) => void,
): Promise<RawNote[]> {
  const w = getWorker();
  progressCb = onProgress;
  backendCb = onBackend ?? null;
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    // Transfer the audio buffer to avoid a copy.
    w.postMessage({ type: 'transcribe', audio, params }, [audio.buffer]);
  });
}

/**
 * Transcribe a clip: the desktop engine first (when a 44.1 kHz copy is available), the
 * on-device Basic Pitch worker if the desktop can't do it. The desktop attempt happens
 * BEFORE the 22.05 kHz buffer is handed (transferred) to the worker, so the fallback
 * always still has its audio.
 */
export async function transcribe(
  audio: Float32Array,
  audio44: Float32Array | null,
  params: CleanupParams,
  onProgress: (percent: number) => void,
  onStage: (label: string) => void,
): Promise<TranscribeResult> {
  if (audio44) {
    onStage('Transcribing on desktop…');
    onProgress(-1);
    const r = await transcribeOnDesktop(audio44);
    if (r) return r;
    onStage('Desktop engine unavailable, transcribing on your device…');
  }
  const notes = await transcribeOnDevice(audio, params, onProgress, (backend) =>
    onStage(`Transcribing on your device (${backend})…`),
  );
  return { notes, engine: 'basic-pitch' };
}

/**
 * Abort an in-flight transcription: abort the desktop request, terminate the worker
 * (which immediately stops Basic Pitch inference) and reject the pending promise. A fresh worker
 * is created on the next transcribe().
 */
export function cancelTranscription(): void {
  // Abort the desktop request too: the proxy drops the upstream socket and the helper stops
  // the GPU job at its next segment.
  desktopAbort?.abort();
  desktopAbort = null;
  if (worker) {
    worker.terminate();
    worker = null;
  }
  if (pending) {
    pending.reject(new DOMException('Transcription cancelled', 'AbortError'));
    pending = null;
  }
  progressCb = null;
}

/** Desktop songs: apply Min-length on the notes the helper returned (no worker involved). */
export function filterMinLength(notes: RawNote[], minNoteLenMs: number): RawNote[] {
  return notes.filter((n) => n.durationSeconds * 1000 >= minNoteLenMs);
}

/**
 * Re-derive notes from the cached model output with new cleanup thresholds.
 * Basic Pitch songs only: the worker holds no frames for desktop-transcribed songs and
 * would return an empty list (pipeline.updateCleanup never calls this for them).
 */
export function rederive(params: CleanupParams): Promise<RawNote[]> {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    w.postMessage({ type: 'rederive', params });
  });
}
