# Transcription noise cleanup (2026-10-14)

## Goal
The Transkun transcription pipeline is picking up ambient/room noise and turning it into
played notes that never happened. Root-cause and fix this generally in the backend
(the Transkun helper and/or the app's post-processing), not as a special case for any one
song or clip.

## Done when
- [ ] Root cause identified: which stage introduces the false notes (Transkun's own
      pitch/onset detection on quiet broadband noise, missing an energy/confidence gate,
      or the app-side cleanup/post-processing not filtering low-confidence/low-velocity
      results).
- [ ] A silence/ambient-noise-only segment (no real playing) produces zero or near-zero
      notes through the real pipeline, before and after compared.
- [ ] Existing accuracy suite (`projects/amt-eval/`) re-run: MAESTRO onset F1 and his reel
      vs the reference video comparison don't regress from their last-measured numbers
      (98.5 / 93.2 with 1.7% unmatched, per memory/project/piano-app-repo.md) — the fix
      must not cost real-note recall while killing noise.
- [ ] Fix is in shared code (Transkun helper's confidence/energy threshold, or a shared
      cleanup pass), not a per-song/per-file exception.
- [ ] `check-transcribe.mjs` and `check-cleanup.mjs` pass.
- [ ] A short before/after demo clip showing a quiet/ambient section that used to produce
      phantom notes, now producing none (or a clear reduction), delivered to him.

## Not doing
- Not touching hand-animation/fingering code (that's the separate, already-delivered
  task from earlier today).
- No push to origin / no deploy — preview only, same standing rule as always.

## Tries
5 build-and-check rounds before stopping to ask.

## Open questions
None — he gave a clear, general instruction (fix the backend, don't patch per-song).
Starting immediately per task-loop's rule for a fully specific instruction.
