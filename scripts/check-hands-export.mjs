// Hands, checked on the picture the video export actually paints (phase 9b).
//
// usage: node scripts/check-hands-export.mjs [--fps 30] [--from t0 --to t1] <song.json>...
//   song.json: a song record (or an array of them, last one used) as stored by the app; the
//   layout is 'video' for kind 'video', else 'audio', as the export uses. Needs Playwright and
//   a Chromium: set PLAYWRIGHT_FROM to a folder whose node_modules has playwright (default:
//   this repo, then /tmp/cascade-video-test), and CHROMIUM to the browser binary if Playwright
//   can't find its own.
//
// Why this exists: phase 9's check-hand-ik measured the hands on a model of the export (no
// off-keyboard notes skipped, its own keyboard geometry, no trail copies) and reported 0 overlap
// frames while the sent video showed the hands on top of each other. This one runs the real
// ExportFrameRenderer in a browser and measures its pixels:
//  P1 each hand painted alone on its own transparent layer by drawHands (palm, fingers, wrist
//     fade; contact shadow left out), at every export frame: no pixel inked (alpha >= 8/255)
//     by both hands, and at least MIN_GAP px between them in every row both cover.  HARD
//  P2 every key the export lights (its own drawNotes) has a fingertip of the hand whose colour
//     it is lit in on it (within 0.12 white key), and no pressing finger of the other hand. HARD
//  P3 the split: no left-hand note right of a right-hand note when both can be on screen
//     together (sounding spans < 3.2 s apart), nor on the same key within 1 s.           HARD
//  P4 each hand's own outline (phase 10): every piece of the silhouette (palm, finger webs,
//     fingers, thumb web, thumb base), as handSilhouette gives them, is a simple polygon in
//     every frame: no edge crosses another edge of the same piece.                       HARD
//  P5 no popping outline: between consecutive frames no piece of a hand's silhouette moves
//     (Hausdorff distance) more than POP_SLACK white keys beyond the furthest any joint of
//     that hand (or its wrist stub's end) moved. An outline that jumps while the bones
//     glide is a pop.                                                                    HARD
// Also printed (not gated): the fastest one-frame change of a hand's thumb-to-little-finger
// spread, white keys (a stretch that opens in a frame or two shows up here).
// Unfingered notes are printed (a note no finger plays is drawn hollow, never lit).
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const MIN_GAP = 8;
const POP_SLACK = 0.25;
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return Number(v);
};
const fps = opt('--fps', 30);
const from = opt('--from', 0);
const to = opt('--to', Infinity);
if (!args.length) {
  console.error('usage: node scripts/check-hands-export.mjs [--fps 30] [--from t0 --to t1] <song.json>...');
  process.exit(2);
}

