// Sustain pedal in playback (2026-10-16).
//
// usage: node scripts/check-sustain.mjs [desktop-reply.json [original.wav [outdir]]]
//   desktop-reply.json: what the desktop helper (/api/transcribe) returned for a clip (notes +
//   pedals). With it, the real PlaybackEngine and the export's piano re-render run in Chromium on
//   that song with and without its pedals, and the difference is measured (and written as WAVs
//   to outdir if given). Needs Playwright (PLAYWRIGHT_FROM, as check-hands-export) and network
//   access to the Salamander samples.
//
//  S1 sustainedEnds on hand-written cases: no sustain data -> null (callers keep n.duration, so
//     those songs sound as before); a key released under the pedal rings to the pedal-up; one
//     released with the pedal up is untouched; a re-strike of the same key ends the earlier
//     ring; soft/sostenuto spans hold nothing; the cap holds.                            HARD
//  S2 real song, PlaybackEngine with a recording sampler: without pedals every note is released
//     at exactly n.duration (unchanged); with pedals none ends before n.duration, those
//     released under the pedal end at the pedal-up, no key has two pedalled rings at once.  HARD
//  S3 real song, Tone.Offline render with vs without pedals: level inside the pedal spans, the
//     share of near-silent 50 ms windows there, and how closely the render's loudness envelope
//     follows the original recording's. Reported, not gated (it is a sound, not a rule).
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

let fail = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};

// ---- S1 -------------------------------------------------------------------------------
const unitOut = 'scripts/_sustain-unit.mjs';
await build({ entryPoints: ['src/audio/sustain.ts'], bundle: true, format: 'esm', platform: 'node', outfile: unitOut, logLevel: 'silent' });
const { sustainedEnds, MAX_PEDAL_RING } = await import(pathToFileURL(path.resolve(unitOut)).href);
rmSync(unitOut);

const N = (midi, startTime, duration) => ({ midi, startTime, duration, velocity: 0.7, hand: 'right' });
const P = (cc, start, end) => ({ cc, start, end });
const near = (a, b) => Math.abs(a - b) < 1e-9;
{
  const notes = [N(60, 0, 0.5), N(64, 1, 0.5), N(67, 3, 0.5)];
  check(sustainedEnds(notes, undefined) === null, 'S1 no pedals -> null');
  check(sustainedEnds(notes, []) === null, 'S1 empty pedals -> null');
  check(sustainedEnds(notes, [P(67, 0, 10), P(66, 0, 10)]) === null, 'S1 only soft/sostenuto -> null');
  const e = sustainedEnds(notes, [P(64, 0.2, 2.5)]);
  check(near(e[0], 2.5), `S1 released under the pedal rings to pedal-up (${e[0]})`);
  check(near(e[1], 2.5), `S1 second note under same pedal rings to pedal-up (${e[1]})`);
  check(near(e[2], 3.5), `S1 note after pedal-up untouched (${e[2]})`);
  const before = sustainedEnds([N(60, 0, 0.5)], [P(64, 0.6, 2)]);
  check(near(before[0], 0.5), 'S1 key released before the pedal goes down is not caught');
  const re = sustainedEnds([N(60, 0, 0.3), N(60, 1, 0.3), N(62, 0, 0.3)], [P(64, 0.1, 4)]);
  check(near(re[0], 1) && near(re[1], 4) && near(re[2], 4), `S1 re-strike ends the earlier ring (${[...re]})`);
  const longer = sustainedEnds([N(60, 0, 3)], [P(64, 0.1, 1)]);
  check(near(longer[0], 3), 'S1 a key held past the pedal-up keeps its own length');
  const cap = sustainedEnds([N(60, 0, 0.5)], [P(64, 0, 100)]);
  check(near(cap[0], 0.5 + MAX_PEDAL_RING), `S1 ring capped at ${MAX_PEDAL_RING}s past release`);
}

const [replyPath, wavPath, outDir] = process.argv.slice(2);
if (!replyPath) {
  console.log(fail ? `\n${fail} FAILED` : '\nall passed (S1 only; pass a desktop reply for S2/S3)');
  process.exit(fail ? 1 : 0);
}

// ---- S2 / S3 in Chromium ----------------------------------------------------------------
const reply = JSON.parse(readFileSync(replyPath, 'utf8'));
const entry = `
import * as Tone from 'tone';
import { PlaybackEngine } from './src/audio/playback';
import { renderPianoAudio } from './src/export/exportAudio';
import { rawToSong, DEFAULT_BUILD } from './src/lib/cleanup';
import { dropInaudible } from './src/lib/noiseGate';
import { sustainedEnds } from './src/audio/sustain';
window.T = { Tone, PlaybackEngine, renderPianoAudio, rawToSong, DEFAULT_BUILD, dropInaudible, sustainedEnds };
`;
const bundle = 'scripts/_sustain-bundle.js';
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'iife', outfile: bundle, logLevel: 'silent' });
const code = readFileSync(bundle, 'utf8');
rmSync(bundle);

