import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { Song } from '../types';
import type { SongMedia } from '../lib/library';
import { ExportFrameRenderer, EXPORT_H, EXPORT_W, type ExportLayout } from './frameRenderer';
import { renderPianoAudio, sliceOriginalAudio, audioBufferToWav } from './exportAudio';
import { openVideo, type FrameSource } from './videoSource';
import type { SessionExport } from '../interactive/recording';

export const FPS = 30;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const VIDEO_BITRATE = 6_000_000;
const AUDIO_BITRATE = 160_000;
const KEYFRAME_EVERY = FPS * 2;
// Release tail after the last MIDI note so the final chord rings out.
const MIDI_TAIL = 1.5;

/** What the export will contain — decided up front so the dialog can say so honestly. */
export interface ExportPlan {
  layout: ExportLayout;
  /** 'original' = the uploaded recording (trimmed); 'piano' = Cascade's piano re-render. */
  sound: 'original' | 'piano';
  media: SongMedia | null;
  duration: number; // seconds
  /** Plain-language caveats to show before starting. */
  notes: string[];
  /** Draw the animated hands (Settings → Show hands). Defaults to on. */
  hands?: boolean;
  /** A play-along session: its timeline, hits, score card, and the player's own sound. */
  session?: SessionExport;
}

export interface ExportProgress {
  stage: string;
  ratio: number; // 0..1
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  mimeType: string;
  videoCodec: string;
  audioCodec: string;
  /** Wall-clock seconds the whole export took, and rendered frames per second. */
  elapsed: number;
  renderFps: number;
  warnings: string[];
}

/**
 * Debug hook for testing the fallback chain on a desktop browser:
 * localStorage['cascade.exportForce'] = 'opus' | 'ffmpeg' | 'webm'.
 */
function forced(): string {
  try {
    return localStorage.getItem('cascade.exportForce') ?? '';
  } catch {
    return '';
  }
}

/** The plan for "Export my session": falling notes, the session's own sound and length. */
export function planSessionExport(session: SessionExport): ExportPlan {
  return { layout: 'full', sound: 'piano', media: null, duration: session.track.duration, notes: [], session };
}

export function planExport(song: Song, media: SongMedia | null, kind: string | null): ExportPlan {
  const notes: string[] = [];
  let layout: ExportLayout = 'full';
  if (media?.kind === 'video') {
    layout = 'video';
  } else if (kind === 'video' && !media) {
    notes.push(
      "This song was added before videos were kept, so the export shows falling notes only. Add the video again to get it on top.",
    );
  }
  let sound: ExportPlan['sound'] = 'original';
  if (!media) {
    sound = 'piano';
    if (kind === 'audio' || kind === 'video') {
      notes.push(
        "The original recording wasn't saved with this older song, so the sound is Cascade's piano playing the notes. Add the file again to use the real recording.",
      );
    }
  }
  const duration = media
    ? Math.max(0.5, media.trimEnd - media.trimStart)
    : song.duration + MIDI_TAIL;
  return { layout, sound, media, duration, notes };
}

class Cancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'AbortError';
  }
}

function check(signal: AbortSignal): void {
  if (signal.aborted) throw new Cancelled();
}

/** Let React paint the progress bar and let Cancel clicks through. */
function breathe(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function pickVideoCodec(): Promise<{ codec: string; mux: 'avc' | 'vp9' | 'av1' } | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const candidates: { codec: string; mux: 'avc' | 'vp9' | 'av1' }[] = [
    { codec: 'avc1.640028', mux: 'avc' }, // H.264 High@4.0 — plays everywhere, incl. iPhone Photos
    { codec: 'avc1.4d0028', mux: 'avc' },
    { codec: 'avc1.42e028', mux: 'avc' },
    { codec: 'vp09.00.40.08', mux: 'vp9' },
    { codec: 'av01.0.08M.08', mux: 'av1' },
  ];
  for (const c of candidates) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported(videoConfig(c.codec));
      if (supported) return c;
    } catch {
      /* try the next */
    }
  }
  return null;
}

function videoConfig(codec: string): VideoEncoderConfig {
  return {
    codec,
    width: EXPORT_W,
    height: EXPORT_H,
    bitrate: VIDEO_BITRATE,
    framerate: FPS,
    ...(codec.startsWith('avc1') ? { avc: { format: 'avc' as const } } : {}),
  };
}

async function pickAudioCodec(): Promise<{ codec: string; mux: 'aac' | 'opus' } | null> {
  if (typeof AudioEncoder === 'undefined') return null;
  const force = forced();
  const candidates: { codec: string; mux: 'aac' | 'opus' }[] = [];
  if (force !== 'opus') candidates.push({ codec: 'mp4a.40.2', mux: 'aac' });
  candidates.push({ codec: 'opus', mux: 'opus' });
  for (const c of candidates) {
    try {
      const { supported } = await AudioEncoder.isConfigSupported({
        codec: c.codec,
        sampleRate: SAMPLE_RATE,
        numberOfChannels: CHANNELS,
        bitrate: AUDIO_BITRATE,
      });
      if (supported) return c;
    } catch {
      /* try the next */
    }
  }
  return null;
}

