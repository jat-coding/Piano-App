# Natural breathing + reach-ahead motion

## Goal
He sent a new falling-notes reference (@JENN1PIANO style) and said the hands currently
look too "robotic" — frozen between notes instead of breathing, and snapping onto each
note instead of reaching for it ahead of time like a real pianist anticipating the next
key. Make the idle/between-note motion read as natural human movement, and make the
reach-ahead toward the next note visibly early and smooth rather than a last-moment snap.

## Not doing
- No change to fingering assignment, hand-splitting, trills, or transcription.
- No change to which hand/finger plays which note — motion/timing polish only.
- Not pushing to production or touching the main `Piano-App` repo/branch.

## Done when
1. `npm run build` succeeds, no new TS errors.
2. `node scripts/check-hand-ik.mjs` and `node scripts/check-hands-export.mjs` both pass
   on all fixture songs (no new FAILs vs current baseline).
3. `node scripts/check-fingering.mjs` still passes (motion changes didn't alter
   assignment).
4. A real export through the in-app Export button, using his own reel
   (`projects/Piano-App-harness/3-your-clip.wav` or equivalent) and at least one other
   song, produces an MP4 where idle hands visibly drift/sway between notes (not frozen)
   and fingers visibly open/reach toward the next key before it's struck, not just at the
   moment of the press.
5. Fresh no-context reviewer: given ONLY his two messages ("make the hands move and
   breathe... robotic... reach and anticipate the next note" / "so they aren't so
   robotic") plus 6 frames pulled from the real export spanning a passage with idle time
   and a reach, answers "does this look natural, not robotic, and does it look like it's
   reaching ahead?" — yes on both, unprompted by the build's own explanation.
6. No regression: existing hand/export checks that passed before this change still pass
   (overlap, no-crossing, anatomy limits, missed-press).

## Tries
5

## Open questions
None — instruction is specific enough to start.

## Additional reference (added mid-build, 2026-10-16 9:36am)
A second reference video landed while the build was running (same genre, different
creator, @HANAISDAO_ instead of @JENN1PIANO — generic falling-notes overlay, hands mostly
rest flat/relaxed on the keyboard between active notes with only a couple fingers
reaching out to far-apart keys). Use it alongside the first reference as a second data
point for the fresh-reviewer visual check in "Done when" item 5, same question (natural/
not robotic, reaching ahead). File:
`/home/roni/agent/bridge/run/videos/jatbot--5304832701_0-1792164970907-b77bb0178488404e982aba1e714e4744.mp4`
(+ `-frames/frame-01.jpg` .. `frame-06.jpg`).

## Result (2026-10-16, tries used: 3 of 5)
Try 1: earlier finger reach + idle drift: fresh reviewer NO on natural (idle = finger flicker,
late lunge from a far rest spot). Try 2: calm early glide + whole-hand breath (rise/fall,
fingers open/close together): reach YES, natural NO (flat fingers, breath subtle). Try 3:
bigger breath, longer calm glide (an extra idle curl was tried and dropped: the rest-dome
anatomy gate allows ~3°): YES on both, with reservations (flat fingers, see-through/ghosted
drawing, tilted right hand at one landing). All checks pass; see artifacts/build-20261016-092328-818697.md.
