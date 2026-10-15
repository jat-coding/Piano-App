# Export with original video, stacked (2026-10-14)

## Goal
Let the user choose, at export time, to include the original source recording stacked
top/bottom with Cascade's own rendering (original video on top, Cascade's falling-notes +
hands render on bottom) — the same layout he built by hand to compare the two. Only
applies to songs imported from video (`song.kind === 'video'`); audio/MIDI imports have no
original video to show.

## Done when
- [x] Export dialog (`src/components/ExportDialog.tsx`) shows a toggle/checkbox to include
      the original video, visible only when the current song's `kind === 'video'` and its
      original media is available (`src/lib/library.ts` MEDIA store).
- [x] Toggle off (default) exports exactly what it does today — no regression on the
      existing plain export path.
- [x] Toggle on produces a single output video: original recording on top, Cascade's
      hands/falling-notes render on bottom, both halves time-synced to the same audio
      (reuse the existing export audio, don't duplicate/desync it).
- [x] Output resolution/aspect handled sanely for both portrait (phone) and whatever
      aspect the original recording is — doesn't squash or crop either half unreadably.
- [x] Works through the real in-app Export button, not just a standalone script.
- [x] `check-hands-export.mjs`, `check-fingering.mjs`, `check-hand-ik.mjs` still pass (no
      regression to the existing export/hands path).
- [x] `npm run build` succeeds, no new TS errors.
- [x] A real exported sample (stacked mode, his reel or clip that has original video) is
      produced and delivered to him — same kind of comparison he made by hand.

## Not doing
- No side-by-side (left/right) or picture-in-picture layout — he picked stacked
  top/bottom specifically.
- Not re-touching the noise-gate or hand-motion work from earlier today (separate tasks).
- No push to origin / no deploy — preview only, same standing rule as always.

## Tries
5 build-and-check rounds before stopping to ask.

## Open questions
None — he picked the layout (stacked top/bottom) via the tap-question. Starting
immediately per task-loop's rule for a fully specific instruction.

## Result (round 1 of 5, 2026-10-14) - all pass

Finding first: the stacked "video on top" layout already existed (since the first export
build) and turned on AUTOMATICALLY for every video song with a kept original. This task
turned it into an opt-in switch, default off. So for video songs the default export is now
plain falling notes (was: stacked). Audio/MIDI songs are unchanged.

- Toggle: `ExportDialog.tsx`, switch "Include the original video (on top)", shown only when
  `plan.canStack` (media kind 'video' in the MEDIA store). PASS: reel (video) showed it,
  aria-checked=false by default; reel10-audio.wav (audio-only) showed no switch.
  Screenshot: artifacts/piano-app/stacked-export-dialog-toggle-on-2026-10-14.png.
- Toggle off: plan layout 'full'; reel export with switch untouched = full-frame falling
  notes (harness stack/reel-plain.mp4). Code path otherwise unchanged.
- Toggle on: reel 0:19.7-1:04.2 (his @FALLINGNOTEAPP reel, real Export button) ->
  1080x1920 h264+opus, 44.4 s, 34 MB. Sync: top band matched against the source reel at
  5/12/21/33/40 s; best match at the same constant one-frame offset every time (that is the
  checker's ffmpeg seek rounding up to the next source frame), i.e. no drift, within 33 ms.
  Audio cross-correlated vs the reel at trimStart: 0.0 ms lag. Audio is the same single
  sliced original track as before.
- Aspect: new `videoBandHeight()` in frameRenderer.ts. Portrait (his 406x720 reel) -> band
  is half the frame, cover-cropped top/bottom (same look as his hand-made comparison).
  Landscape 16:9 -> band 608 px tall, whole picture, no side crop (tested with a red-bordered
  1280x720 clip: border visible on all 4 sides), Cascade gets the extra height. Ultra-wide
  floors at 538 px and crops sides a little.
- In-app: all runs drove the production build on :5191 through Add a song -> trim ->
  transcribe -> Export video -> switch -> Make video (harness
  projects/Piano-App-harness/stack/export-stack.mjs).
- check-fingering ALL PASS, check-hand-ik all hard checks pass, check-hands-export PASS on
  reel (video layout), reel10-audio, 3-your-clip x3 (0 FAIL lines).
- npm run build clean.
- Sample: artifacts/piano-app/stacked-export-reel-2026-10-14.mp4 (+ landscape test
  stacked-export-landscape-test-2026-10-14.mp4).