function safeName(name: string, plan?: ExportPlan): string {
  const base = name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Cascade';
  return base + (plan?.session ? ' - my session' : '') + ' - Cascade';
}

/**
 * Render a song to a vertical 1080x1920 video, entirely in this browser.
 * Frames are painted at exact song times (frame i = i/30 s) and encoded with
 * WebCodecs, so picture and sound line up regardless of device speed.
 */
export async function exportVideo(
  song: Song,
  plan: ExportPlan,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<ExportResult> {
  const t0 = performance.now();
  const warnings: string[] = [];
  const force = forced();

  // Fonts must be ready, or the first frames print letters in a fallback face.
  try {
    await Promise.all([
      document.fonts.load("600 30px 'Fraunces'"),
      document.fonts.load("700 30px 'Fraunces'"),
      document.fonts.load("500 30px 'Fraunces'"),
    ]);
  } catch {
    /* offline without cached fonts — Georgia is fine */
  }

  // ---- 1. sound ----
  onProgress({ stage: 'Preparing the sound…', ratio: 0 });
  let audio: AudioBuffer;
  if (plan.session) {
    audio = plan.session.audio;
  } else if (plan.sound === 'original' && plan.media) {
    try {
      audio = await sliceOriginalAudio(plan.media, plan.duration, SAMPLE_RATE, (label) =>
        onProgress({ stage: label, ratio: 0.01 }),
      );
    } catch (err) {
      console.error(err);
      warnings.push("Couldn't read the original recording, so Cascade's piano plays the notes instead.");
      plan = { ...plan, sound: 'piano' };
      audio = await renderPianoAudio(song, plan.duration, SAMPLE_RATE);
    }
  } else {
    onProgress({ stage: 'Playing the notes on the piano…', ratio: 0.01 });
    audio = await renderPianoAudio(song, plan.duration, SAMPLE_RATE);
  }
  check(signal);

  // ---- 2. picture source ----
  let video: FrameSource | null = null;
  let layout = plan.layout;
  if (layout === 'video' && plan.media) {
    try {
      onProgress({ stage: 'Opening your video…', ratio: 0.03 });
      video = await openVideo(plan.media.blob, plan.media.trimStart);
      console.info('[export] video frames via', video.method);
    } catch (err) {
      console.error(err);
      warnings.push(`Couldn't read the video frames (${(err as Error).message}), so this export shows falling notes only.`);
      layout = 'full';
    }
  }
  check(signal);

  const renderer = new ExportFrameRenderer(song, layout, plan.hands ?? true, plan.session?.track ?? null);
  const totalFrames = Math.max(1, Math.round(plan.duration * FPS));
  const vCodec = force === 'webm' ? null : await pickVideoCodec();

  try {
    if (!vCodec) {
      warnings.push("This browser has no video encoder, so the video was recorded in real time (it takes as long as the song, and quality may be lower).");
      return await recordRealtime(renderer, audio, video, plan, totalFrames, onProgress, signal, warnings, t0, song);
    }
    const aCodec = force === 'ffmpeg' ? null : await pickAudioCodec();

    // ---- 3. encode ----
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: vCodec.mux, width: EXPORT_W, height: EXPORT_H, frameRate: FPS },
      ...(aCodec
        ? { audio: { codec: aCodec.mux, numberOfChannels: CHANNELS, sampleRate: SAMPLE_RATE } }
        : {}),
      fastStart: 'in-memory',
    });

    let encodeError: Error | null = null;
    const fail = (e: DOMException) => {
      encodeError = new Error(`The encoder stopped: ${e.message}`);
    };

    if (aCodec) {
      onProgress({ stage: 'Encoding the sound…', ratio: 0.04 });
      await encodeAudio(audio, aCodec.codec, muxer, fail);
      if (encodeError) throw encodeError;
    }
    check(signal);

    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: fail,
    });
    encoder.configure(videoConfig(vCodec.codec));

    const renderStart = performance.now();
    let lastReport = 0;
    for (let i = 0; i < totalFrames; i++) {
      if (signal.aborted) {
        encoder.close();
        throw new Cancelled();
      }
      if (encodeError) throw encodeError;
      const t = i / FPS;
      const pic = video && plan.media ? await video.frameAt(plan.media.trimStart + t) : null;
      renderer.draw(t, pic);
      const frame = new VideoFrame(renderer.canvas, {
        timestamp: Math.round((i * 1e6) / FPS),
        duration: Math.round(1e6 / FPS),
      });
      encoder.encode(frame, { keyFrame: i % KEYFRAME_EVERY === 0 });
      frame.close();

      // Backpressure: don't queue the whole song in the encoder's memory.
      while (encoder.encodeQueueSize > 4) await breathe();

      const now = performance.now();
      if (now - lastReport > 120) {
        lastReport = now;
        const fps = (i + 1) / ((now - renderStart) / 1000);
        const left = Math.max(0, Math.round((totalFrames - i - 1) / Math.max(fps, 0.1)));
        onProgress({
          stage: `Rendering video… about ${formatLeft(left)} left`,
          ratio: 0.05 + 0.9 * ((i + 1) / totalFrames),
        });
        await breathe();
      }
    }
    onProgress({ stage: 'Finishing…', ratio: 0.96 });
    await encoder.flush();
    encoder.close();
    if (encodeError) throw encodeError;
    const renderFps = totalFrames / ((performance.now() - renderStart) / 1000);
    muxer.finalize();

    let bytes: Uint8Array = new Uint8Array(target.buffer);
    let audioCodec = aCodec?.codec ?? '';
    if (!aCodec) {
      onProgress({ stage: 'Adding the sound (first-time tools download)…', ratio: 0.97 });
      const { muxAacWithFfmpeg } = await import('../lib/ffmpeg');
      bytes = await muxAacWithFfmpeg(bytes, audioBufferToWav(audio));
      audioCodec = 'aac (ffmpeg.wasm)';
      warnings.push('This browser has no built-in audio encoder, so the sound was added with a slower helper.');
    }
    check(signal);

    return {
      blob: new Blob([bytes as BlobPart], { type: 'video/mp4' }),
      fileName: `${safeName(song.name, plan)}.mp4`,
      mimeType: 'video/mp4',
      videoCodec: vCodec.codec,
      audioCodec,
      elapsed: (performance.now() - t0) / 1000,
      renderFps,
      warnings,
    };
  } finally {
    video?.close();
  }
}

