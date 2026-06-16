export type Hand = 'left' | 'right' | 'unknown';

/** The single normalized internal format. Renderer only ever sees these. */
export interface NoteEvent {
  midi: number; // 21–108 (88-key range)
  startTime: number; // seconds
  duration: number; // seconds
  velocity: number; // 0–1
  hand: Hand;
}

export interface Song {
  name: string;
  notes: NoteEvent[]; // sorted by startTime
  duration: number; // seconds, end of last note
}

export const MIN_MIDI = 21; // A0
export const MAX_MIDI = 108; // C8