const entry = `
import { ExportFrameRenderer } from './src/export/frameRenderer';
import { drawHands, tipFrame, handSilhouette, handUnit } from './src/hands/drawHands';
import { solveSkeleton } from './src/hands/skeleton';
import { crossed } from './src/hands/splitLine';
import { mergeGhostReonsets } from './src/lib/reonsets';
const W = 1080, H = 1920;
// As library getSong does for transcribed songs.
window.prep = (rec) => ({ ...rec, notes: rec.kind === 'midi' ? rec.notes : mergeGhostReonsets(rec.notes).notes });
// Proper crossings between non-adjacent edges of one closed polygon.
const selfCrossings = (P) => {
  const n = P.length;
  let c = 0;
  const cr = (a, b, q) => (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const p = P[j], q = P[(j + 1) % n];
      if (Math.max(p.x, q.x) < x0 || Math.min(p.x, q.x) > x1 || Math.max(p.y, q.y) < y0 || Math.min(p.y, q.y) > y1) continue;
      const d1 = cr(a, b, p), d2 = cr(a, b, q), d3 = cr(p, q, a), d4 = cr(p, q, b);
      if (((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))) c++;
    }
  }
  return c;
};
// Symmetric Hausdorff distance between two closed outlines: every point of one (vertices and
// points along its edges) to the nearest point on the other's edges.
const hausdorff = (A, B) => {
  const segD2 = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const s = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    return (p.x - a.x - s * dx) ** 2 + (p.y - a.y - s * dy) ** 2;
  };
  const dense = (P) => {
    const out = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 3));
      for (let j = 0; j < k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k });
    }
    return out;
  };
  const one = (X, Y) => {
    let m = 0;
    for (const p of dense(X)) {
      let d = Infinity;
      for (let i = 0; i < Y.length && d > m; i++) d = Math.min(d, segD2(p, Y[i], Y[(i + 1) % Y.length]));
      m = Math.max(m, d);
    }
    return Math.sqrt(m);
  };
  return Math.max(one(A, B), one(B, A));
};
let prevSil = null;
window.resetSil = () => { prevSil = null; };
window.measure = (song, layout, times, minGap) => {
  const r = new ExportFrameRenderer(song, layout, true);
  const anim = r.hands, g = r.handGeom;
  if (!anim) return { frames: [] };
  const y0 = Math.max(0, Math.floor(r.strikeY - 60)), y1 = Math.ceil(r.footerTop), h = y1 - y0;
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c.getContext('2d'); };
  const A = mk(), B = mk();
  const tf = tipFrame(g);
  const layer = (ctx, hand, t) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, r.footerTop); ctx.clip();
    drawHands(ctx, anim, t, g, { left: hand === 'left', right: hand === 'right' }, false);
    ctx.restore();
    return ctx.getImageData(0, y0, W, h).data;
  };
  const frames = [];
  for (const t of times) {
    const a = layer(A, 'left', t), b = layer(B, 'right', t);
    let over = 0, gap = Infinity;
    for (let y = 0; y < h; y++) {
      let la = -1, rb = -1;
      const row = y * W * 4;
      for (let x = 0; x < W; x++) {
        const ia = a[row + x * 4 + 3] >= 8, ib = b[row + x * 4 + 3] >= 8;
        if (ia) la = x;
        if (ib && rb < 0) rb = x;
        if (ia && ib) over++;
      }
      if (la >= 0 && rb >= 0) gap = Math.min(gap, rb - la - 1);
    }
    const sk = {};
    for (const hd of ['left', 'right']) { const p = anim.pose(hd, t); sk[hd] = p ? solveSkeleton(p, tf) : null; }
    const tipX = (hd, f) => { const j = sk[hd].fingers[f].joints; return j[j.length - 1].x; };
    const lit = [];
    for (const [midi, { hand }] of r.drawNotes(t)) {
      const key = r.keyByMidi.get(midi);
      const tol = 0.12 * r.whiteW;
      const inKey = (x) => x >= key.x - tol && x <= key.x + key.w + tol;
      const other = hand === 'left' ? 'right' : 'left';
      let why = '';
      if (!sk[hand] || ![1, 2, 3, 4, 5].some((f) => inKey(tipX(hand, f)))) why = 'no ' + hand + ' finger on it';
      if (sk[other] && [1, 2, 3, 4, 5].some((f) => inKey(tipX(other, f)) && sk[other].fingers[f].press > 0.3)) why += (why ? ', ' : '') + other + ' hand presses it';
      if (why) lit.push(midi + ' (' + hand + '): ' + why);
    }
    // P4/P5: each hand's own outline.
    const unit = handUnit(g);
    const selfX = [], pop = { d: 0, hand: '', piece: -1 }, spread = { d: 0, hand: '' };
    const cur = {};
    for (const hd of ['left', 'right']) {
      const s = handSilhouette(anim, hd, t, g);
      if (!s) continue;
      const joints = [];
      for (let f = 1; f <= 5; f++) joints.push(...s.sk.fingers[f].joints);
      joints.push(...(s.wrist ?? []));
      const tip = (f) => s.sk.fingers[f].joints[s.sk.fingers[f].joints.length - 1];
      cur[hd] = { polys: s.polys, joints, span: Math.hypot(tip(5).x - tip(1).x, tip(5).y - tip(1).y) };
      s.polys.forEach((P, i) => { const c = selfCrossings(P); if (c) selfX.push(hd + ' piece ' + i + ': ' + c); });
      const pv = prevSil && prevSil.t > t - 1.5 / 30 - 1e-6 && prevSil.t < t ? prevSil[hd] : null;
      if (pv) {
        const ds = Math.abs(cur[hd].span - pv.span) / unit;
        if (ds > spread.d) Object.assign(spread, { d: ds, hand: hd });
      }
      if (pv && pv.polys.length === s.polys.length) {
        let jm = 0;
        joints.forEach((j, i) => { const q = pv.joints[i]; if (q) jm = Math.max(jm, Math.hypot(j.x - q.x, j.y - q.y)); });
        s.polys.forEach((P, i) => {
          const ex = (hausdorff(P, pv.polys[i]) - jm) / unit;
          if (ex > pop.d) Object.assign(pop, { d: ex, hand: hd, piece: i });
        });
      }
    }
    prevSil = { t, ...cur };
    frames.push({ t, over, gap, lit, selfX, pop, spread });
  }
  const N = song.notes, split = [];
  const on = (i) => anim.inRange(i);
  for (let i = 0; i < N.length; i++) for (let j = 0; j < N.length; j++)
    if (on(i) && on(j) && anim.handOf(i) === 'left' && anim.handOf(j) === 'right' && crossed(N[i], N[j]))
      split.push('L ' + N[i].midi + ' @' + N[i].startTime.toFixed(2) + ' vs R ' + N[j].midi + ' @' + N[j].startTime.toFixed(2));
  const unfingered = N.filter((_, i) => on(i) && !anim.fingering.perNote[i].finger).length;
  return { frames, split, unfingered };
};
`;
const bundle = 'scripts/_hands-export-bundle.js';
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'iife', outfile: bundle, logLevel: 'silent' });
const code = readFileSync(bundle, 'utf8');
rmSync(bundle);

