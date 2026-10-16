# Wire up sustain pedal into playback audio

## Goal
He noticed Cascade's audio playback sounds "empty"/dry compared to the real recording —
notes cut off short instead of ringing together the way the sustain pedal blends them,
"making the song lose its charm." Root cause found before building: the desktop
(Transkun) transcription engine already returns sustain-pedal spans
(`src/lib/transcribe.ts` line ~19-20, `pedals?: { cc, startTimeSeconds, endTimeSeconds }[]`)
but the app drops them entirely — the comment literally says "Not used by the app yet."
Wire this through to real audio: while the pedal is down, notes should keep ringing
(release extended) instead of stopping at their own transcribed duration.

## Not doing
- Not changing hand animation/fingering/fingering-hold logic unless it's trivial once
  pedal data is threaded through (separate concern — this task is about AUDIO).
- Not building pedal detection for the on-device (Basic Pitch) engine if it genuinely
  isn't available there — confirm this is really desktop-only before assuming, but
  don't invent a pedal-detection heuristic from audio alone unless it's cheap and safe;
  say clearly in the report if Basic Pitch songs just don't get this.
- Not pushing to production — local preview only.

## Done when
1. `npm run build` succeeds, no new TS errors.
2. `pedals` from the desktop engine response is threaded through the pipeline into the
   `Song` type (not dropped) and persisted with the song (survives reload from the
   library, not just the current session).
3. `src/audio/playback.ts`'s note scheduling extends a note's effective ring-out while
   the sustain pedal is down at/after its nominal end (standard sustain semantics: a
   note already sounding keeps ringing until the LATER of its own release or the next
   pedal-up), instead of always releasing at `n.duration`.
4. Audible, verifiable difference: play a real desktop-transcribed song with pedal spans
   (use his reel or another real recording that actually used pedal) before/after this
   change and confirm notes within a pedal span now overlap/ring together instead of
   cutting off dry. Describe or capture this concretely (e.g. measure actual sample
   release times against pedal spans), not just "sounds better."
5. No regression: a song with NO pedal data (Basic Pitch / on-device songs, or desktop
   songs with no pedal use) plays exactly as before.
6. Play-along / wait-mode / MIDI practice behavior unaffected — pedal sustain is an
   audio-only change, not a timing/expected-note change for practice modes.
7. No regression in existing checks (`check-hand-ik.mjs`, `check-hands-export.mjs`,
   `check-fingering.mjs`, `check-transcribe.mjs` if it touches this path).

## Tries
5

## Open questions
None — scope is clear from the existing (currently unused) `pedals` field and his
description of the symptom.
