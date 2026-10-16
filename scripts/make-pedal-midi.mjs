// Writes scripts/fixtures/pedal-cc64.mid: a two-hand MIDI file whose sustain pedal (CC 64)
// lives on its own note-less third track, as many DAWs/exports do. Used by check-sustain.mjs
// (MIDI mode) and the in-app import check. Half-way values (0.3 = 38 up, 0.6 = 76 down)
// exercise the >= 64 threshold; the last 2 s are played with the pedal up.
import pkg from '@tonejs/midi';
const { Midi } = pkg;
import { writeFileSync, mkdirSync } from 'node:fs';

const midi = new Midi();
midi.header.setTempo(120);
const right = midi.addTrack();
right.name = 'Right';
const left = midi.addTrack();
left.name = 'Left';
const pedal = midi.addTrack();
pedal.name = 'Pedal';

const melody = [72, 74, 76, 77, 79, 77, 76, 74, 72, 76, 79, 84, 79, 76, 72, 71];
melody.forEach((m, i) => right.addNote({ midi: m, time: i * 0.5, duration: 0.2, velocity: 0.7 }));
[48, 53, 55, 48].forEach((m, i) => left.addNote({ midi: m, time: i * 2, duration: 0.3, velocity: 0.6 }));

// Spans: 0.05-1.9, 2.05-3.9, 4.05-5.9; nothing from 6 s on.
const cc = (time, value) => pedal.addCC({ number: 64, time, value });
cc(0.05, 1); cc(1.9, 0);
cc(2.05, 0.6); cc(3.0, 1); cc(3.9, 0.3);
cc(4.05, 1); cc(5.9, 0);

mkdirSync('scripts/fixtures', { recursive: true });
writeFileSync('scripts/fixtures/pedal-cc64.mid', Buffer.from(midi.toArray()));
console.log('wrote scripts/fixtures/pedal-cc64.mid');
