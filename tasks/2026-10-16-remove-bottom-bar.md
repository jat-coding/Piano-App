# Remove the bottom transport bar — gestures + the top-right dropdown only

## Goal
Following this morning's settings-dropdown consolidation (commit `bb39ebb`): he now wants
the bottom bar (`Scrubber` + `Controls` — the progress dots, play/pause/skip, rate
slider, A/B loop, L/R hand toggle, practice-mode button, play-along mic, export) gone
from the main screen entirely. Seeking is tap/drag on the falling notes (`NoteScrub`,
already wired — tap toggles play/pause, drag scrubs); anything without an existing
gesture (rate, A/B loop, L/R hand show/hide, play-along, export) moves into the same
top-right dropdown `Settings.tsx` already has (`Playback` section exists — add to it or
a new section).

## Not doing
- Not touching `NoteScrub` / tap-to-play / drag-to-scrub gesture logic itself — it
  already works, this task just removes the redundant on-screen bar.
- Not touching hand motion, transcription, cleanup logic, or the Perspective view work
  from this morning.
- Not pushing to production — local preview only.

## Done when
1. `npm run build` succeeds, no new TS errors.
2. `src/components/Scrubber.tsx` and `src/components/Controls.tsx` (or their rendering
   in `Player.tsx`) are no longer shown as an always-on bottom bar — the main screen
   with a song loaded is just the falling notes, hands and keyboard (same bar the gear
   button already lives in, nothing else).
3. Tap-to-play/pause and drag-to-scrub on the falling notes still work exactly as
   before (verify by actually tapping and dragging in the real local preview, not just
   reading the code — `NoteScrub` already implements this, don't break it).
4. Every control that had no gesture equivalent is reachable from the top-right
   dropdown: playback rate, A/B loop (set at current time + clear), L/R hand show/hide,
   MIDI practice mode (already there), play-along, export video. Confirm each one still
   does what it did before (e.g. Export still opens `ExportDialog` and produces a real
   MP4; Play-along still opens the `PlayAlong` panel).
5. The "Waiting — play the green keys" hint, loading spinner, and rotate-to-landscape
   overlay still show correctly (these aren't part of the bar being removed, just
   confirm nothing else broke).
6. No regression in the hand/export checks (`check-hand-ik.mjs`, `check-hands-export.mjs`,
   `check-fingering.mjs`) — this is a UI-location change, not a rendering change, but
   VERIFY.md requires running them for any change to this project.
7. Screenshot from the real local preview (localhost:5191) showing the decluttered main
   screen, and a screenshot of the dropdown open showing the relocated controls.

## Tries
5

## Open questions
None — scope follows directly from his two messages today (settings dropdown, then
"remove the bottom settings and video scrubbing ... otherwise all scrubbing is done by
tapping and scrolling on the notes").

## Addendum (added mid-build, 2026-10-16 1:15pm)
"And the piano and hands should be at the bottom of the screen too" — with the bar gone,
the keyboard/hands should sit flush at the very bottom edge of the screen (within safe
areas), not floating above empty space where the bar used to be. If you've already
removed `barRef`'s height from `applyInsets()`, confirm the keyboard now anchors to the
true bottom edge; if not, this is the fix needed. Add to "Done when": a screenshot
confirming the keyboard's bottom edge sits at the screen's bottom safe-area edge, not
partway up with a gap below it.
