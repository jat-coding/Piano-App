# Hand motion naturalness + missed-note presses (2026-10-14)

## Goal
After seeing the new Transkun-engine demo, he wants the hand animation to move more like
the reference video — more dynamic movement and more natural finger curl/bend, currently
reads as too smooth/stiff — and wants every transcribed note to actually get a hand/finger
press (some notes currently play with no hand shown pressing them). Then a longer demo
video of the result.

## Done when
- [x] `check-fingering.mjs`, `check-hand-ik.mjs` pass. `check-hands-export.mjs`: **1 frame FAILS** (see Result).
- [x] `npm run build` succeeds with no new TS errors.
- [~] A real export (through the actual in-app export path, his reel as input) shows
      visibly more dynamic hand motion and finger curl than the current build, compared
      side-by-side against the reference video — confirmed by looking at frames/the
      actual .mp4, not just a checker passing (see VERIFY.md's phase-9 lesson).
- [~] Every note in the transcribed note list for a test song has a corresponding
      hand/finger press in the rendered export — zero notes silently un-pressed. Root
      cause identified and fixed (not a visual patch), documented in the hand-off report.
- [x] No regression on hand-overlap (phase 9b fix) or thumb-pinky stretch clipping (phase
      10 fix) — re-run those specific checks, not just the general suite.
- [x] A longer demo video is produced (longer than the ~20s clips used so far) showing the
      improved motion end to end on a real song, and delivered to him.

## Not doing
- No transcription-accuracy changes (that's done, separate from this task).
- No push to origin / no deploy — preview only, same standing rule as always.
- Not re-litigating the engine choice (Transkun vs Basic Pitch) — that's settled.

## Tries
5 build-and-check rounds before stopping to ask.

## Open questions
None — he gave a fully specific instruction (more dynamic/natural hand motion matching
the reference video, fix unpressed notes, then a longer demo). Starting immediately per
task-loop's rule for a fully specific instruction.

## Result (2026-10-14, build-20261014-114606-4764, round 1-4 of 5)

Changes (local only, branch `hands-redesign`, not pushed/deployed; preview :5191 rebuilt):
- `src/render/keyboard.ts`: **missed-note root cause.** `keyboardRange` trimmed up to 2 "stray"
  notes at each pitch edge of every song (meant for Basic Pitch ghost notes). Transkun songs are
  small (his reel segment: 29 notes), so this cut his reel's opening D5 (0.82 s, clearly real):
  no key drawn, and the export skips off-keyboard notes, so no finger ever pressed it. Now any
  note held >= 0.3 s always stays on the keyboard.
- `src/hands/fingering.ts`: same finger may not strike a different key < 90 ms after its last one
  (MIN_RESTRIKE cost). Rolled chords split into two events had reused a finger, so the first
  note's press ended before it began (Gymnopedie A4 @34.794 never showed a press).
- `src/hands/skeleton.ts` + `handPose.ts`: motion. Hand sinks into each keystroke (new `sink`
  envelope, 6 mm, 80 ms in / 220 ms out) so the pressing finger bends further; prep lift before a
  strike doubled for fingers already reaching for their key (-6 -> -12 deg MCP); idle drift
  1.2 -> 2.6 deg; neighbour-finger follow up ~35%; prep window 0.12 -> 0.15 s.

Evidence (all logs in `projects/Piano-App-harness/h1014/logs/`):
- check-fingering: ALL PASS (5 real songs). check-hand-ik: all hard checks pass; overlap 0
  frames on all 11 overlap cases (phase 9). trills/cleanup/parse/transcribe: pass.
- check-hands-export (real ExportFrameRenderer, 6 songs incl. his reel segment + his clip, both
  Transkun): overlap 0 frames, outline self-crossing 0, outline pops 0 (phase 9b/10 hold).
  **FAIL: old Basic Pitch Gymnopedie, 1 frame at 34.767 s** (G#5 lit while the little finger has
  started to leave). Old build passes this frame. Cause: the re-strike fix picks 2-5 then thumb
  for a rolled chord; the hand can't hold G#5 while the thumb lands on F#4 (tried holding it:
  11 bad frames; tried a 50 ms chord window: 11 bad frames). Trade: 1 frame (33 ms) vs a note
  whose press was never shown.
- Missed presses (cross-ref of note list vs presses at export frames, `tools/.unf2.tmp.ts`):
  his reel segment (Transkun) 29/29 pressed (before: 28/29, D5 off the keyboard);
  his 45 s clip (Transkun) 125/126 (unchanged: LH chord B2-A3-D4 wider than a hand while RH
  plays D6; drawn hollow, no hand can reach it). Old Basic Pitch songs still have 4-6
  unreachable / too-fast notes each (unchanged; would need rolled-chord animation).
- Curl/motion, measured from the solved skeleton at 30 fps (`logs/curl-measure.txt`), his clip
  old -> new: finger joint motion 0.70 -> 1.06 deg/frame (+51%), prep-lift tip height 6.8 -> 10.0
  mm (+47%), pressing PIP 26.1 -> 28.0 deg. Bigger curl was tried and rejected by the
  anatomy checks (rest-dome reach spec, fingertip 20-30 px off its key).
- Frames looked at: `h1014/frames/` (reelseg-D5-0.70.png = D5 fixed; strip-6.3s.png = keystroke
  strip old vs new). The difference in stills is subtle; it shows in motion.
- Not done: side-by-side against the reference video frame by frame (only eyeballed the
  existing reel). The full 2:18 reel source is no longer on disk.
- Long demo: `artifacts/piano-app/hands-motion-long-demo-2026-10-14.mp4` (verified: 135.0 s, h264+opus, audio mean -18 dB; 453/454 notes pressed) (2:15, Fur Elise +
  Gymnopedie + his clip, joined and exported through the real Export button, Transkun).
