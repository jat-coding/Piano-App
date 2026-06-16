import type { FFmpeg } from '@ffmpeg/ffmpeg';

// ffmpeg-core is ~30MB; load from CDN on demand and let the service worker
// cache it so it's a one-time download.
const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd';

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
 * Demux a file's audio track to a 22050Hz mono WAV using ffmpeg.wasm.
 * The video stream is dropped (`-vn`) — we never decode video.
 */
export async function extractAudioWithFfmpeg(
  file: File,
  onProgress?: (ratio: number) => void,
): Promise<Uint8Array> {
  const ffmpeg = await getFfmpeg(onProgress);
  const { fetchFile } = await import('@ffmpeg/util');

  const ext = file.name.split('.').pop() || 'mov';
  const input = `input.${ext}`;
  const output = 'output.wav';

  await ffmpeg.writeFile(input, await fetchFile(file));
  await ffmpeg.exec(['-i', input, '-vn', '-ac', '1', '-ar', '22050', output]);
  const data = await ffmpeg.readFile(output);
  await ffmpeg.deleteFile(input).catch(() => {});
  await ffmpeg.deleteFile(output).catch(() => {});

  // readFile returns Uint8Array for binary output.
  return data as Uint8Array;
}
