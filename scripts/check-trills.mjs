// Bundles the real trills.ts with esbuild and checks the semitone-trill re-read on synthetic
// Basic Pitch output: a pedalled trill comes out alternating; two keys simply ringing together,
// and a single neighbour note passing a held one, are left exactly as Basic Pitch built them.
// MODEL=/path/to/{frames,onsets}.json additionally runs it on real model output and prints the
// notes it changed.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pkg from '@spotify/basic-pitch';
const { outputToNotesPoly, noteFramesToTime } = pkg;

const out = 'scripts/_trills.bundle.mjs';
await build({ entryPoints: ['src/lib/trills.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { resolveSemitoneTrills } = await import(pathToFileURL(out).href + '?t=' + Date.now());
rmSync(out);

const FR = 22050 / 256;
const MIN_LEN = Math.round(80 / (1000 / FR));
const grid = (n) => Array.from({ length: n }, () => new Array(88).fill(0.02));
const col = (m) => m - 21;
const run = (frames, onsets) => {
  const poly = outputToNotesPoly(frames.map((r) => r.slice()), onsets.map((r) => r.slice()), 0.5, 0.3, MIN_LEN, true);
  const res = resolveSemitoneTrills(frames, onsets, poly, 0.5, 0.3, MIN_LEN);
  const seq = (ns) => noteFramesToTime(ns).sort((a, b) => a.startTimeSeconds - b.startTimeSeconds).map((n) => n.pitchMidi);
  return { before: seq(poly), after: seq(res.notes), trills: res.trills };
};
let fail = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}  ${detail}`); if (!ok) fail++; };

// 1. E5/D#5 trill with the pedal down: both keys ring throughout, each strike also fires the
//    neighbour's onset a little, and the struck key's frame energy rises above the other's.
{
  const n = 260, frames = grid(n), onsets = grid(n);
  const E = col(76), D = col(75), P = 20;
  for (let f = 10; f < 10 + 10 * P; f++) { frames[f][E] = 0.5; frames[f][D] = f >= 10 + P ? 0.45 : 0.1; }
  for (let k = 0; k < 10; k++) {
    const key = k % 2 === 0 ? E : D, other = key === E ? D : E, s = 10 + k * P;
    onsets[s][key] = 0.8;
    onsets[s + 1][other] = 0.55; // the bleed that makes Basic Pitch build the wrong key
    for (let f = s + 2; f < s + P; f++) frames[f][key] = 0.75;
  }
  const r = run(frames, onsets);
  const trill = r.after.filter((m) => m === 75 || m === 76);
  const alternates = trill.every((m, i) => i === 0 || m !== trill[i - 1]);
  check('pedalled trill alternates', alternates && trill.length === 10 && r.trills.length === 1,
    `basic-pitch ${r.before.map((m) => (m === 76 ? 'E' : 'D#')).join(' ')} -> ${trill.map((m) => (m === 76 ? 'E' : 'D#')).join(' ')}`);
}
// 2. A semitone cluster held together (no alternation): untouched.
{
  const n = 120, frames = grid(n), onsets = grid(n);
  for (let f = 10; f < 100; f++) { frames[f][col(64)] = 0.7 + 0.03 * Math.sin(f); frames[f][col(65)] = 0.7 - 0.03 * Math.sin(f); }
  onsets[10][col(64)] = 0.9; onsets[10][col(65)] = 0.9;
  const r = run(frames, onsets);
  check('held semitone cluster untouched', JSON.stringify(r.before) === JSON.stringify(r.after) && !r.trills.length, `${r.before} -> ${r.after}`);
}
// 3. A neighbour played once over a held, pedalled note: not a trill, untouched.
{
  const n = 140, frames = grid(n), onsets = grid(n);
  for (let f = 10; f < 130; f++) frames[f][col(72)] = 0.6;
  onsets[10][col(72)] = 0.9;
  for (let f = 50; f < 90; f++) frames[f][col(71)] = 0.8;
  onsets[50][col(71)] = 0.9;
  const r = run(frames, onsets);
  check('single neighbour note untouched', JSON.stringify(r.before) === JSON.stringify(r.after) && !r.trills.length, `${r.before} -> ${r.after}`);
}

if (process.env.MODEL) {
  const { frames, onsets } = JSON.parse(readFileSync(process.env.MODEL, 'utf8'));
  const poly = outputToNotesPoly(frames.map((r) => r.slice()), onsets.map((r) => r.slice()), 0.5, 0.3, MIN_LEN, true);
  const res = resolveSemitoneTrills(frames, onsets, poly, 0.5, 0.3, MIN_LEN);
  const N = 'C C# D D# E F F# G G# A A# B'.split(' ');
  const nm = (m) => N[m % 12] + (Math.floor(m / 12) - 1);
  const t = (f) => noteFramesToTime([{ startFrame: f, durationFrames: 1, pitchMidi: 60, amplitude: 1 }])[0].startTimeSeconds;
  console.log(`${process.env.MODEL}: ${poly.length} -> ${res.notes.length} notes, ${res.trills.length} trill(s)`);
  for (const tr of res.trills) {
    const inside = (ns) => noteFramesToTime(ns).filter((x) => (x.pitchMidi === tr.pitch || x.pitchMidi === tr.pitch + 1) && x.startTimeSeconds >= t(tr.startFrame) - 0.4 && x.startTimeSeconds < t(tr.endFrame)).sort((a, b) => a.startTimeSeconds - b.startTimeSeconds).map((x) => `${x.startTimeSeconds.toFixed(2)} ${nm(x.pitchMidi)}`).join(', ');
    console.log(`  ${nm(tr.pitch)}/${nm(tr.pitch + 1)} ${t(tr.startFrame).toFixed(2)}-${t(tr.endFrame).toFixed(2)}s, ${tr.presses} presses\n    before: ${inside(poly)}\n    after:  ${inside(res.notes)}`);
  }
}
console.log(fail ? `${fail} FAILED` : 'ALL PASS');
process.exit(fail ? 1 : 0);
