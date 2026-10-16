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
  /** Transcribed songs: which engine wrote the notes (absent on MIDI and older songs). */
  engine?: 'transkun' | 'basic-pitch';
  /** Desktop-transcribed songs: pedal spans Transkun detected (absent on MIDI, on-device, older songs). */
  pedals?: PedalSpan[];
}

/** A pedal held down from start to end (seconds). cc 64 = sustain, 66 = sostenuto, 67 = soft. */
export interface PedalSpan {
  cc: number;
  start: number;
  end: number;
}

export const MIN_MIDI = 21; // A0
export const MAX_MIDI = 108; // C8
