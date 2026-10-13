/**
 * Semitone trills under the pedal: read which key is being played from the model's own
 * per-frame map, because Basic Pitch's note builder gets them wrong.
 *
 * Why: `outputToNotesPoly` builds notes from onset peaks, latest first, and zeroes the
 * energy one semitone above and below each note it builds. In a trill with the pedal down
 * both keys ring the whole time, the model's onset map also fires on the neighbour key at
 * each strike, and the pedal keeps the frame energy of both keys up. The result is a long
 * run of one key with the other one's presses wiped out: Für Elise's E5–D#5 trill came out
 * as eleven E5s and one D#5, while the model's frame map (and the audio) clearly alternate.
 *
 * What this does: for each pair of neighbouring keys, find stretches where both ring at
 * once; inside one, follow which key is louder frame by frame. A switch counts as a new
 * press only when the newly louder key also has an onset in the model's onset map just
 * before it (so a note simply fading under another doesn't count). If that gives at least
 * MIN_PRESSES alternating presses, the stretch is a trill: the notes Basic Pitch built for
 * those two keys there are replaced by one note per press. Anything else is left alone.
 */

export interface PolyNote {
  startFrame: number;
  durationFrames: number;
  pitchMidi: number;
  amplitude: number;
}

const MIDI_OFFSET = 21;
/** Frames (~11.6 ms each) one key may dip below threshold without ending the stretch. */
const GAP = 4;
/** A stretch shorter than this (~0.35 s) can't hold a trill worth fixing. */
const MIN_STRETCH = 30;
/** One key must lead by at least this much frame activation for the lead to count. */
const MARGIN = 0.02;
/** A press needs an onset peak on its key (as strong as any note needs) this many frames before (or PRESS_LOOKAHEAD after) the moment its key takes the lead. */
const PRESS_LOOKBACK = 12;
const PRESS_LOOKAHEAD = 6;
/** Alternating presses needed before the stretch is treated as a trill. */
const MIN_PRESSES = 4;

interface Segment {
  bin: number; // which of the pair leads: b or b + 1
  start: number;
  end: number; // exclusive
}

export function resolveSemitoneTrills(
  frames: number[][],
  onsets: number[][],
  notes: PolyNote[],
  onsetThresh: number,
  frameThresh: number,
  minNoteLen: number,
): { notes: PolyNote[]; trills: { pitch: number; startFrame: number; endFrame: number; presses: number }[] } {
  const nFrames = Math.min(frames.length, onsets.length);
  const trills: { pitch: number; startFrame: number; endFrame: number; presses: number }[] = [];
  if (nFrames < MIN_STRETCH) return { notes, trills };
  const nBins = frames[0].length;
  let out = notes;

  for (let b = 0; b + 1 < nBins; b++) {
    // Stretches where both keys ring.
    const both = (f: number) => frames[f][b] >= frameThresh && frames[f][b + 1] >= frameThresh;
    let f = 0;
    while (f < nFrames) {
      if (!both(f)) {
        f++;
        continue;
      }
      const s = f;
      let gap = 0;
      while (f < nFrames && gap <= GAP) {
        gap = both(f) ? 0 : gap + 1;
        f++;
      }
      const e = f - gap;
      if (e - s < MIN_STRETCH) continue;
      const segs = pressesIn(frames, onsets, b, s, e, onsetThresh, frameThresh, minNoteLen);
      if (segs.length < MIN_PRESSES) continue;
      out = replaceStretch(out, frames, b, s, e, segs);
      trills.push({ pitch: b + MIDI_OFFSET, startFrame: s, endFrame: e, presses: segs.length });
    }
  }
  return { notes: out, trills };
}

