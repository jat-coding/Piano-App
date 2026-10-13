import type { Hand, Song } from '../types';
import type { PlayAlongSession, SessionScore } from './session';
import type { MicInput } from './mic';

/**
 * Everything the exporter needs to re-draw a play-along session, frame by frame, on
 * the video's own timeline (seconds from the start of the video).
 */
export interface SessionTrack {
  /** Video seconds → song seconds, waits included. */
  songAt(v: number): number;
  /** Per note: video time it was hit (Infinity = not hit, or not played by the player). */
  hitAt: Float64Array;
  /** Per note: 1 if the player had to play it. */
  required: Uint8Array;
  /** Hits in time order (for the little bursts). */
  hits: { v: number; midi: number; hand: Hand }[];
  /** Wrong keys in time order. */
  wrong: { v: number; midi: number }[];
  /** Video seconds when the score card comes up, and the video's full length. */
  cardFrom: number;
  duration: number;
  score: SessionScore;
  /** What the soundtrack is, for the export dialog. */
  sound: 'mic' | 'piano';
}

export interface SessionExport {
  track: SessionTrack;
  audio: AudioBuffer;
}

const LEAD_IN = 0.6; // s of video before the song starts moving
const CARD_S = 3.5; // s the score card stays on screen at the end
const FADE_S = 0.4; // s the sound fades out before the card
/**
 * The listener confirms a note ~35ms after it sounds (measured), so the song moves on
 * that much after the sound. The video shows the picture that much earlier, so hits
 * light up as you hear them.
 */
export const AV_LAG = 0.035;

export function buildTrack(session: PlayAlongSession, song: Song): SessionTrack {
  const start = session.songStart - LEAD_IN;
  const end = Math.max(session.endAt, session.songStart) + 1.2;
  const cardFrom = end - start;
  const n = song.notes.length;
  const hitAt = new Float64Array(n).fill(Infinity);
  const hits: SessionTrack['hits'] = [];
  for (let i = 0; i < n; i++) {
    const h = session.hitAt[i];
    if (!Number.isFinite(h)) continue;
    const v = h - start - AV_LAG;
    hitAt[i] = v;
    hits.push({ v, midi: song.notes[i].midi, hand: song.notes[i].hand });
  }
  hits.sort((a, b) => a.v - b.v);
  const wrong = session.wrongs.map((w) => ({ v: w.at - start, midi: w.midi })).sort((a, b) => a.v - b.v);
  return {
    songAt: (v) => session.songAt(start + v + AV_LAG),
    hitAt,
    required: session.required.slice(),
    hits,
    wrong,
    cardFrom,
    duration: cardFrom + CARD_S,
    score: session.score,
    sound: session.listener ? 'mic' : 'piano',
  };
}

/**
 * The soundtrack, 48kHz stereo, as long as the video: what the mic heard (made a bit
 * louder if it was quiet), or for a MIDI keyboard session, Cascade's piano playing the
 * keys exactly when they were pressed.
 */
export async function buildSessionAudio(
  session: PlayAlongSession,
  mic: MicInput | null,
  track: SessionTrack,
  sampleRate: number,
): Promise<AudioBuffer> {
  const start = session.songStart - LEAD_IN;
  const length = Math.max(1, Math.round(track.duration * sampleRate));
  if (!mic) {
    const { renderPianoAudio } = await import('../export/exportAudio');
    const notes = session.midiPresses.map((p) => ({
      midi: p.midi,
      startTime: Math.max(0, p.at - start),
      duration: 0.5,
      velocity: p.velocity,
      hand: 'right' as Hand,
    }));
    return renderPianoAudio({ name: 'session', notes, duration: track.duration }, track.duration, sampleRate);
  }
  const pcm = mic.samples(start, start + track.cardFrom);
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  const gain = peak > 0 ? Math.min(4, 0.89 / peak) : 1;
  const src = new AudioBuffer({ length: Math.max(1, pcm.length), numberOfChannels: 1, sampleRate: mic.sampleRate });
  src.copyToChannel(pcm, 0);
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  const node = ctx.createBufferSource();
  node.buffer = src;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, 0);
  const fadeAt = Math.max(0, track.cardFrom - FADE_S);
  g.gain.setValueAtTime(gain, fadeAt);
  g.gain.linearRampToValueAtTime(0, track.cardFrom);
  node.connect(g);
  g.connect(ctx.destination);
  node.start(0);
  return ctx.startRendering();
}
