import type { RawNote } from './transcribe.worker';

/**
 * Desktop (Transkun) notes: drop notes too quiet to be a key press.
 *
 * Transkun has no confidence score; its velocity is the closest thing. Pure room noise
 * (pink noise at -60/-45/-35 dBFS, hum + knocks, his reel's silent tail) already gives 0
 * notes, so the phantoms come during playing: a key "held" for seconds at velocity 3-8/127
 * under a pedalled chord (his reel, B2 at 41.3 s, 5 s long). The quietest real note the
 * engine matched to the answer key (MAESTRO, orchestra mixes, repeats) is velocity 21, the
 * quietest on his reel and clips 19, so 12 keeps a margin under real pianissimo.
 */
export const MIN_DESKTOP_VELOCITY = 12 / 127;

export function dropInaudible(notes: RawNote[]): RawNote[] {
  return notes.filter((n) => n.amplitude >= MIN_DESKTOP_VELOCITY);
}
