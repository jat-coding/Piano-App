// Bundles the real src/hands/fingering.ts with esbuild and checks it on hand-written cases.
// Run: node scripts/check-fingering.mjs   (exit 1 on any failure)
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const out = 'scripts/_fingering-bundle.mjs';
await build({
  entryPoints: ['src/hands/fingering.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
});
const { assignFingering } = await import(pathToFileURL(process.cwd() + '/' + out).href);
rmSync(out);

let failed = 0;
const note = (midi, startTime, hand = 'right', duration = 0.2) => ({
  midi,
  startTime,
  duration,
  velocity: 0.8,
  hand,
});
const seq = (midis, hand, step = 0.25) => midis.map((m, i) => note(m, i * step, hand));
const fingers = (res, notes) => notes.map((_, i) => res.perNote[i].finger);

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} -> ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
}

// 1. C-major scale, right hand, one octave up: 1-2-3-1-2-3-4-5 (thumb under at F).
{
  const n = seq([60, 62, 64, 65, 67, 69, 71, 72], 'right');
  check('RH C major scale up', fingers(assignFingering(n), n), [1, 2, 3, 1, 2, 3, 4, 5]);
}
// 1b. Same scale coming down: 5-4-3-2-1-3-2-1 (3 over the thumb at E).
{
  const n = seq([72, 71, 69, 67, 65, 64, 62, 60], 'right');
  check('RH C major scale down', fingers(assignFingering(n), n), [5, 4, 3, 2, 1, 3, 2, 1]);
}
// 1c. D major (two sharps): thumbs stay off F# and C#, 1-2-3-1-2-3-4-5.
{
  const n = seq([62, 64, 66, 67, 69, 71, 73, 74], 'right');
  const f = fingers(assignFingering(n), n);
  check('RH D major scale up', f, [1, 2, 3, 1, 2, 3, 4, 5]);
}
// 1d. Thumb avoids a black key when there is a choice: E-F#-G-A-B (thumb on E, not F#).
{
  const n = seq([64, 66, 67, 69, 71], 'right');
  const f = fingers(assignFingering(n), n);
  check('RH thumb never on F#', f[1] !== 1, true);
}
// 2. Simple triad C-E-G struck together: 1-3-5.
{
  const n = [note(60, 0), note(64, 0), note(67, 0)];
  check('RH C triad', fingers(assignFingering(n), n), [1, 3, 5]);
}
// 3. Octave C4+C5: 1-5.
{
  const n = [note(60, 0), note(72, 0)];
  check('RH octave', fingers(assignFingering(n), n), [1, 5]);
}
// 4a. Chord too wide for one hand (C4-G4-E5, a 10th+), left hand free:
//     the low C goes to the left hand, the rest stays reachable for the right.
{
  const n = [note(60, 0), note(67, 0), note(76, 0)];
  const r = assignFingering(n);
  check(
    'too-wide chord, LH free: C4 handed to LH',
    n.map((_, i) => `${r.perNote[i].hand[0]}${r.perNote[i].finger}`),
    ['l1', 'r1', 'r5'],
  );
}
// 4b. Same chord while the left hand is busy at that moment: C4 unreachable, no contortion.
{
  const n = [note(60, 0), note(67, 0), note(76, 0), note(41, 0, 'left'), note(48, 0, 'left')];
  const r = assignFingering(n);
  check(
    'too-wide chord, LH busy: C4 unreachable',
    [0, 1, 2].map((i) => `${r.perNote[i].hand[0]}${r.perNote[i].finger}`),
    ['rnull', 'r1', 'r5'],
  );
  check('  ...unreachable count', r.unreachable, 1);
}
// 4c. Six notes in one hand can never all be fingered.
{
  const n = [60, 62, 64, 65, 67, 69].map((m) => note(m, 0));
  const r = assignFingering(n, { moveOverflow: false });
  const used = n.map((_, i) => r.perNote[i].finger).filter((f) => f != null);
  check('6-note cluster: at most 5 fingers, all distinct', used.length <= 5 && new Set(used).size === used.length, true);
}
// 5. Left hand mirrored: scale C3 down to C2 is 1-2-3-1-2-3-4-5; triad 5-3-1; octave 5-1.
{
  const n = seq([48, 47, 45, 43, 41, 40, 38, 36], 'left');
  check('LH C major scale down', fingers(assignFingering(n), n), [1, 2, 3, 1, 2, 3, 4, 5]);
}
{
  const n = seq([36, 38, 40, 41, 43, 45, 47, 48], 'left');
  check('LH C major scale up', fingers(assignFingering(n), n), [5, 4, 3, 2, 1, 3, 2, 1]);
}
{
  const n = [note(48, 0, 'left'), note(52, 0, 'left'), note(55, 0, 'left')];
  check('LH C triad', fingers(assignFingering(n), n), [5, 3, 1]);
}
{
  const n = [note(36, 0, 'left'), note(48, 0, 'left')];
  check('LH octave', fingers(assignFingering(n), n), [5, 1]);
}
// 6. Anatomy invariants on a dense random passage: no finger twice in a chord,
//    fingers in pitch order, every fingered chord within a hand's practical span.
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = [];
  for (let k = 0; k < 400; k++) {
    const t = Math.floor(k / 2) * 0.18;
    const hand = rnd() < 0.5 ? 'left' : 'right';
    const base = hand === 'left' ? 40 : 62;
    n.push(note(base + Math.floor(rnd() * 20), t + (rnd() < 0.3 ? 0 : 0.01), hand));
  }
  n.sort((a, b) => a.startTime - b.startTime);
  const r = assignFingering(n);
  let bad = 0;
  for (const hand of ['left', 'right']) {
    for (const e of r.events[hand]) {
      const fs = e.fingers;
      if (new Set(fs).size !== fs.length) bad++;
      for (let i = 1; i < fs.length; i++) {
        if (hand === 'right' ? fs[i] <= fs[i - 1] : fs[i] >= fs[i - 1]) bad++;
      }
      const ps = e.notes.map((i) => n[i].midi);
      if (ps.length > 1 && ps[ps.length - 1] - ps[0] > 15) bad++;
    }
  }
  check('random passage: no duplicate fingers, pitch order, span <= 15', bad, 0);
  const t0 = performance.now();
  const big = [];
  for (let k = 0; k < 20; k++) for (const x of n) big.push({ ...x, startTime: x.startTime + k * 40 });
  assignFingering(big);
  console.log(`  speed: ${big.length} notes fingered in ${(performance.now() - t0).toFixed(0)} ms`);
}

console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
