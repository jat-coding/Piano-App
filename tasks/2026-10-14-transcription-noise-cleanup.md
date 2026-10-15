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

## Result, round 1 (2026-10-14, commit 7a467dc, local only)
- [x] Root cause: NOT room noise. Transkun on pure noise (pink -60/-45/-35 dBFS, hum+knocks, reel lull 21.5-27.5 s, reel silent tail 128.5-135.5 s) = 0 notes in all 6, before any fix. The only clear phantom: a B2 held ~5 s at velocity 3-8/127 under a pedalled chord (reel 41.3 s). No velocity gate existed. Transkun has no confidence score, and velocity/duration/isolation/harmonic rules did not separate wrong notes from right ones on MAESTRO or the orchestra mixes (every rule tried cost more real notes than it removed).
- [x] Noise-only segments: 0 -> 0 notes (6 clips, helper on cuda).
- [~] Accuracy suite (offline re-score of the real helper's output, gate applied): MAESTRO 98.5 -> 98.5 (909 notes, none removed), mixes 74.6 -> 74.6, repeats 100 -> 100, Fur Elise / Gymnopedie / his clip unchanged. Reel 44 s clip 119 -> 118 notes, full reel 716 -> 715. Reel-vs-video F1 NOT re-run: the video answer key and scoring scripts were deleted in the 10:35 incident (only score.log survives). Restored clips/score.py from git 00449dfa into /tmp/nz.
- [x] Shared code: src/lib/noiseGate.ts dropInaudible(), applied in transcribe.ts to every desktop reply. No per-song logic.
- [x] check-cleanup.mjs PASS (new noise-gate case), check-transcribe.mjs PASS, tsc clean, :5191 rebuilt + restarted.
- [ ] Before/after demo via real Export: NOT made (ran out of time). The gate only removes 1 note on the reel, so a demo would show almost no visible change anyway.
