# Wire up sustain pedal (cc64) from imported MIDI files

## Goal
Follow-on to today's sustain-pedal playback work (commit `f14ea44`, task card
`2026-10-16-sustain-pedal-playback.md`): that build wired pedal spans from the desktop
(Transkun) transcription engine into real audio sustain, and asked "MIDI files can carry
pedal data too (cc64). Cascade still ignores it there. Want me to wire that up as well?"
He said yes. Do that now: parse sustain-pedal (CC 64) events out of imported MIDI files
and feed them into the same `Song.pedals` / playback-sustain system already built.

## Not doing
- Not touching the desktop/on-device transcription pedal paths — those already work.
- Not inventing pedal detection for audio-only (non-MIDI, on-device) imports — this task
  is specifically MIDI files, which carry real CC64 events, not a heuristic.
- Not pushing to production — local preview only.

## Done when
1. `npm run build` succeeds, no new TS errors.
2. `src/lib/midi.ts`'s `parseMidi()` reads CC64 (sustain) control-change events from the
   MIDI file (check all tracks, not just the note tracks — pedal data is sometimes on
   its own track) and converts on/off transitions into pedal spans using the SAME shape
   already defined for this (`PedalSpan` in `src/types.ts` from commit `f14ea44` — read
   it, match it exactly, don't invent a second shape).
3. The resulting `Song.pedals` flows through the same playback path already built
   (`src/audio/sustain.ts` / `src/audio/playback.ts`) with NO changes needed there if the
   shape matches — if changes ARE needed, that means the shape didn't match; fix the
   MIDI side to match the existing contract rather than branching playback logic per
   source.
4. A real MIDI file with sustain-pedal CC64 data, imported through the actual in-app
   import flow, produces a song whose playback audibly/measurably sustains notes under
   the pedal the same way the desktop-engine songs now do (reuse/extend
   `scripts/check-sustain.mjs` from the prior task against a MIDI fixture).
5. A MIDI file with NO CC64 data plays exactly as before (no regression) — same for any
   saved library song imported before this change.
6. No regression in existing MIDI parsing (hand-track assignment, note clamping,
   duration) — `check-fingering.mjs`, `check-hand-ik.mjs`, and any check that exercises
   MIDI import still pass.
7. Saved/reloaded from the library the same way the desktop-engine pedal data already
   was (confirm it survives a reload, not just the current session).

## Tries
4 (smaller than the original task — the hard part, the playback sustain system, is
already built; this is adding one more data source into it)

## Open questions
None — he answered "Wire it up" to the exact open question the prior task asked.