let chromium;
for (const dir of [process.env.PLAYWRIGHT_FROM, process.cwd(), '/tmp/cascade-video-test'].filter(Boolean)) {
  for (const pkg of ['playwright', 'playwright-core']) {
    try {
      chromium = createRequire(path.join(dir, 'x.js'))(pkg).chromium;
      break;
    } catch {}
  }
  if (chromium) break;
}
if (!chromium) {
  console.error('check-hands-export: Playwright not found (set PLAYWRIGHT_FROM)');
  process.exit(2);
}
const browser = await chromium.launch({
  ...(process.env.CHROMIUM && existsSync(process.env.CHROMIUM) ? { executablePath: process.env.CHROMIUM } : {}),
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.setContent('<html><body></body></html>');
await page.addScriptTag({ content: code });

const runs = (frames, bad) => {
  const out = [];
  let a = null;
  let p = null;
  for (const f of frames) {
    if (!bad(f)) continue;
    if (a !== null && f.t - p > 1.5 / fps) out.push(`${a.toFixed(2)}-${p.toFixed(2)}`), (a = null);
    if (a === null) a = f.t;
    p = f.t;
  }
  if (a !== null) out.push(`${a.toFixed(2)}-${p.toFixed(2)}`);
  return out.join(' ');
};
let failed = 0;
for (const file of args) {
  const arr = JSON.parse(readFileSync(file, 'utf8'));
  const rec = Array.isArray(arr) ? arr[arr.length - 1] : arr;
  const song = await page.evaluate((r) => window.prep(r), rec.song ?? rec);
  const layout = song.kind === 'video' ? 'video' : 'audio';
  const end = Math.min(to, Math.max(...song.notes.map((n) => n.startTime + n.duration)) + 0.5);
  const times = [];
  for (let i = Math.ceil(from * fps); i / fps <= end; i++) times.push(i / fps);
  const frames = [];
  let res;
  await page.evaluate(() => window.resetSil());
  for (let k = 0; k < times.length; k += 200) {
    res = await page.evaluate(([s, l, t, m]) => window.measure(s, l, t, m), [song, layout, times.slice(k, k + 200), MIN_GAP]);
    frames.push(...res.frames);
  }
  const over = frames.filter((f) => f.over > 0);
  const near = frames.filter((f) => f.gap < MIN_GAP);
  const lit = frames.filter((f) => f.lit.length);
  const minGap = Math.min(...frames.map((f) => f.gap));
  const name = path.basename(file);
  const ok1 = over.length === 0 && near.length === 0;
  const ok2 = lit.length === 0;
  const ok3 = res.split.length === 0;
  console.log(`${ok1 ? 'PASS' : 'FAIL'}: ${name} (${layout}, ${frames.length} frames at ${fps} fps): hands overlap in ${over.length} frames${over.length ? ` (${runs(frames, (f) => f.over > 0)})` : ''}; closer than ${MIN_GAP} px in ${near.length}${near.length ? ` (${runs(frames, (f) => f.gap < MIN_GAP)})` : ''}; smallest gap ${Number.isFinite(minGap) ? minGap : '-'} px`);
  console.log(`${ok2 ? 'PASS' : 'FAIL'}: ${name}: lit keys without a finger of their colour's hand: ${lit.length} frames${lit.length ? ` (${runs(frames, (f) => f.lit.length)})` : ''}`);
  for (const f of lit.slice(0, 8)) console.log(`    ${f.t.toFixed(3)} s: ${f.lit.join('; ')}`);
  console.log(`${ok3 ? 'PASS' : 'FAIL'}: ${name}: left-hand notes right of right-hand notes on screen together: ${res.split.length}${res.split.length ? ` (${res.split.slice(0, 6).join(', ')})` : ''}; notes no finger plays (drawn hollow): ${res.unfingered}`);
  const sx = frames.filter((f) => f.selfX.length);
  const pops = frames.filter((f) => f.pop.d > POP_SLACK);
  const worst = frames.reduce((a, f) => (f.pop.d > a.pop.d ? f : a), frames[0]);
  const ok4 = sx.length === 0;
  const ok5 = pops.length === 0;
  console.log(`${ok4 ? 'PASS' : 'FAIL'}: ${name}: hand outline pieces crossing themselves: ${sx.length} frames${sx.length ? ` (${runs(frames, (f) => f.selfX.length)})` : ''}`);
  for (const f of sx.slice(0, 4)) console.log(`    ${f.t.toFixed(3)} s: ${f.selfX.join('; ')}`);
  console.log(`${ok5 ? 'PASS' : 'FAIL'}: ${name}: outline pops (a piece moving > ${POP_SLACK} white key beyond its joints): ${pops.length} frames${pops.length ? ` (${runs(frames, (f) => f.pop.d > POP_SLACK)})` : ''}; worst ${worst.pop.d.toFixed(3)} key at ${worst.t.toFixed(3)} s (${worst.pop.hand} piece ${worst.pop.piece})`);
  const fast = frames.reduce((a, f) => (f.spread.d > a.spread.d ? f : a), frames[0]);
  console.log(`info: ${name}: fastest change of a hand's thumb-to-little-finger spread: ${fast.spread.d.toFixed(2)} white key in one frame at ${fast.t.toFixed(3)} s (${fast.spread.hand})`);
  failed += !ok1 + !ok2 + !ok3 + !ok4 + !ok5;
}
await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall export-picture hand checks passed');
process.exit(failed ? 1 : 0);
