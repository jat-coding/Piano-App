// Generates a simple two-hand demo MIDI (C-major) so the app has test input.
import pkg from '@tonejs/midi';
const { Midi } = pkg;
import { writeFileSync, mkdirSync } from 'node:fs';

const midi = new Midi();
midi.header.setTempo(100);

const right = midi.addTrack();
right.name = 'Right Hand';
const left = midi.addTrack();
left.name = 'Left Hand';

const beat = 0.5; // seconds at 120-ish feel

// Right hand: a rising/falling C-major melody.
const melody = [72, 74, 76, 77, 79, 77, 76, 74, 72, 76, 79, 84, 79, 76, 72];
melody.forEach((midiNote, i) => {
  right.addNote({ midi: midiNote, time: i * beat, duration: beat * 0.9, velocity: 0.8 });
});

// Left hand: block-chord accompaniment underneath.
const chords = [
  [48, 52, 55], // C
  [48, 52, 55],
  [45, 48, 52], // Am
  [45, 48, 52],
  [43, 47, 50], // G
  [43, 47, 50],
  [48, 52, 55], // C
  [48, 52, 55],
];
chords.forEach((chord, i) => {
  for (const n of chord) {
    left.addNote({ midi: n, time: i * beat * 2, duration: beat * 1.8, velocity: 0.6 });
  }
});

mkdirSync('public', { recursive: true });
writeFileSync('public/demo.mid', Buffer.from(midi.toArray()));
console.log('Wrote public/demo.mid');