let chromium;
for (const dir of [process.env.PLAYWRIGHT_FROM, process.cwd(), '../Piano-App-harness', '/tmp/cascade-video-test'].filter(Boolean)) {
  for (const pkg of ['playwright', 'playwright-core']) {
    try {
      chromium = createRequire(path.resolve(dir, 'x.js'))(pkg).chromium;
      break;
    } catch {}
  }
  if (chromium) break;
}
if (!chromium) {
  console.error('check-sustain: Playwright not found (set PLAYWRIGHT_FROM)');
  process.exit(2);
}
const browser = await chromium.launch({
  ...(process.env.CHROMIUM && existsSync(process.env.CHROMIUM) ? { executablePath: process.env.CHROMIUM } : {}),
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.setContent('<html><body></body></html>');
await page.addScriptTag({ content: code });

const res = await page.evaluate(
  async ({ reply, wantWav }) => {
    const { Tone, PlaybackEngine, renderPianoAudio, rawToSong, DEFAULT_BUILD, dropInaudible, sustainedEnds } = window.T;
    // The same steps the app takes: noise gate in transcribe.ts, rawToSong in pipeline.ts.
    const base = rawToSong('reel', dropInaudible(reply.notes), DEFAULT_BUILD);
    const pedals = (reply.pedals ?? []).map((p) => ({ cc: p.cc, start: p.startTimeSeconds, end: p.endTimeSeconds }));
    const dry = { ...base, engine: 'transkun' };
    const wet = { ...dry, pedals };

    // S2: drive the real engine frame by frame with a sampler that records what it is asked.
    let now = 0;
    performance.now = () => now * 1000;
    const runEngine = (song) => {
      const calls = [];
      const e = new PlaybackEngine();
      e.sampler = { triggerAttackRelease: (name, dur, _t, vel) => calls.push({ name, dur, at: now }), releaseAll() {}, release: 1 };
      e.loaded = true;
      e.setSong(song);
      e._playing = true;
      now = 0;
      e.tick();
      while (e.playing) {
        now += 1 / 60;
        e.tick();
      }
      return calls;
    };
    const dryCalls = runEngine(dry);
    const wetCalls = runEngine(wet);
    const notes = dry.notes;
    const ends = sustainedEnds(notes, pedals);

    // S3: the export's piano render, both ways.
    const sr = 22050;
    const dur = dry.duration + 2;
    const bufDry = await renderPianoAudio(dry, dur, sr);
    const bufWet = await renderPianoAudio(wet, dur, sr);
    const mono = (b) => {
      const a = b.getChannelData(0);
      const c = b.numberOfChannels > 1 ? b.getChannelData(1) : a;
      const m = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) m[i] = (a[i] + c[i]) / 2;
      return m;
    };
    const toB64 = (m) => {
      const i16 = new Int16Array(m.length);
      for (let i = 0; i < m.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(m[i] * 32767)));
      const u8 = new Uint8Array(i16.buffer);
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const mDry = mono(bufDry);
    const mWet = mono(bufWet);
    return {
      notes: notes.map((n) => [n.midi, n.startTime, n.duration]),
      ends: ends ? [...ends] : null,
      sustain: pedals.filter((p) => p.cc === 64),
      dryCalls,
      wetCalls,
      sr,
      dry: Array.from(mDry),
      wet: Array.from(mWet),
      wav: wantWav ? { dry: toB64(mDry), wet: toB64(mWet) } : null,
    };
  },
  { reply, wantWav: !!outDir },
);
await browser.close();

// ---- S2 ----
const { notes, ends, sustain, dryCalls, wetCalls } = res;
check(dryCalls.length === notes.length && wetCalls.length === notes.length, `S2 every note triggered (${dryCalls.length}/${wetCalls.length}/${notes.length})`);
check(
  dryCalls.every((c, i) => Math.abs(c.dur - Math.max(0.05, notes[i][2])) < 1e-9),
  'S2 without pedals: every release at exactly n.duration (as before)',
);
check(wetCalls.every((c, i) => c.dur >= Math.max(0.05, notes[i][2]) - 1e-9), 'S2 with pedals: no note shorter than before');
const extended = wetCalls.map((c, i) => c.dur - Math.max(0.05, notes[i][2])).filter((d) => d > 1e-6);
const underPedal = notes.filter(([, s, d]) => sustain.some((p) => p.start <= s + d && s + d < p.end)).length;
check(extended.length > 0, `S2 with pedals: ${extended.length} of ${notes.length} notes ring longer (${underPedal} released under the pedal)`);
// Per key, pedalled rings never overlap each other (a re-strike ends the earlier one).
let stacked = 0;
const byKey = new Map();
notes.forEach(([m, s], i) => {
  const prev = byKey.get(m);
  if (prev != null && ends[prev] > notes[prev][1] + notes[prev][2] + 1e-9 && ends[prev] > s + 1e-9) stacked++;
  byKey.set(m, i);
});
check(stacked === 0, `S2 no key stacks a pedalled ring over its own re-strike (${stacked})`);
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);
console.log(`     extra ring per extended note: median ${median(extended).toFixed(2)}s, max ${Math.max(0, ...extended).toFixed(2)}s`);
// How many notes sound at once, inside the pedal spans (sampled every 50 ms).
const voices = (endOf) => {
  const v = [];
  for (const p of sustain)
    for (let t = p.start; t < p.end; t += 0.05) v.push(notes.filter(([, s], i) => s <= t && t < endOf(i)).length);
  return v;
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const vDry = voices((i) => notes[i][1] + notes[i][2]);
const vWet = voices((i) => ends[i]);
console.log(`     notes sounding together inside pedal spans: before ${mean(vDry).toFixed(2)} avg, after ${mean(vWet).toFixed(2)} avg`);
console.log(`     pedal-span moments with nothing sounding: before ${(100 * mean(vDry.map((x) => +(x === 0)))).toFixed(0)}%, after ${(100 * mean(vWet.map((x) => +(x === 0)))).toFixed(0)}%`);

// ---- S3 ----
const sr = res.sr;
const win = Math.round(0.05 * sr);
const envDb = (sig) => {
  const out = [];
  for (let i = 0; i + win <= sig.length; i += win) {
    let s = 0;
    for (let k = i; k < i + win; k++) s += sig[k] * sig[k];
    out.push(10 * Math.log10(s / win + 1e-12));
  }
  return out;
};
const eDry = envDb(res.dry);
const eWet = envDb(res.wet);
const inPedal = (j) => sustain.some((p) => p.start <= j * 0.05 && j * 0.05 < p.end);
const idx = eDry.map((_, j) => j).filter(inPedal);
const quiet = (e) => (100 * idx.filter((j) => e[j] < -50).length) / Math.max(1, idx.length);
const avg = (e) => mean(idx.map((j) => e[j]));
console.log(`S3 render inside pedal spans (${idx.length} x 50 ms):`);
console.log(`     mean level  before ${avg(eDry).toFixed(1)} dBFS, after ${avg(eWet).toFixed(1)} dBFS`);
console.log(`     near-silent (< -50 dBFS) windows  before ${quiet(eDry).toFixed(0)}%, after ${quiet(eWet).toFixed(0)}%`);
if (wavPath) {
  // Original recording's envelope at the same 50 ms grid (16-bit mono PCM WAV expected).
  const b = readFileSync(wavPath);
  const osr = b.readUInt32LE(24);
  const dataAt = b.indexOf('data') + 8;
  const n = Math.floor((b.length - dataAt) / 2);
  const ow = Math.round(0.05 * osr);
  const eOrig = [];
  for (let i = 0; i + ow <= n; i += ow) {
    let s = 0;
    for (let k = i; k < i + ow; k++) {
      const x = b.readInt16LE(dataAt + 2 * k) / 32768;
      s += x * x;
    }
    eOrig.push(10 * Math.log10(s / ow + 1e-12));
  }
  const corr = (e) => {
    const js = idx.filter((j) => j < eOrig.length);
    const xs = js.map((j) => e[j]);
    const ys = js.map((j) => eOrig[j]);
    const mx = mean(xs);
    const my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let k = 0; k < xs.length; k++) {
      sxy += (xs[k] - mx) * (ys[k] - my);
      sxx += (xs[k] - mx) ** 2;
      syy += (ys[k] - my) ** 2;
    }
    return sxy / Math.sqrt(sxx * syy);
  };
  console.log(`     loudness envelope vs the original recording (Pearson r)  before ${corr(eDry).toFixed(3)}, after ${corr(eWet).toFixed(3)}`);
}
if (outDir && res.wav) {
  mkdirSync(outDir, { recursive: true });
  const wav = (b64, name) => {
    const pcm = Buffer.from(b64, 'base64');
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
    h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    writeFileSync(path.join(outDir, name), Buffer.concat([h, pcm]));
  };
  wav(res.wav.dry, 'before-no-pedal.wav');
  wav(res.wav.wet, 'after-with-pedal.wav');
  console.log(`     wrote ${outDir}/before-no-pedal.wav, after-with-pedal.wav`);
}
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
