// Bundles the real cleanup.ts with esbuild and exercises rawToSong.
import { build } from 'esbuild';
import { writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const entry = 'scripts/_cleanup-entry.ts';
writeFileSync(
  entry,
  `import { rawToSong } from '../src/lib/cleanup';
import { mergeGhostReonsets } from '../src/lib/reonsets';
const n = (midi: number, startTime: number, duration: number, velocity: number) => ({ midi, startTime, duration, velocity, hand: 'right' as const });
export function reonsets() {
  const cases = {
    // One E ringing under the pedal, cut into fading pieces (Für Elise, 3.0-3.6 s): one note.
    ghostChain: [n(76, 3.008, 0.104, 0.74), n(76, 3.113, 0.221, 0.71), n(76, 3.333, 0.302, 0.47), n(76, 3.635, 0.128, 0.4)],
    // ...with another key struck together with a piece: that piece is a ghost even at 0.96x.
    together: [n(57, 1, 0.5, 0.7), n(57, 1.5, 0.3, 0.67), n(69, 1.5, 0.3, 0.6)],
    // Real repeats under the pedal (E-D# trill with the D# missed): loudness keeps coming back up.
    trill: [0.61, 0.72, 0.55, 0.7, 0.66, 0.78, 0.59, 0.6].map((v, i) => n(76, 28 + i * 0.17, 0.17, v)),
    // Real repeated pair under the pedal, second a little softer (0.93x): kept.
    pair: [n(62, 6.25, 0.418, 0.81), n(62, 6.668, 0.987, 0.75)],
    // Staccato repeats (a gap between pieces): never merged, however soft.
    staccato: [0.8, 0.5, 0.3, 0.2].map((v, i) => n(65, i * 0.25, 0.1, v)),
    // Louder re-strike: kept.
    louder: [n(60, 0, 0.3, 0.5), n(60, 0.3, 0.3, 0.8)],
  };
  const out: Record<string, { count: number; merged: number; again: number; dur: number }> = {};
  for (const [k, v] of Object.entries(cases)) {
    const r = mergeGhostReonsets(v);
    out[k] = { count: r.notes.length, merged: r.merged, again: mergeGhostReonsets(r.notes).merged, dur: +r.notes[0].duration.toFixed(3) };
  }
  // rawToSong applies it: the ghost chain comes out as one E lasting to 3.763 s.
  const song = rawToSong('g', cases.ghostChain.map((x) => ({ startTimeSeconds: x.startTime, durationSeconds: x.duration, pitchMidi: x.midi, amplitude: x.velocity })), { splitMidi: 60, quantize: 'off', bpm: 120 });
  return { out, songCount: song.notes.length, songDur: +song.notes[0].duration.toFixed(3) };
}
export function run() {
  const raw = [
    { startTimeSeconds: 0.02, durationSeconds: 0.5, pitchMidi: 72, amplitude: 0.8 },
    { startTimeSeconds: 0.26, durationSeconds: 0.5, pitchMidi: 48, amplitude: 0.6 },
    { startTimeSeconds: 0.51, durationSeconds: 0.5, pitchMidi: 76, amplitude: 0.9 },
    { startTimeSeconds: 1.00, durationSeconds: 0.5, pitchMidi: 40, amplitude: 0.5 },
  ];
  const auto = rawToSong('t', raw, { splitMidi: null, quantize: 'off', bpm: 120 });
  const fixed = rawToSong('t', raw, { splitMidi: 60, quantize: 'off', bpm: 120 });
  const quant = rawToSong('t', raw, { splitMidi: 60, quantize: '1/8', bpm: 120 });
  return { auto, fixed, quant };
}`,
);

const out = 'scripts/_cleanup-bundle.mjs';
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' });
const { run, reonsets } = await import(pathToFileURL(process.cwd() + '/' + out).href);
const { auto, fixed, quant } = run();
const ro = reonsets();
const want = { ghostChain: 1, together: 2, trill: 8, pair: 2, staccato: 4, louder: 2 };
let roOk = ro.songCount === 1 && Math.abs(ro.songDur - 0.755) < 0.002;
for (const [k, c] of Object.entries(want)) {
  const r = ro.out[k];
  const ok = r.count === c && r.again === 0;
  roOk &&= ok;
  console.log(`${ok ? 'PASS' : 'FAIL'}: re-onsets ${k}: ${r.count} note(s) (want ${c}), ${r.merged} merged, second pass merges ${r.again}`);
}
console.log(`${ro.songCount === 1 ? 'PASS' : 'FAIL'}: rawToSong merges the ghost chain: ${ro.songCount} note lasting ${ro.songDur} s`);

console.log('auto-split hands:', auto.notes.map((n) => `${n.midi}:${n.hand}`).join(' '));
console.log('fixed@60 hands: ', fixed.notes.map((n) => `${n.midi}:${n.hand}`).join(' '));
console.log('quantized 1/8 starts:', quant.notes.map((n) => n.startTime.toFixed(3)).join(' '));

const fixedOk =
  fixed.notes.every((n) => (n.midi >= 60 ? n.hand === 'right' : n.hand === 'left'));
// 1/8 at 120bpm → 0.25s grid; 0.02→0, 0.26→0.25, 0.51→0.50, 1.00→1.00
const grid = quant.notes.map((n) => Math.round(n.startTime / 0.25) * 0.25);
const quantOk = quant.notes.every((n, i) => Math.abs(n.startTime - grid[i]) < 1e-9);

console.log(fixedOk ? 'PASS: fixed split assigns hands by pitch' : 'FAIL: split');
console.log(quantOk ? 'PASS: quantize snaps to 1/8 grid' : 'FAIL: quantize');

rmSync(entry);
rmSync(out);
process.exit(fixedOk && quantOk && roOk ? 0 : 1);
