# Consolidate Settings + Cleanup into one top-right dropdown

## Goal
He wants the display to be just the falling notes, hands and keyboard while tuning a
transcription, so he "can see everything" — not a floating Tune button top-left plus a
full-screen Settings modal that blocks the canvas. Move both into one dropdown button in
the top-right corner, closed by default, that reveals the same controls without covering
the canvas.

## Not doing
- Not touching the bottom transport bar (play/pause, scrub, A/B loop, L/R hand toggle,
  export, play-along) — it already auto-hides during playback (`ui-hidden` class) and
  reappears on tap/move; this request is about the two settings surfaces, not transport.
- Not changing any cleanup/transcription logic (onset threshold, min-length, quantize,
  hand split) — only where their controls live on screen.
- Not pushing to production — local preview only.

## Done when
1. `npm run build` succeeds, no new TS errors.
2. A single button in the top-right corner (safe-area aware, matches existing button
   style) opens/closes one dropdown/panel containing: the current Settings.tsx controls
   (strike glow, impact effects, show hands, fall speed, MIDI practice mode/device) AND
   the current CleanupPanel.tsx controls (hand split, confidence, min note length,
   quantize) — grouped or sectioned, not visually merged into one confusing list.
3. The old top-left floating "Tune" button and the bottom-bar gear/Settings icon are
   gone — the new top-right button is the only entry point.
4. With the dropdown closed, on a real transcribed song (desktop or Basic Pitch engine),
   the falling notes, hands and keyboard are the only things on screen besides the
   bottom transport bar (which still auto-hides during playback as before).
5. Opening the dropdown does not fully obscure the canvas the way the old Settings modal
   backdrop did — he can still see the falling notes/keyboard behind or beside it while
   adjusting a slider (this is the actual complaint: the old Settings modal blocked
   everything).
6. All existing behavior still works through the new UI: toggling show-hands, changing
   fall speed, MIDI practice mode + device list, hand split/confidence/min-length/
   quantize sliders on a desktop-engine and a Basic-Pitch-engine song (desktop hides
   Confidence, shows Min-length as client-side — don't lose that branching).
7. No new console errors; test on both desktop width and a narrow (390px) width since
   Settings had a mobile breakpoint (`@media` around line 1527 of index.css) — check it
   still looks right.
8. Visual check: screenshot before/after (dropdown closed = clean canvas; dropdown open
   = controls visible without hiding the whole stage) in the real local preview
   (localhost:5191 / 100.70.246.99:5191), not just code review.

## Tries
5

## Open questions
None — scope is: merge Settings.tsx + CleanupPanel.tsx into one top-right dropdown,
leave transport bar untouched. Proceeding on that reading.