/** Which key leads, frame by frame, merged into presses that each start on an onset. */
function pressesIn(
  frames: number[][],
  onsets: number[][],
  b: number,
  s: number,
  e: number,
  onsetThresh: number,
  frameThresh: number,
  minNoteLen: number,
): Segment[] {
  const diff = (f: number) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(s, f - 1); j <= Math.min(e - 1, f + 1); j++, n++) sum += frames[j][b] - frames[j][b + 1];
    return sum / n;
  };
  // Raw lead runs; frames inside the margin keep the current leader.
  const runs: Segment[] = [];
  let lead = diff(s) >= 0 ? b : b + 1;
  let start = s;
  for (let f = s + 1; f < e; f++) {
    const d = diff(f);
    const now = d > MARGIN ? b : d < -MARGIN ? b + 1 : lead;
    if (now !== lead) {
      runs.push({ bin: lead, start, end: f });
      lead = now;
      start = f;
    }
  }
  runs.push({ bin: lead, start, end: e });

  // A lead change is a press only if it is long enough and the key was struck just before.
  const segs: Segment[] = [];
  for (const r of runs) {
    const prev = segs[segs.length - 1];
    if (!prev) {
      // The stretch opens on whichever key leads. If that key was already sounding before the
      // stretch, it's the pedal holding an earlier note, not a new press.
      let fresh = false;
      for (let j = Math.max(0, s - PRESS_LOOKBACK); j < s; j++) if (frames[j][r.bin] < frameThresh) fresh = true;
      if (!fresh) segs.push({ ...r, bin: -1 });
      else {
        // A fresh key's press began at its onset, which can be just before the stretch.
        const onset = struckAt(onsets, r.bin, r.start, s - PRESS_LOOKBACK, onsetThresh);
        segs.push({ ...r, start: onset >= 0 ? Math.min(onset, r.start) : r.start });
      }
      continue;
    }
    const onset = struckAt(onsets, r.bin, r.start, s - PRESS_LOOKBACK, onsetThresh);
    if (r.bin === prev.bin || (prev.bin === -1 && r.bin === runs[0].bin) || r.end - r.start < minNoteLen || onset < 0) {
      prev.end = r.end;
      continue;
    }
    // The press began at the onset, not when its key finally got louder.
    const at = prev.bin === -1 ? onset : Math.max(onset, prev.start + minNoteLen);
    prev.end = at;
    segs.push({ bin: r.bin, start: at, end: r.end });
  }
  return segs[0]?.bin === -1 ? segs.slice(1) : segs;
}

/** Frame of the strongest onset peak on `bin` shortly before `f`, or -1. */
function struckAt(onsets: number[][], bin: number, f: number, floor: number, thresh: number): number {
  let best = -1;
  let bestV = thresh;
  for (let j = Math.max(0, floor, f - PRESS_LOOKBACK); j <= Math.min(onsets.length - 1, f + PRESS_LOOKAHEAD); j++) {
    const v = onsets[j][bin];
    if (v >= bestV) {
      bestV = v;
      best = j;
    }
  }
  return best;
}

function replaceStretch(
  notes: PolyNote[],
  frames: number[][],
  b: number,
  s: number,
  e: number,
  segs: Segment[],
): PolyNote[] {
  const lo = b + MIDI_OFFSET;
  const inPair = (n: PolyNote) => n.pitchMidi === lo || n.pitchMidi === lo + 1;
  const kept: PolyNote[] = [];
  // The first press can sit a little before the stretch: its onset comes before both keys ring.
  s = Math.min(s, segs[0].start);
  let tailEnd = e;
  for (const n of notes) {
    const end = n.startFrame + n.durationFrames;
    if (!inPair(n) || end <= s || n.startFrame >= e) {
      kept.push({ ...n });
      continue;
    }
    if (n.startFrame < s) {
      // Started before the trill: it rings until the trill's first press.
      kept.push({ ...n, durationFrames: Math.min(n.durationFrames, s - n.startFrame) });
      continue;
    }
    // Built inside the stretch: dropped. If it rang past the end, the last press keeps that length.
    const lastBin = segs[segs.length - 1].bin + MIDI_OFFSET;
    if (n.pitchMidi === lastBin && n.startFrame >= segs[segs.length - 1].start) tailEnd = Math.max(tailEnd, end);
  }
  segs.forEach((seg, k) => {
    const end = k === segs.length - 1 ? tailEnd : seg.end;
    let sum = 0;
    for (let j = seg.start; j < Math.min(end, frames.length); j++) sum += frames[j][seg.bin];
    kept.push({
      startFrame: seg.start,
      durationFrames: end - seg.start,
      pitchMidi: seg.bin + MIDI_OFFSET,
      amplitude: sum / Math.max(1, Math.min(end, frames.length) - seg.start),
    });
  });
  return kept;
}
