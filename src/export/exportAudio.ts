import * as Tone from 'tone';
import type { Song } from '../types';
import type { SongMedia } from '../lib/library';
import { SALAMANDER, SAMPLE_URLS } from '../audio/playback';
import { sustainedEnds } from '../audio/sustain';

const SAMPLE_LEAD = 0.05; // seconds

async function decodeAt(bytes: ArrayBuffer, sampleRate: number): Promise<AudioBuffer> {
  // An offline context decodes without needing a user gesture, resampled to its rate.
  const ctx = new OfflineAudioContext(2, 1, sampleRate);
  return ctx.decodeAudioData(bytes);
}

/**
 * The original recording, cut to the part the user transcribed, as stereo at
 * `sampleRate`. Note times are relative to trimStart, so this lines up with them.
 */
export async function sliceOriginalAudio(
  media: SongMedia,
  duration: number,
  sampleRate: number,
  stage: (label: string) => void,
): Promise<AudioBuffer> {
  stage('Reading the original recording…');
  let decoded: AudioBuffer;
  try {
    decoded = await decodeAt(await media.blob.arrayBuffer(), sampleRate);
  } catch {
    // Same fallback as import: containers the browser can't open (iPhone .mov/HEVC).
    stage('Extracting the sound (first-time tools download)…');
    const { extractAudioWithFfmpeg } = await import('../lib/ffmpeg');
    const file =
      media.blob instanceof File ? media.blob : new File([media.blob], media.fileName);
    const wav = await extractAudioWithFfmpeg(file, undefined, { sampleRate, channels: 2 });
    decoded = await decodeAt(wav.slice().buffer as ArrayBuffer, sampleRate);
  }

  const length = Math.max(1, Math.round(duration * sampleRate));
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = decoded;
  src.connect(ctx.destination);
  src.start(0, Math.max(0, media.trimStart), duration);
  return ctx.startRendering();
}

/**
 * Cascade's Salamander piano playing the song's notes, rendered faster than
 * real time with Tone.Offline. Used for MIDI songs and for older songs whose
 * original recording wasn't kept.
 */
export async function renderPianoAudio(
  song: Song,
  duration: number,
  sampleRate: number,
): Promise<AudioBuffer> {
  const rendered = await Tone.Offline(
    async () => {
      const sampler = new Tone.Sampler({ urls: SAMPLE_URLS, baseUrl: SALAMANDER, release: 1 }).toDestination();
      await Tone.loaded();
      const ends = sustainedEnds(song.notes, song.pedals);
      song.notes.forEach((n, i) => {
        const name = Tone.Frequency(n.midi, 'midi').toNote();
        // Trigger a touch early: the Salamander MP3s start with ~50ms of near-silence,
        // which made the sound trail the picture by about 2 frames (measured).
        const at = Math.max(0, n.startTime - SAMPLE_LEAD);
        const dur = ends ? ends[i] - n.startTime : n.duration; // the sustain pedal holds it longer
        sampler.triggerAttackRelease(name, Math.max(0.05, dur), at, n.velocity);
      });
    },
    duration,
    2,
    sampleRate,
  );
  const buf = rendered.get();
  if (!buf) throw new Error('The piano sound could not be rendered.');
  return buf;
}

/** 16-bit PCM WAV, for handing the sound to ffmpeg.wasm. */
export function audioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const ch = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const out = new DataView(new ArrayBuffer(44 + frames * ch * 2));
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  out.setUint32(4, 36 + frames * ch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, ch, true);
  out.setUint32(24, buffer.sampleRate, true);
  out.setUint32(28, buffer.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true);
  str(36, 'data');
  out.setUint32(40, frames * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(out.buffer);
}
