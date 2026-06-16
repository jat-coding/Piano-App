// Verifies the note-derivation + cleanup math without running TF inference.
// Feeds synthetic Basic Pitch output (a held note) through the real
// outputToNotesPoly → noteFramesToTime → rawToSong path.
import pkg from '@spotify/basic-pitch';
const { outputToNotesPoly, noteFramesToTime } = pkg;

const N_FRAMES = 120;
const N_PITCHES = 88; // basic-pitch frame columns map to MIDI 21..108
const targetCol = 60 - 21; // MIDI 60 (middle C)

const frames = Array.from({ length: N_FRAMES }, () => new Array(N_PITCHES).fill(0.01));
const onsets = Array.from({ length: N_FRAMES }, () => new Array(N_PITCHES).fill(0.01));

// A held middle-C from frame 10..70 with a strong onset at frame 10.
for (let f = 10; f < 70; f++) frames[f][targetCol] = 0.9;
onsets[10][targetCol] = 0.95;

const poly = outputToNotesPoly(frames, onsets, 0.5, 0.3, 5, true);
const timed = noteFramesToTime(poly);

console.log('notes found:', timed.length);
for (const n of timed) {
  console.log(
    `  midi=${n.pitchMidi} start=${n.startTimeSeconds.toFixed(3)}s dur=${n.durationSeconds.toFixed(3)}s amp=${n.amplitude.toFixed(2)}`,
  );
}

const ok = timed.length >= 1 && timed.some((n) => Math.abs(n.pitchMidi - 60) <= 1);
console.log(ok ? 'PASS: derives the expected middle-C note' : 'FAIL: note not derived');
process.exit(ok ? 0 : 1);
