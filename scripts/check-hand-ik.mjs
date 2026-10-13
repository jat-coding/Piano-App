// Checks the kinematic hand skeleton (src/hands/skeleton.ts) on hand-written cases and,
// optionally, real songs. Bundles the real code with esbuild.
// Run: node scripts/check-hand-ik.mjs [song.json ...]   (exit 1 on any failure)
//
// Per sampled frame (30 fps), per hand:
//  - every bone keeps its length: each drawn segment equals bone × cos(its flexion) within 0.5%,
//    and the thumb's metacarpal (which lies flat) equals its length within 0.5%
//  - no splay past its limit, no curl outside [0, CURL_MAX], no palm tilt past its limit
//  - every finger that is down on a key has its fingertip on that key
//  - the palm moves continuously: no jump bigger than JUMP px between frames, except
//    during a deliberate fast glide
// Plus: in the C-major scale the right thumb passes under the hand at F.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const out = 'scripts/_hand-ik-bundle.mjs';
await build({
  stdin: {
    contents: `export { HandAnimator } from './src/hands/handPose';
export * from './src/hands/skeleton';
export { tipFrame } from './src/hands/drawHands';
export { keyU, isBlack } from './src/hands/fingering';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
});
const S = await import(pathToFileURL(process.cwd() + '/' + out).href);
rmSync(out);
const { HandAnimator, solveSkeleton, tipFrame, FINGERS, FLEX, THUMB_FLEX, CURL_MAX, keyU } = S;

const RAD = Math.PI / 180;
const UNIT = 36; // px per white key, like a typical export
const JUMP = 0.6 * UNIT; // largest palm move between two frames at 30 fps outside a fast glide
const TIP_TOL = 0.5 * UNIT; // fingertip within half a white key of its key's centre line
let failed = 0;

function geometry(notes) {
  const lo = Math.min(...notes.map((n) => n.midi));
  const u0 = keyU(lo) - 0.5;
  return { uToX: (u) => (u - u0) * UNIT, whiteW: UNIT, minUnit: UNIT, strikeY: 1000, kbH: 200, blackH: 124 };
}

/** Run all per-frame checks over one song; returns stats. */
// Real (transcribed) songs: anatomy limits are hard; a handful of frames where a
// finger can't quite reach a key the fingering gave it (held through a hand shift,
// usually a transcription artefact) or where the palm moves fast without a glide
// are tolerated up to these rates, and always reported.
function checkSong(name, notes, { quiet = false, offRate = 0, jumpRate = 0 } = {}) {
  const anim = new HandAnimator(notes);
  const tf = tipFrame(geometry(notes));
  const end = Math.max(...notes.map((n) => n.startTime + n.duration)) + 0.5;
  const st = { frames: 0, bone: 0, boneMax: 0, splay: 0, curl: 0, tilt: 0, pressed: 0, offKey: 0, missMax: 0, jumps: 0, jumpMax: 0, thumbUnder: 0 };
  const prev = { left: null, right: null };
  const bad = [];
  for (let i = 0; i * (1 / 30) < end; i++) {
    const t = i / 30;
    for (const hand of ['left', 'right']) {
      const pose = anim.pose(hand, t);
      if (!pose) continue;
      const sk = solveSkeleton(pose, tf);
      st.frames++;
      if (Math.abs(sk.palm.rot) > 0.35 + 1e-9) st.tilt++;
      for (let f = 1; f <= 5; f++) {
        const fs = sk.fingers[f];
        const spec = FINGERS[f - 1];
        const js = fs.joints;
        if (fs.curl < -1e-9 || fs.curl > CURL_MAX + 1e-9) st.curl++;
        // Bone lengths. Seen from above each bone shows as L·cos(flexion so far).
        const seg = (a, b) => Math.hypot(b.x - a.x, b.y - a.y) / sk.k;
        let expect;
        if (f === 1) {
          const a1 = THUMB_FLEX[0] * fs.curl * RAD;
          const a2 = a1 + THUMB_FLEX[1] * fs.curl * RAD;
          expect = [spec.bones[0], spec.bones[1] * Math.cos(a1), spec.bones[2] * Math.cos(a2)];
        } else {
          let phi = 0;
          expect = spec.bones.map((L, j) => ((phi = Math.min(Math.PI / 2, phi + FLEX[j] * fs.curl * RAD)), L * Math.cos(phi)));
        }
        for (let j = 0; j < 3; j++) {
          const got = seg(js[j], js[j + 1]);
          const err = Math.abs(got - expect[j]) / spec.bones[j];
          st.boneMax = Math.max(st.boneMax, err);
          if (err > 0.005 || got > spec.bones[j] * 1.005) {
            st.bone++;
            if (bad.length < 5) bad.push(`t=${t.toFixed(2)} ${hand} f${f} bone${j} ${got.toFixed(2)} vs ${expect[j].toFixed(2)}`);
          }
        }
        // Splay limits (thumb: swing of the whole thumb).
        const lim = spec.splay;
        if (fs.splay < lim[0] - 1e-6 || fs.splay > lim[1] + 1e-6) st.splay++;
        // A finger that is down on a key has its tip on that key.
        if (fs.press > 0.5 && fs.engage >= 0.999) {
          st.pressed++;
          const tip = js[3];
          const miss = Math.abs(tip.x - fs.target.x);
          st.missMax = Math.max(st.missMax, Math.hypot(tip.x - fs.target.x, tip.y - fs.target.y));
          if (miss > TIP_TOL || fs.miss > TIP_TOL) {
            st.offKey++;
            if (bad.length < 5) bad.push(`t=${t.toFixed(2)} ${hand} f${f} tip ${fs.miss.toFixed(1)}px from its key`);
          }
        }
      }
      // Thumb under: its tip past the index knuckle, toward the little finger.
      const [ta] = sk.toLocal(sk.fingers[1].joints[3]);
      if (ta > FINGERS[1].base[0] + 4) st.thumbUnder++;
      // Palm continuity. A deliberate fast move is one where the fingertip targets
      // themselves move fast (a leap): then the palm may follow as fast as they do.
      const p = prev[hand];
      const tips = [1, 2, 3, 4, 5].map((f) => sk.fingers[f].target);
      if (p) {
        const d = Math.hypot(sk.palm.x - p.x, sk.palm.y - p.y);
        let inMove = 0;
        for (let f = 1; f <= 5; f++) if (sk.fingers[f].engage > 0.5) inMove = Math.max(inMove, Math.hypot(tips[f - 1].x - p.tips[f - 1].x, tips[f - 1].y - p.tips[f - 1].y));
        const fast = pose.speed > 10 || p.speed > 10;
        if (!fast) {
          st.jumpMax = Math.max(st.jumpMax, d);
          if (d > Math.max(JUMP, 1.5 * inMove + 4)) {
            st.jumps++;
            if (bad.length < 5) bad.push(`t=${t.toFixed(2)} ${hand} palm jumped ${d.toFixed(1)}px (targets moved ${inMove.toFixed(1)}px)`);
          }
        }
      }
      prev[hand] = { x: sk.palm.x, y: sk.palm.y, speed: pose.speed, tips };
    }
  }
  const ok =
    !st.bone && !st.splay && !st.curl && !st.tilt && st.offKey <= offRate * st.pressed && st.jumps <= jumpRate * st.frames;
  if (!ok) failed++;
  if (!quiet || !ok)
    console.log(
      `${ok ? 'PASS' : 'FAIL'}: ${name}: ${st.frames} hand-frames, bone err max ${(st.boneMax * 100).toFixed(3)}%, ` +
        `${st.pressed} pressing tips (worst ${st.missMax.toFixed(1)}px, ${st.offKey} off), palm step max ${st.jumpMax.toFixed(1)}px ` +
        `(${st.jumps} jumps), splay ${st.splay}, curl ${st.curl}, tilt ${st.tilt}` + (bad.length ? `\n    ${bad.join('\n    ')}` : ''),
    );
  return st;
}

const note = (midi, startTime, hand = 'right', duration = 0.25) => ({ midi, startTime, duration, velocity: 0.8, hand });
const seq = (midis, hand, step = 0.3, dur = 0.28) => midis.map((m, i) => note(m, 0.5 + i * step, hand, dur));

// 1. C-major scale RH up and down: thumb must pass under.
{
  const st = checkSong('RH C major scale up+down (legato)', seq([60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60], 'right'));
  const ok = st.thumbUnder > 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: thumb passes under in the C major scale (${st.thumbUnder} frames with the thumb tip past the index knuckle)`);
}
// 2. Two-octave scale, both hands.
checkSong('2-octave C major, both hands', [
  ...seq([60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84], 'right', 0.2, 0.19),
  ...seq([48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72], 'left', 0.2, 0.19),
]);
// 3. D major: black keys for the long fingers.
checkSong('RH D major', seq([62, 64, 66, 67, 69, 71, 73, 74], 'right'));
// 4. Chords and an octave.
checkSong('RH triads + octave', [
  ...[[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67, 72], [60, 72]].flatMap((c, i) => c.map((m) => note(m, 0.5 + i * 0.8, 'right', 0.6))),
]);
// 5. Big leaps: two octaves and back, fast.
checkSong('RH leaps (2 octaves, 0.4 s apart)', seq([60, 64, 67, 84, 88, 91, 60, 64, 67], 'right', 0.4, 0.3));
// 6. LH Alberti bass and a LH thumb on a black key.
checkSong('LH Alberti + black-key thumb', [
  ...seq([48, 55, 52, 55, 48, 55, 52, 55], 'left', 0.2, 0.18),
  ...[[42, 49, 54], [41, 47, 53]].flatMap((c, i) => c.map((m) => note(m, 2.5 + i * 0.8, 'left', 0.6))),
]);

// Real songs.
for (const file of process.argv.slice(2)) {
  const arr = JSON.parse(readFileSync(file, 'utf8'));
  const rec = Array.isArray(arr) ? arr[arr.length - 1] : arr;
  const song = rec.song ?? rec;
  checkSong(file.split('/').pop(), song.notes, { offRate: 0.01, jumpRate: 0.005 });
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall hand IK checks passed');
process.exit(failed ? 1 : 0);
