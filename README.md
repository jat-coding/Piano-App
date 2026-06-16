# Cascade — Falling-Notes Piano Visualizer

Converts MIDI (Phase 1), and later audio/video, into a falling-note visualization
with a rustic **"concert grand at dusk"** look — warm ebony, ivory & ebony keys,
candlelit brass, burgundy felt. Right hand = **honey amber**, left hand = **dusty teal-blue**
(Fraunces + Spectral typography). The palette lives in `:root` (`src/index.css`) and the
`COLORS` object (`src/render/Renderer.ts`) — keep them in sync.

## Status — Phase 3 (polish & practice) ✅ + Phase 4 (partial)

- **A–B practice loop** — set A/B at the playhead (buttons or markers on the scrub bar);
  the engine wraps the section seamlessly.
- **Note impact effects** — particle burst on the strike line when a note lands (toggleable),
  on its own wall clock so it never warps with seek/speed.
- **Settings panel** — glow, impact effects, fall-speed slider, wait-mode, MIDI input.
- **Song library** (IndexedDB) — every loaded MIDI/audio/video is saved (deduped by name)
  and re-openable from the start screen without re-transcribing. No external dependency.
- **PWA** — installable, `display: fullscreen`, offline after first load (Workbox precaches
  the app shell *and* the 3.4 MB transcription worker; piano samples are runtime-cached).
- **Phase 4 — MIDI keyboard "wait mode"** (Web MIDI): the song holds on each note/chord
  until you play the matching key(s), which glow green; your keyboard sounds through the
  sampled piano. YouTube ingest and sheet-music OMR remain **deferred** (server-side /
  genuinely hard — out of scope for a static client-only app), per the brief.

## Status — Phase 2 (audio & video input) ✅

- **Audio → MIDI** (`.mp3/.wav/.m4a/.ogg`) via **Spotify Basic Pitch** + TensorFlow.js,
  running 100% in the browser in a **Web Worker** (UI never freezes), with a progress
  overlay. Nothing is uploaded.
- **Video → audio** (`.mp4/.mov/.webm`): decoded via Web Audio `decodeAudioData`; if the
  browser rejects the container (iPhone `.mov`/HEVC), it falls back to **ffmpeg.wasm**
  (lazy-loaded from CDN, video stream stripped) → same pipeline. All audio is resampled
  to mono 22050 Hz for the model.
- **Cleanup panel** (for transcribed songs): confidence (onset threshold) and min-note-length
  sliders **re-derive notes from the cached model output without re-running inference**;
  quantize (1/8, 1/16 at an adjustable BPM) and a **hand-split point slider** (with Auto
  heuristic) rebuild locally.

## Status — Phase 1 (MIDI player MVP) ✅

- Upload `.mid` / `.midi` → parsed with `@tonejs/midi` into a normalized `NoteEvent[]`.
- Canvas 2D falling-note renderer + 88-key keyboard, retina-aware, time-driven
  (every note's position is a pure function of `startTime − currentTime`, so
  scrub / seek / speed are free and always in sync).
- Hand colors from MIDI tracks (higher-average-pitch track = right hand);
  single-track input falls back to a heuristic splitter.
- Playback via a shared "song clock" driving a Tone.js Salamander piano sampler —
  speed changes scale the clock with **no pitch shift**.
- Video-player controls (auto-hiding): play/pause, ±5s skip, scrub bar with
  note-density minimap, 0.25×–2× speed with presets, left/right hand mute/solo,
  glow toggle.
- Responsive; on phones, playback requests fullscreen + landscape lock, with a
  "rotate your phone" overlay fallback (iOS Safari).
- Keyboard shortcuts: **Space** play/pause, **←/→** seek ±5s, **↑/↓** speed.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build
```

Drop the included `public/demo.mid` (a two-hand C-major demo) onto the start
screen to try it. Regenerate it with `node scripts/make-sample.mjs`.

## Architecture

Everything converts to a normalized `NoteEvent[]` first; the renderer never
knows what the original input was.

```
[MIDI file] → @tonejs/midi → NoteEvent[] → Hand Splitter → Renderer + PlaybackEngine
```

| File | Role |
|------|------|
| `src/types.ts` | `NoteEvent` / `Song` normalized format |
| `src/lib/midi.ts` | MIDI → `NoteEvent[]`, track-based hand assignment |
| `src/lib/handSplit.ts` | Heuristic + fixed-pitch hand splitter |
| `src/render/keyboard.ts` | 88-key geometry |
| `src/render/Renderer.ts` | Time-driven canvas renderer (notes + keyboard) |
| `src/audio/playback.ts` | Shared song-clock + Tone.js sampler |
| `src/components/Player.tsx` | Orchestrator: rAF loop, resize, fullscreen, input |
| `src/lib/audio.ts` | Decode + resample any file to mono 22050 Hz |
| `src/lib/ffmpeg.ts` | Lazy ffmpeg.wasm audio demux (iPhone .mov fallback) |
| `src/lib/transcribe.worker.ts` | Basic Pitch inference + note derivation (Web Worker) |
| `src/lib/transcribe.ts` | Main-thread worker manager (transcribe / re-derive) |
| `src/lib/cleanup.ts` | Raw notes → Song: quantize + hand split |
| `src/lib/pipeline.ts` | Orchestrates decode → worker → cleanup → store |

| `src/audio/playback.ts` | + A–B loop wrap & practice/wait-mode gating |
| `src/render/Renderer.ts` | + impact particles & wait-mode key highlight |
| `src/lib/library.ts` | IndexedDB song library |
| `src/lib/midiInput.ts` | Web MIDI input for wait mode |
| `src/components/Settings.tsx` · `Library.tsx` | Settings modal · library list |

The Basic Pitch model is copied into `public/basic-pitch-model/` by
`scripts/copy-model.mjs` (also wired as `postinstall`). PWA icons are generated by
`scripts/make-icons.mjs` (dependency-free PNG encoder).

## Deferred (Phase 4 stretch)

YouTube URL ingest (needs a server-side download — legal gray area) and sheet-music OMR
(genuinely hard) are intentionally left out of this client-only app.
