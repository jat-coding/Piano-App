/// <reference lib="webworker" />
import * as tf from '@tensorflow/tfjs';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import { BasicPitch, outputToNotesPoly, noteFramesToTime } from '@spotify/basic-pitch';

const MODEL_URL = '/basic-pitch-model/model.json';
const FRAME_MS = (256 / 22050) * 1000; // model hop → ms per frame (~11.6ms)

export interface CleanupParams {
  onsetThresh: number; // confidence (0–1)
  frameThresh: number;
  minNoteLenMs: number;
}

export interface RawNote {
  startTimeSeconds: number;
  durationSeconds: number;
  pitchMidi: number;
  amplitude: number;
}

// Cached raw model output so cleanup-slider changes don't re-run inference.
let lastFrames: number[][] | null = null;
let lastOnsets: number[][] | null = null;

let basicPitch: BasicPitch | null = null;

/**
 * Use the SIMD-accelerated WASM backend, falling back to pure-JS CPU.
 *
 * We deliberately do NOT use WebGL in the worker: on iOS/WebKit, OffscreenCanvas
 * exists (so setBackend('webgl') reports success) but WebGL-in-worker is broken
 * and pathologically slow — which made transcription crawl/crash. WASM SIMD is
 * fast and reliable inside a worker on every platform.
 */
async function ensureBackend(): Promise<void> {
  setWasmPaths('/tfjs-wasm/');
  for (const backend of ['wasm', 'cpu']) {
    try {
      if (await tf.setBackend(backend)) {
        await tf.ready();
        return;
      }
    } catch {
      /* try the next backend */
    }
  }
  await tf.ready();
}

async function ensureModel(): Promise<BasicPitch> {
  if (basicPitch) return basicPitch;
  await ensureBackend();
  basicPitch = new BasicPitch(MODEL_URL);
  return basicPitch;
}

function derive(params: CleanupParams): RawNote[] {
  if (!lastFrames || !lastOnsets) return [];
  const minLenFrames = Math.max(1, Math.round(params.minNoteLenMs / FRAME_MS));
  const poly = outputToNotesPoly(
    lastFrames,
    lastOnsets,
    params.onsetThresh,
    params.frameThresh,
    minLenFrames,
    true,
  );
  return noteFramesToTime(poly).map((n) => ({
    startTimeSeconds: n.startTimeSeconds,
    durationSeconds: n.durationSeconds,
    pitchMidi: n.pitchMidi,
    amplitude: n.amplitude,
  }));
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'transcribe') {
      const model = await ensureModel();
      post({ type: 'backend', name: tf.getBackend() });
      const audio: Float32Array = msg.audio;
      post({ type: 'progress', percent: 0 });
      await model.evaluateModel(
        audio,
        (frames, onsets) => {
          lastFrames = frames;
          lastOnsets = onsets;
        },
        (percent: number) => post({ type: 'progress', percent }),
      );
      post({ type: 'notes', notes: derive(msg.params) });
    } else if (msg.type === 'rederive') {
      post({ type: 'notes', notes: derive(msg.params) });
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

function post(data: unknown): void {
  (self as unknown as Worker).postMessage(data);
}
