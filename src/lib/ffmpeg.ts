import type { FFmpeg } from '@ffmpeg/ffmpeg';

// ffmpeg-core is ~30MB; load from CDN on demand and let the service worker
// cache it so it's a one-time download. Must be the ESM build: Vite bundles
// @ffmpeg/ffmpeg's worker as a module worker, which can't importScripts the UMD
// build and fails with "failed to import ffmpeg-core.js" (seen 2026-10-12).
const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';

let ffmpegPromise: Promise<FFmpeg> | null = null;

async function getFfmpeg(onProgress?: (ratio: number) => void): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const { toBlobURL } = await import('@ffmpeg/util');
      const ffmpeg = new FFmpeg();
      ffmpeg.on('progress', ({ progress }) => onProgress?.(progress));
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

/**
 * Demux a file's audio track to a WAV using ffmpeg.wasm — 22050Hz mono by
 * default (what the model wants); video export asks for 48kHz stereo.
 * The video stream is dropped (`-vn`) — we never decode video.
 */
export async function extractAudioWithFfmpeg(
  file: Blob & { name?: string },
  onProgress?: (ratio: number) => void,
  format: { sampleRate: number; channels: number } = { sampleRate: 22050, channels: 1 },
): Promise<Uint8Array> {
  const ffmpeg = await getFfmpeg(onProgress);
  const { fetchFile } = await import('@ffmpeg/util');

  const ext = file.name?.split('.').pop() || 'mov';
  const input = `input.${ext}`;
  const output = 'output.wav';

  await ffmpeg.writeFile(input, await fetchFile(file));
  await ffmpeg.exec([
    '-i', input, '-vn',
    '-ac', String(format.channels),
    '-ar', String(format.sampleRate),
    output,
  ]);
  const data = await ffmpeg.readFile(output);
  await ffmpeg.deleteFile(input).catch(() => {});
  await ffmpeg.deleteFile(output).catch(() => {});

  // readFile returns Uint8Array for binary output.
  return data as Uint8Array;
}

/**
 * Add an audio track to a video-only MP4 without re-encoding the picture:
 * the WAV is encoded to AAC by ffmpeg.wasm. Used by video export when the
 * browser has no WebCodecs audio encoder (e.g. older iOS Safari).
 */
export async function muxAacWithFfmpeg(
  videoMp4: Uint8Array,
  wav: Uint8Array,
  onProgress?: (ratio: number) => void,
): Promise<Uint8Array> {
  const ffmpeg = await getFfmpeg();
  const report = ({ progress }: { progress: number }) => onProgress?.(progress);
  ffmpeg.on('progress', report);
  try {
    await ffmpeg.writeFile('v.mp4', videoMp4);
    await ffmpeg.writeFile('a.wav', wav);
    const code = await ffmpeg.exec([
      '-i', 'v.mp4', '-i', 'a.wav',
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart', '-shortest', 'out.mp4',
    ]);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    return (await ffmpeg.readFile('out.mp4')) as Uint8Array;
  } finally {
    ffmpeg.off('progress', report);
    for (const f of ['v.mp4', 'a.wav', 'out.mp4']) await ffmpeg.deleteFile(f).catch(() => {});
  }
}
