# Perspective/portrait view style (selectable, alongside the current view)

## Goal
He sent a reference reel (@FOREVERTILES) showing falling-note lanes converging to a
vanishing point above the keyboard (road-like perspective, not flat parallel lanes),
portrait aspect, and a reflection under the keys. He wants this as a NEW selectable view
style — not replacing the current flat/landscape rendering — picked from a "profile"
section he wants added to Cascade's Home page. Applies to both the live app view and
video export. Everything else (hand models/motion, fingering, colors, UI controls,
transcription) stays exactly as it is.

## Not doing
- Not removing or changing the current flat/landscape view — it stays the default and
  stays available.
- Not touching fingering, hand motion/anatomy, transcription, or cleanup logic.
- Not pushing to production — local preview only.

## Reference
`/home/roni/agent/bridge/run/videos/jatbot--5304832701_0-1792165986876-e43f15e440da4060a02126d8ec13672a.mp4`
(+ `-frames/frame-01.jpg` .. `frame-06.jpg`, look at them).

## Done when
1. `npm run build` succeeds, no new TS errors.
2. A new "profile" section exists on the Home page (`src/components/Home.tsx`) with a
   view-style picker: at minimum "Classic" (today's flat view) and "Perspective"
   (the new vanishing-point/portrait style). Selection persists (store + localStorage,
   same pattern as other settings) and applies on next open, not just this session.
3. In Perspective mode, the LIVE app shows: note lanes converging toward a vanishing
   point above the keyboard instead of falling straight down, portrait-friendly aspect,
   a reflection under the keyboard — while key-press timing, hit-testing (tap-to-play,
   `keyAtPoint`), hand placement/rendering, and lit-key colors all still work correctly
   (no regression — verify by actually tapping/playing notes in this mode, not just
   looking at it).
4. Video Export (`ExportDialog`) offers the same Perspective option and produces an MP4
   in that style through the REAL export path (`frameRenderer.ts`), not a separate
   one-off renderer — see the "shared math" note below, this is the exact kind of split
   that caused the 2026-10-12 phase-9 export/live divergence bug.
5. `node scripts/check-hand-ik.mjs` and `node scripts/check-hands-export.mjs` still pass
   in Classic mode (unchanged) — if they can run against Perspective mode too, run them
   there as well and note the result either way.
6. Fresh no-context reviewer: given ONLY the reference frames + a description of what he
   asked for, plus 6 frames from a real export in Perspective mode, confirms it reads as
   the same style (vanishing-point lanes, portrait, reflection) — not a rough
   approximation.
7. Switching between Classic and Perspective, and reloading the app, doesn't lose the
   current song, playback position expectations, or break MIDI/play-along modes.
8. Screenshot/clip from the real local preview (localhost:5191), both modes, before
   calling it done.

## Technical note (read before coding)
The live view (`src/render/Renderer.ts`) and the export view (`src/export/frameRenderer.ts`)
are two separate renderers today — VERIFY.md and FEEDBACK.md both record a past bug
(2026-10-12 phase 9) caused by exactly this kind of split: a check passed against one
model while the real export rendered differently. Put the perspective projection math
(lane paths, keyboard transform, vanishing point, reflection) in ONE shared module both
renderers call, not duplicated logic, so they can't drift apart the same way again.

## Tries
6 (larger/riskier than a typical task — a core coordinate-system change touching
hit-testing, hand placement and export)

## Open questions
Answered already:
- Applies to: live app AND export (his answer).
- Replace vs. add: add as a selectable style, chosen from a new profile section on Home
  (his answer) — not a replacement of the current view.
