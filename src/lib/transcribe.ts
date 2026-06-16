import type { CleanupParams, RawNote } from './transcribe.worker';

export type { CleanupParams, RawNote };

export const DEFAULT_CLEANUP: CleanupParams = {
  onsetThresh: 0.5,
  frameThresh: 0.3,
  minNoteLenMs: 80,
};

let worker: Worker | null = null;
let pending: { resolve: (n: RawNote[]) => void; reject: (e: Error) => void } | null = null;
let progressCb: ((p: number) => void) | null = null;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === 'progress') progressCb?.(msg.percent);
    else if (msg.type === 'notes') {
      pending?.resolve(msg.notes);
      pending = null;
    } else if (msg.type === 'error') {
      pending?.reject(new Error(msg.message));
      pending = null;
    }
  };
  worker.onerror = (e) => {
    pending?.reject(new Error(e.message || 'Transcription worker crashed'));
    pending = null;
  };
  return worker;
}

/** Run Basic Pitch on mono 22050Hz audio. Resolves with raw timed notes. */
export function transcribe(
  audio: Float32Array,
  params: CleanupParams,
  onProgress: (percent: number) => void,
): Promise<RawNote[]> {
  const w = getWorker();
  progressCb = onProgress;
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    // Transfer the audio buffer to avoid a copy.
    w.postMessage({ type: 'transcribe', audio, params }, [audio.buffer]);
  });
}

/** Re-derive notes from the cached model output with new cleanup thresholds. */
export function rederive(params: CleanupParams): Promise<RawNote[]> {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    w.postMessage({ type: 'rederive', params });
  });
}