function formatLeft(sec: number): string {
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}

async function encodeAudio(
  buffer: AudioBuffer,
  codec: string,
  muxer: Muxer<ArrayBufferTarget>,
  fail: (e: DOMException) => void,
): Promise<void> {
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: fail,
  });
  encoder.configure({
    codec,
    sampleRate: SAMPLE_RATE,
    numberOfChannels: CHANNELS,
    bitrate: AUDIO_BITRATE,
  });
  const chans = [buffer.getChannelData(0), buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0)];
  const CHUNK = 4800; // 100ms
  for (let off = 0; off < buffer.length; off += CHUNK) {
    const n = Math.min(CHUNK, buffer.length - off);
    const planar = new Float32Array(n * CHANNELS);
    planar.set(chans[0].subarray(off, off + n), 0);
    planar.set(chans[1].subarray(off, off + n), n);
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: SAMPLE_RATE,
      numberOfFrames: n,
      numberOfChannels: CHANNELS,
      timestamp: Math.round((off * 1e6) / SAMPLE_RATE),
      data: planar,
    });
    encoder.encode(data);
    data.close();
    if (encoder.encodeQueueSize > 20) await breathe();
  }
  await encoder.flush();
  encoder.close();
}

/**
 * Last-resort path for browsers without WebCodecs video: draw in real time and
 * record the canvas + sound with MediaRecorder. Takes as long as the song.
 */
async function recordRealtime(
  renderer: ExportFrameRenderer,
  audio: AudioBuffer,
  video: FrameSource | null,
  plan: ExportPlan,
  totalFrames: number,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
  warnings: string[],
  t0: number,
  song: Song,
): Promise<ExportResult> {
  if (typeof MediaRecorder === 'undefined' || !renderer.canvas.captureStream) {
    throw new Error("This browser can't make videos (no video encoder and no recorder).");
  }
  const types = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.resume();
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = audio;
  src.connect(dest);
  const stream = new MediaStream([
    ...renderer.canvas.captureStream(FPS).getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: VIDEO_BITRATE } : {});
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));

  const at = (t: number) => (video && plan.media ? video.frameAt(plan.media.trimStart + t) : Promise.resolve(null));
  renderer.draw(0, await at(0));
  rec.start(1000);
  const start = ctx.currentTime + 0.05;
  src.start(start);
  try {
    await new Promise<void>((resolve, reject) => {
      const tick = async () => {
        if (signal.aborted) return reject(new Cancelled());
        const t = Math.max(0, ctx.currentTime - start);
        renderer.draw(t, await at(t).catch(() => null));
        onProgress({ stage: 'Recording video in real time…', ratio: 0.05 + 0.9 * Math.min(1, t / plan.duration) });
        if (t >= plan.duration) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } finally {
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    src.disconnect();
    await ctx.close();
  }
  const type = rec.mimeType || mimeType || 'video/webm';
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  const elapsed = (performance.now() - t0) / 1000;
  return {
    blob: new Blob(parts, { type }),
    fileName: `${safeName(song.name, plan)}.${ext}`,
    mimeType: type,
    videoCodec: type,
    audioCodec: type,
    elapsed,
    renderFps: totalFrames / elapsed,
    warnings,
  };
}
