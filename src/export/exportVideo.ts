import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { Song } from '../types';
import type { SongMedia } from '../lib/library';
import type { ViewStyle } from '../render/perspective';
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
  /** Falling-note view style (Home → Profile, or picked in the dialog). Defaults to classic. */
  viewStyle?: ViewStyle;
  /** A play-along session: its timeline, hits, score card, and the player's own sound. */
  session?: SessionExport;
  /** The song's original video is kept, so it can go on top (layout 'video') if the user wants. */
  canStack?: boolean;
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
 * localStorage['cascade.exportForce'] = 'opus' | 'ffmpeg' | 'webm' | 'nodesc' | 'webkit' | 'webkit-raw'.
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
  // The original video only goes on top when the user turns it on in the dialog
  // (plan.canStack says whether that's offered); plain falling notes by default.
  const layout: ExportLayout = 'full';
  const canStack = media?.kind === 'video';
  if (kind === 'video' && !media) {
    notes.push(
      "This song was added before videos were kept, so its original video can't be shown in the export. Add the video again to get that option.",
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
  return { layout, sound, media, duration, notes, canStack };
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

/** Safari, and every browser on iPhone/iPad (they all run Apple's WebKit). */
function isAppleWebKit(): boolean {
  const ua = navigator.userAgent;
  return /iP(hone|ad|od)/.test(ua) || (/AppleWebKit/.test(ua) && !/(Chrome|Chromium|Edg|OPR)\//.test(ua));
}

async function pickAudioCodec(): Promise<{ codec: string; mux: 'aac' | 'opus' } | null> {
  if (typeof AudioEncoder === 'undefined') return null;
  const force = forced();
  const candidates: { codec: string; mux: 'aac' | 'opus' }[] = [];
  if (force !== 'opus') candidates.push({ codec: 'mp4a.40.2', mux: 'aac' });
  // Apple's Photos/QuickTime don't reliably play Opus inside an MP4, so on Apple
  // browsers a missing AAC encoder goes to the ffmpeg AAC route instead.
  if (force === 'opus' || !isAppleWebKit()) candidates.push({ codec: 'opus', mux: 'opus' });
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

  // Size the video band to the recording's shape (see ExportFrameRenderer).
  let videoAspect: number | undefined;
  if (video && plan.media) {
    const first = await video.frameAt(plan.media.trimStart);
    if (first && first.width > 0 && first.height > 0) {
      const sideways = first.rotation === 90 || first.rotation === 270;
      videoAspect = sideways ? first.width / first.height : first.height / first.width;
    }
  }
  const renderer = new ExportFrameRenderer(
    song,
    layout,
    plan.hands ?? true,
    plan.session?.track ?? null,
    videoAspect,
    plan.viewStyle ?? 'classic',
  );
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

    // Kept so the picture can be re-muxed without the sound if the sound check fails.
    const videoChunks: { chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }[] = [];
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        muxer.addVideoChunk(chunk, meta);
        if (aCodec) videoChunks.push({ chunk, meta });
      },
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
    const addSoundWithFfmpeg = async () => {
      onProgress({ stage: 'Adding the sound (first-time tools download)…', ratio: 0.97 });
      const { muxAacWithFfmpeg } = await import('../lib/ffmpeg');
      if (aCodec) {
        // ffmpeg can't open a file whose sound track is broken, so start from the picture alone.
        const pictureOnly = new ArrayBufferTarget();
        const remux = new Muxer({
          target: pictureOnly,
          video: { codec: vCodec.mux, width: EXPORT_W, height: EXPORT_H, frameRate: FPS },
          fastStart: 'in-memory',
        });
        for (const v of videoChunks) remux.addVideoChunk(v.chunk, v.meta);
        remux.finalize();
        videoChunks.length = 0;
        bytes = new Uint8Array(pictureOnly.buffer);
      }
      bytes = await muxAacWithFfmpeg(bytes, audioBufferToWav(audio));
      audioCodec = 'aac (ffmpeg.wasm)';
    };
    if (!aCodec) {
      await addSoundWithFfmpeg();
      warnings.push('This browser has no built-in audio encoder, so the sound was added with a slower helper.');
    }
    check(signal);

    // Play the finished file's sound back in this browser before handing it over. A
    // browser's own encoder can return a track that's there but won't play (seen as a
    // silent export on iPhone); if so, redo the sound with the ffmpeg route.
    onProgress({ stage: 'Checking the sound…', ratio: 0.98 });
    let heard = await soundCheck(bytes, audio);
    console.info('[export] sound check', audioCodec, heard);
    if (heard.verdict !== 'ok' && aCodec) {
      await addSoundWithFfmpeg();
      heard = await soundCheck(bytes, audio);
      console.info('[export] sound check after ffmpeg', heard);
      warnings.push("This browser's built-in sound encoder made a silent track, so the sound was added with a slower helper.");
    }
    if (heard.verdict === 'source-silent') {
      warnings.push(
        plan.session?.track.sound === 'mic'
          ? 'The microphone recorded no sound during this session, so the video is silent.'
          : 'The sound for this song is silent, so the video is too.',
      );
    } else if (heard.verdict !== 'ok') {
      warnings.push("The sound in this video may not play: this browser couldn't play it back to check.");
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

interface SoundCheck {
  /** 'ok' = plays back with sound; 'missing' = no playable sound track; 'silent' = plays, but silent. */
  verdict: 'ok' | 'missing' | 'silent' | 'source-silent';
  sourcePeak: number;
  peak: number;
  seconds: number;
}

function peakOf(buffer: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/** Decode the finished MP4's sound with this browser's own decoder and compare to the source. */
async function soundCheck(bytes: Uint8Array, source: AudioBuffer): Promise<SoundCheck> {
  const sourcePeak = peakOf(source);
  if (sourcePeak < 1e-3) return { verdict: 'source-silent', sourcePeak, peak: 0, seconds: 0 };
  let decoded: AudioBuffer;
  try {
    // decodeAudioData takes ownership of its buffer, so hand it a copy.
    decoded = await new OfflineAudioContext(2, 1, SAMPLE_RATE).decodeAudioData(bytes.slice().buffer);
  } catch (err) {
    console.warn('[export] sound check: decode failed', err);
    return { verdict: 'missing', sourcePeak, peak: 0, seconds: 0 };
  }
  const peak = peakOf(decoded);
  const seconds = decoded.duration;
  // AAC changes levels a little; a real track lands within a few dB of the source.
  const verdict = seconds < source.duration * 0.5 ? 'missing' : peak < sourcePeak * 0.1 ? 'silent' : 'ok';
  return { verdict, sourcePeak, peak, seconds };
}

function formatLeft(sec: number): string {
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}

function bytesOf(d: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
}

/** Reads one MPEG-4 descriptor header (tag + 1–4 byte size) at `at`. */
function descriptorAt(b: Uint8Array, at: number): { tag: number; body: number; end: number } | null {
  if (at >= b.length) return null;
  let size = 0;
  let i = at + 1;
  for (let n = 0; n < 4; n++, i++) {
    if (i >= b.length) return null;
    size = (size << 7) | (b[i] & 0x7f);
    if (!(b[i] & 0x80)) break;
  }
  const body = i + 1;
  return body + size <= b.length ? { tag: b[at], body, end: body + size } : null;
}

/**
 * The AAC setup block (AudioSpecificConfig) the MP4 needs, from an encoder's
 * `description`. WebCodecs says that's the raw config, 2 bytes for AAC-LC (Chrome).
 * Safari 26 instead returns a whole MPEG-4 ES descriptor with the config inside
 * (WebKit bug 302253); written as-is, the MP4's sound track can't be decoded and
 * the video plays silent. Returns null when there's nothing usable.
 */
export function aacSetup(raw: Uint8Array): Uint8Array | null {
  if (raw.length === 0) return null;
  // A real config starts with the object type (5 bits, never 0); descriptor tags 3/4/5 would read as 0.
  if (raw[0] >> 3 !== 0) return raw.slice();
  let d = descriptorAt(raw, 0);
  if (d?.tag === 0x03) {
    // ES_Descriptor: ES_ID (2) + flags (1), plus optional fields the flags announce.
    const flags = raw[d.body + 2];
    let at = d.body + 3;
    if (flags & 0x80) at += 2;
    if (flags & 0x40) at += 1 + raw[at];
    if (flags & 0x20) at += 2;
    d = descriptorAt(raw, at);
  }
  if (d?.tag === 0x04) d = descriptorAt(raw, d.body + 13); // DecoderConfigDescriptor's fixed part
  if (d?.tag !== 0x05 || d.end - d.body < 2) return null;
  const asc = raw.slice(d.body, d.end);
  return asc[0] >> 3 !== 0 ? asc : null;
}

/** Test hook: wrap a raw config the way Safari 26 returns it (bytes from WebKit bug 302253). */
function wrapLikeWebKit(asc: Uint8Array): Uint8Array {
  return new Uint8Array([
    3, 128, 128, 128, 34, 0, 0, 0,
    4, 128, 128, 128, 20, 64, 20, 0, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    5, 128, 128, 128, asc.length, ...asc,
    6, 128, 128, 128, 1, 2,
  ]);
}

async function encodeAudio(
  buffer: AudioBuffer,
  codec: string,
  muxer: Muxer<ArrayBufferTarget>,
  fail: (e: DOMException) => void,
): Promise<void> {
  // Test hooks: 'nodesc' = an encoder that returns an empty setup block, 'webkit' = one
  // that returns it wrapped the way Safari 26 does (see aacSetup).
  const breakIt = forced();
  let logged = false;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const desc = meta?.decoderConfig?.description;
      if (!logged) {
        logged = true;
        console.info('[export] audio encoder setup', {
          codec: meta?.decoderConfig?.codec,
          sampleRate: meta?.decoderConfig?.sampleRate,
          channels: meta?.decoderConfig?.numberOfChannels,
          descriptionBytes: desc ? desc.byteLength : null,
          firstChunkBytes: chunk.byteLength,
        });
      }
      if (meta?.decoderConfig && codec === 'mp4a.40.2') {
        let raw = desc ? bytesOf(desc) : null;
        if (raw && breakIt === 'nodesc') raw = new Uint8Array(0);
        if (raw && breakIt === 'webkit') raw = wrapLikeWebKit(raw);
        // 'webkit-raw' skips the unwrap (the old behaviour) to test the sound check below.
        const asc = raw && breakIt === 'webkit-raw' ? wrapLikeWebKit(raw) : raw ? aacSetup(raw) : null;
        const { description: _drop, ...rest } = meta.decoderConfig;
        // No usable setup block: leave the muxer's own (correct for AAC-LC 48k stereo).
        meta = { ...meta, decoderConfig: asc ? { ...rest, description: asc } : rest };
      }
      muxer.addAudioChunk(chunk, meta);
    },
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
