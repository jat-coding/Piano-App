# FEEDBACK.md — Cascade (Piano-App-hands)

One entry per send-back: what he asked for, what came back wrong, and the check that now
catches it for every future task on this project.

## 2026-10-14 — Transcription picks up ambient noise as notes

Task card: none yet filed for this (reported directly after the hand-motion task, same
day). What was wrong: after watching the Transkun-engine output, he noticed the
transcription is picking up ambient/room noise and turning it into random played notes —
not a one-song glitch, a backend accuracy gap. His words: "Nothing should be patched for
just the current song" — this is a correctness bug in the transcription pipeline, not a
per-song tweak.

Check to add to VERIFY.md for every future transcription-pipeline task: feed a
silence/ambient-noise-only segment (no real playing) through the pipeline and confirm it
produces zero (or near-zero, below some explicit small threshold) notes. Also re-run the
existing accuracy suite (MAESTRO onset F1, his reel vs reference) to confirm the noise fix
doesn't cost real-note recall. Added to VERIFY.md below.
