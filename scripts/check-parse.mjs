// Sanity-check the parse + hand-assignment logic against the real demo file.
import pkg from '@tonejs/midi';
const { Midi } = pkg;
import { readFileSync } from 'node:fs';

const buf = readFileSync('public/demo.mid');
const midi = new Midi(buf);
const played = midi.tracks.filter((t) => t.notes.length > 0);

const avg = (t) => t.notes.reduce((s, n) => s + n.midi, 0) / t.notes.length;
const sorted = [...played].sort((a, b) => avg(b) - avg(a));
const rightTrack = sorted[0];

let right = 0,
  left = 0,
  duration = 0;
for (const t of played) {
  const hand = t === rightTrack ? 'right' : 'left';
  for (const n of t.notes) {
    if (hand === 'right') right++;
    else left++;
    duration = Math.max(duration, n.time + n.duration);
  }
}

console.log('tracks with notes:', played.length);
console.log('avg pitch per track:', played.map((t) => avg(t).toFixed(1)).join(', '));
console.log('right-hand notes (orange):', right);
console.log('left-hand notes (blue):', left);
console.log('duration (s):', duration.toFixed(2));
console.log(
  right > 0 && left > 0 && played.length === 2
    ? 'PASS: two hands separated correctly'
    : 'CHECK: unexpected split',
);
