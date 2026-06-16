// Bundles the real cleanup.ts with esbuild and exercises rawToSong.
import { build } from 'esbuild';
import { writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const entry = 'scripts/_cleanup-entry.ts';
writeFileSync(
  entry,
  `import { rawToSong } from '../src/lib/cleanup';
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
const { run } = await import(pathToFileURL(process.cwd() + '/' + out).href);
const { auto, fixed, quant } = run();

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
process.exit(fixedOk && quantOk ? 0 : 1);
