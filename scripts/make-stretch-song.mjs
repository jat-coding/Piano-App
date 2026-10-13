// Builds scripts/fixtures/stretch-song.json: wide thumb-to-little-finger stretches (octaves; 9ths and
// 10ths, which the fingering leaves hollow) in both hands, opening and closing, held, broken and
// arpeggiated: the hands phase 10 test for the thumb web and the hand outline at full span.
// usage: node scripts/make-stretch-song.mjs > scripts/fixtures/stretch-song.json
const notes = [];
const n = (midi, t, hand, d = 0.5) => notes.push({ midi, startTime: +t.toFixed(3), duration: d, velocity: 0.8, hand });
let t = 0.5;
// RH: C4 thumb alone, then octave C4+C5, 9th C4+D5, 10th C4+E5, back to C4+G4, repeat as broken.
const rh = [[60], [60, 64], [60, 67], [60, 72], [60, 74], [60, 76], [60, 72], [60, 67], [60, 64], [60]];
const lh = [[48], [44, 48], [41, 48], [36, 48], [34, 48], [33, 48], [36, 48], [41, 48], [44, 48], [48]];
for (let i = 0; i < rh.length; i++) {
  for (const m of rh[i]) n(m, t + i * 0.6, 'right', 0.5);
  for (const m of lh[i]) n(m, t + i * 0.6, 'left', 0.5);
}
t += rh.length * 0.6 + 0.6;
// Broken octaves / 10ths, alternating thumb and pinky (stretch held open, moving).
for (let i = 0; i < 8; i++) {
  n(i % 2 ? 76 : 60, t + i * 0.25, 'right', 0.22);
  n(i % 2 ? 33 : 48, t + i * 0.25, 'left', 0.22);
}
t += 8 * 0.25 + 0.5;
// Wide arpeggio up and closing back: C4 E4 G4 C5 E5 G5? keep within a 10th per hand position.
[60, 64, 67, 72, 76, 72, 67, 64, 60].forEach((m, i) => n(m, t + i * 0.2, 'right', 0.18));
[36, 40, 43, 48, 43, 40, 36].forEach((m, i) => n(m, t + i * 0.25, 'left', 0.22));
t += 2.2;
// Sudden open/close: thumb-only to octave+3rd and straight back.
for (let i = 0; i < 4; i++) {
  for (const m of i % 2 ? [60, 76] : [60]) n(m, t + i * 0.35, 'right', 0.3);
  for (const m of i % 2 ? [33, 48] : [48]) n(m, t + i * 0.35, 'left', 0.3);
}
notes.sort((a, b) => a.startTime - b.startTime || a.midi - b.midi);
const song = { id: 'stretch', name: 'Stretch test', kind: 'midi', notes, duration: Math.max(...notes.map((x) => x.startTime + x.duration)) + 0.5 };
process.stdout.write(JSON.stringify(song));
