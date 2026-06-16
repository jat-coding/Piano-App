import { extractAudioWithFfmpeg } from './ffmpeg';

/** Basic Pitch expects mono audio at this sample rate. */
export const TARGET_SR = 22050;

function decode(buf: ArrayBuffer): Promise<AudioBuffer> {
  // Use a fresh context; decodeAudioData detaches its input, so callers pass a copy.
  const Ctx: typeof AudioContext =
    window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctx();
  return ctx.decodeAudioData(buf).finally(() => ctx.close());
}

/** Render any AudioBuffer down to mono at the target sample rate. */
async function resampleToMono(buffer: AudioBuffer, sampleRate: number): Promise<Float32Array> {
  if (buffer.sampleRate === sampleRate && buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0).slice();
  }
  const length = Math.ceil(buffer.duration * sampleRate);
  const offline = new OfflineAudioContext(1, length, sampleRate);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination); // multi-channel → 1-channel downmixes per spec
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

export interface DecodeProgress {
  stage: (label: string) => void;
  ffmpegProgress?: (ratio: number) => void;
}

/**
 * Turn any supported audio/video file into a mono 22050Hz Float32Array.
 *
 * Audio and most browser-decodable video (mp4/webm) go straight through
 * decodeAudioData. Containers the browser rejects — typically iPhone .mov /
 * HEVC — fall back to ffmpeg.wasm, which demuxes the AAC audio to WAV.
 */
export async function fileToMonoAudio(
  file: File,
  progress?: DecodeProgress,
): Promise<Float32Array> {
  const raw = await file.arrayBuffer();

  let audioBuffer: AudioBuffer;
  try {
    progress?.stage('Decoding audio…');
    audioBuffer = await decode(raw.slice(0));
  } catch {
    // The browser couldn't decode this container — demux with ffmpeg.wasm.
    progress?.stage('Extracting audio (first-time tools download)…');
    const wav = await extractAudioWithFfmpeg(file, progress?.ffmpegProgress);
    audioBuffer = await decode(wav.buffer.slice(0) as ArrayBuffer);
  }

  progress?.stage('Preparing audio…');
  return resampleToMono(audioBuffer, TARGET_SR);
}

export function isAudioOrVideo(file: File): boolean {
  return /\.(mp3|wav|m4a|ogg|flac|aac|mp4|mov|webm|m4v)$/i.test(file.name);
}

export function isMidi(file: File): boolean {
  return /\.midi?$/i.test(file.name);
}
