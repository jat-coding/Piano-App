# VERIFY.md — Cascade (Piano-App-hands)

How to check work on this project for real. Every task runs these; add to this file
whenever a send-back reveals a check that was missing (see FEEDBACK.md).

## Commands (run from projects/Piano-App-hands)

- `node scripts/check-fingering.mjs [song.json ...]` — fingering + pose unit checks on
  hand-written cases; exits 1 on any failure. Pass real song exports when available.
- `node scripts/check-hand-ik.mjs` — IK/joint-angle checks.
- `node scripts/check-hands-export.mjs` — checks the actual rendered export path (not a
  separate model of it — see the 2026-10-12 phase-9 lesson below).
- `node scripts/check-cleanup.mjs`, `check-parse.mjs`, `check-transcribe.mjs`,
  `check-trills.mjs` — run if the change touches that area.
- `npm run build` (tsc -b && vite build) must succeed with no new TS errors.
- No test runner wired beyond these targeted check-*.mjs scripts; there is no `npm test`
  suite yet (package.json's "test" is a stub). Don't claim broader coverage than these
  scripts actually give.

## Visual verification (required for any hand/animation change)

A passing check-*.mjs is NOT sufficient on its own for a hand-rendering bug. On
2026-10-12 (phase 9) a checker reported 0 overlap frames while the real exported video
showed the hands touching — it measured a different model (different geometry, ignored
trail copies, exempted "forced crossing" frames) than what the export path actually
renders. Every hand-motion/finger-curl change must also:

1. Export a real clip through the actual in-app export path (the same one the user hits),
   not just a synthetic harness clip.
2. Pull frames and look at them (or the exported .mp4 directly) — confirm fingers visibly
   curl/press on the keys they're supposed to, hands don't overlap/clip, motion timing
   looks natural frame-to-frame.
3. Use his own reel (`projects/Piano-App-harness/3-your-clip.wav` or equivalent) as one of
   the test inputs, not only synthetic/reference MIDI — bugs have shipped that only showed
   up on his real audio.
4. Compare against the reference video he's been using throughout
   (`artifacts/piano-app/...` — see memory/project/piano-app-repo.md for which file) for
   the specific dimension he flagged (dynamic movement, finger bend/curl naturalness).

## Missed-note-press check (new, 2026-10-14)

Specific to this task: every note in the transcribed output that should get a hand/finger
press must actually show one in the rendered export. Check by cross-referencing the
note list the transcription engine returns against which notes the hand animator actually
assigns a press to — any note with no assigned finger/press is a fail. Don't just lower
the visible bar for "a press"; find why the assignment was skipped (fingering.ts /
handPose assignment logic) and fix the root cause.

## Ambient-noise / false-note check (new, 2026-10-14)

He reported the transcription (Transkun helper) picks up ambient/room noise and turns it
into played notes that never happened — a backend accuracy gap, not a per-song patch
(FEEDBACK.md 2026-10-14). Every transcription-pipeline change must also:

1. Feed a silence/ambient-noise-only segment (no real playing — e.g. the lead-in room
   noise before playing starts in an existing real clip, or a synthesized quiet-noise
   clip) through the real pipeline and confirm it produces zero or near-zero notes.
2. Re-run the existing accuracy suite (`projects/amt-eval/` — MAESTRO onset F1, his reel
   vs the reference video) to confirm the fix didn't cost real-note recall.
3. Don't special-case the specific song/clip that surfaced this — the fix has to be in
   the shared noise/confidence gating, not a per-song exception.

## Preview

- Desktop: `http://localhost:5191/`
- Tailscale: `http://100.70.246.99:5191/`
- Served by systemd unit `cascade-preview.service`; after `npm run build`, run
  `sudo systemctl restart cascade-preview` to pick up dist/ changes.
- Transcription helper: `cascade-transcribe.service` (127.0.0.1:5192, desktop GPU).

## Standing rule

Nothing gets pushed to origin or deployed without his explicit go — pushing triggers a
Vercel preview build.
