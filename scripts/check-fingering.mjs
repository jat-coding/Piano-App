// Bundles the real src/hands code (fingering + poses) and the keyboard zoom with esbuild
// and checks them on hand-written cases.
// Run: node scripts/check-fingering.mjs [song.json ...]   (exit 1 on any failure)
// Optional song files (a Song, or an array of saved records) also get the pose checks.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const out = 'scripts/_fingering-bundle.mjs';
await build({
  stdin: {
    contents: `export * from './src/hands/fingering';
export { HandAnimator } from './src/hands/handPose';
export { robustPitchRange, keyboardRange } from './src/render/keyboard';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
});
const { assignFingering, HandAnimator, keyU, MAX_HAND_SPAN, robustPitchRange, keyboardRange } = await import(
  pathToFileURL(process.cwd() + '/' + out).href
);
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
      if (ps.length > 1 && ps[ps.length - 1] - ps[0] > MAX_HAND_SPAN) bad++;
      // Notes still held under fingers count too: one hand never holds more than its span.
      const all = [...ps, ...e.held.map((h) => n[h.note].midi)];
      if (Math.max(...all) - Math.min(...all) > MAX_HAND_SPAN) bad++;
      if (new Set([...fs, ...e.held.map((h) => h.finger)]).size !== fs.length + e.held.length) bad++;
    }
  }
  check(`random passage: no duplicate fingers, pitch order, span <= ${MAX_HAND_SPAN}`, bad, 0);
  const t0 = performance.now();
  const big = [];
  for (let k = 0; k < 20; k++) for (const x of n) big.push({ ...x, startTime: x.startTime + k * 40 });
  assignFingering(big);
  console.log(`  speed: ${big.length} notes fingered in ${(performance.now() - t0).toFixed(0)} ms`);
}

// 7. Wide stretches (a 9th or more) are never fingered by one hand.
{
  const n = [note(60, 0), note(74, 0)]; // C4 + D5, a major 9th
  const r = assignFingering(n);
  check('9th, LH free: C4 handed to LH', n.map((_, i) => `${r.perNote[i].hand[0]}${r.perNote[i].finger}`), ['l1', 'r1']);
}
{
  const n = [note(60, 0), note(74, 0), note(41, 0, 'left'), note(48, 0, 'left')];
  const r = assignFingering(n);
  check('9th, LH busy: C4 unreachable, D5 fingered', [0, 1].map((i) => `${r.perNote[i].hand[0]}${r.perNote[i].finger}`), ['rnull', 'r1']);
}
{
  const n = [note(60, 0), note(64, 0), note(72, 0)]; // C-E-C: an octave is still one hand
  check('octave chord stays in one hand', fingers(assignFingering(n), n), [1, 2, 5]);
}
// 8. Held notes: a held note lets go early only when the hand must stretch past its span.
{
  // Hold C4 for 2 s, then play E5 at 0.5 s (16 semitones up): C4's finger must release by 0.5.
  const n = [note(60, 0, 'right', 2), note(76, 0.5, 'right', 0.3)];
  const r = assignFingering(n);
  check('held C4 + E5 later: C4 released at E5', r.perNote[0].releaseBy, 0.5);
  const a = new HandAnimator(n);
  check('  ...C4 drawn as pedal-held at 1.0 s', a.sustained(0, 1.0), true);
  check('  ...but not while its finger is on it (0.3 s)', a.sustained(0, 0.3), false);
  const p = a.pose('right', 1.0);
  check('  ...no fingertip left stretched on C4', p.fingers.slice(1).every((f) => Math.abs(f.u - keyU(60)) > 1), true);
}
{
  // Hold C4 for 2 s, then E4 and G4 inside the octave: C4 stays under the thumb the whole time.
  const n = [note(60, 0, 'right', 2), note(64, 0.5), note(67, 1.0)];
  const r = assignFingering(n);
  check('held C4 + E4, G4: C4 kept until its end', r.perNote[0].releaseBy, 2);
  const a = new HandAnimator(n);
  const p = a.pose('right', 1.2);
  check('  ...thumb still on C4 at 1.2 s', Math.abs(p.fingers[1].u - keyU(60)) < 0.05 && p.fingers[1].press > 0.9, true);
  check('  ...never drawn as pedal-held', [0.3, 1, 1.5, 1.9].some((t) => a.sustained(0, t)), false);
}
{
  // The finger holding a note is needed again: it lets go and the rest is pedal.
  const n = [note(60, 0, 'right', 1.5), note(62, 0.4), note(64, 0.8), note(65, 1.0), note(67, 1.2), note(69, 1.4)];
  const r = assignFingering(n);
  const f0 = r.perNote[0].finger;
  const reuse = n.findIndex((x, i) => i > 0 && r.perNote[i].finger === f0);
  check('held note whose finger is reused releases by that onset', reuse > 0 && r.perNote[0].releaseBy <= n[reuse].startTime, true);
}
// 9. Unreachable and skipped notes get no finger; unreachable ones are drawn pedal-held.
{
  const n = [note(60, 0, 'right', 1), note(76, 0, 'right', 1), note(41, 0, 'left', 1), note(48, 0, 'left', 1)];
  const a = new HandAnimator(n);
  check('unreachable note drawn pedal-held from its onset', a.fingering.perNote[0].finger === null && a.sustained(0, 0.01), true);
  const s = new HandAnimator(n, { skip: (i) => i === 1 });
  check('skipped note: no finger, not unreachable, not styled', [s.fingering.perNote[1].finger, s.fingering.unreachable, s.sustained(1, 0.5)], [null, 0, false]);
}
// 10. Keyboard zoom ignores stray outliers, but not real notes.
{
  const body = [];
  for (let k = 0; k < 120; k++) body.push(48 + (k % 25)); // C3..C5
  check('zoom: one ghost note far below is ignored', robustPitchRange([...body, 29]).lo, 48);
  check('zoom: a few ghost notes far above are ignored', robustPitchRange([...body, 93, 94, 96]).hi, 72);
  check('zoom: a note close to the rest is kept', robustPitchRange([...body, 45]).lo, 45);
  check('zoom: a real bass line (many notes) is kept', robustPitchRange([...body, ...Array(10).fill(29)]).lo, 29);
  const kr = keyboardRange([...body, 29].map((midi) => ({ midi })));
  check('zoom: keyboardRange snaps to white keys around 48..72', [kr.lo, kr.hi], [45, 74]);
}
// 11. Pose invariants over time: a lit key always has a finger on it, or is drawn
//     pedal-held (or its finger is just lifting in the last 0.1 s); the hand never
//     splays past an octave; neighbouring long fingers stay close.
function poseChecks(name, notes, opts = {}) {
  const a = new HandAnimator(notes, opts);
  const end = Math.max(...notes.map((x) => x.startTime + x.duration));
  let bare = 0;
  let spider = 0;
  let splay = 0;
  let frames = 0;
  for (let i = 0; i <= end * 30; i++) {
    const t = i / 30;
    const poses = { left: a.pose('left', t), right: a.pose('right', t) };
    for (const p of Object.values(poses)) {
      if (!p) continue;
      frames++;
      const dbg = () => process.env.DBG && console.log(`    t=${t.toFixed(3)} ${p.hand} ${JSON.stringify(p.fingers.slice(1).map((f) => [+f.u.toFixed(2), +f.press.toFixed(2)]))}`);
      if (Math.abs(p.fingers[5].u - p.fingers[1].u) > 7.5) spider++, dbg();
      // Two fingers both on keys may sit a major third apart (up to 2.5 keys with black keys);
      // a free finger never splays more than ~2 keys from its neighbour.
      for (let f = 3; f <= 5; f++) {
        const d = Math.abs(p.fingers[f].u - p.fingers[f - 1].u);
        const bothDown = p.fingers[f].press > 0.5 && p.fingers[f - 1].press > 0.5;
        if (d > (bothDown ? 2.55 : 2.05)) splay++, dbg();
      }
    }
    notes.forEach((x, k) => {
      if (!(t >= x.startTime && t < x.startTime + x.duration) || !a.inRange(k)) return;
      if (a.sustained(k, t) || t >= x.startTime + x.duration - 0.1) return;
      const p = poses[a.fingering.perNote[k].hand];
      const u = keyU(x.midi);
      if (!p || !p.fingers.slice(1).some((fp) => Math.abs(fp.u - u) < 0.4 && fp.press > 0.5)) {
        bare++;
        if (process.env.DBG) console.log(`    bare t=${t.toFixed(3)} #${k} midi=${x.midi} u=${u} ${x.startTime.toFixed(3)}+${x.duration.toFixed(3)} f=${a.fingering.perNote[k].finger} rel=${a.fingering.perNote[k].releaseBy.toFixed(3)} sus=${a.sustainFrom(k)} ${JSON.stringify(p?.fingers.slice(1).map((f) => [+f.u.toFixed(2), +f.press.toFixed(2)]))}`);
      }
    });
  }
  check(`${name}: lit keys with no finger and not pedal-held`, bare, 0);
  check(`${name}: frames with the hand wider than an octave`, spider, 0);
  check(`${name}: frames with long fingers splayed too far`, splay, 0);
  return frames;
}
{
  // Long notes overlapping fast ones in both hands, with wide leaps: the transcription case.
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = [];
  for (let k = 0; k < 240; k++) {
    const hand = k % 3 === 0 ? 'left' : 'right';
    const base = hand === 'left' ? 36 : 60;
    const long = rnd() < 0.3;
    n.push(note(base + Math.floor(rnd() * 26), k * 0.12 + rnd() * 0.02, hand, long ? 0.8 + rnd() * 2.5 : 0.1 + rnd() * 0.3));
  }
  n.sort((a, b) => a.startTime - b.startTime);
  poseChecks('random long+short passage', n);
}
for (const file of process.argv.slice(2)) {
  const arr = JSON.parse(readFileSync(file, 'utf8'));
  const rec = Array.isArray(arr) ? arr[arr.length - 1] : arr;
  const song = rec.song ?? rec;
  const { lo, hi } = keyboardRange(song.notes);
  const name = file.split('/').pop();
  poseChecks(name, song.notes, { skip: (i) => song.notes[i].midi < lo || song.notes[i].midi > hi });
}

console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
