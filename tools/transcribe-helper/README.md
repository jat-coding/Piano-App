# Desktop transcription helper (Transkun)

`server.py` runs the Transkun piano-transcription model on the desktop GPU and answers
`POST /api/transcribe` (a mono 16-bit 44.1 kHz WAV) with the same `RawNote[]` the in-browser
Basic Pitch worker returns, plus `engine`, `device` (`cuda`/`cpu`) and sustain-pedal spans.
It binds 127.0.0.1:5192 only. The app reaches it through the :5191 preview server's same-origin
proxy (`vite.config.ts` `preview.proxy`). If that call fails in any way (404 on a host with no
proxy, 502 while the helper is down, non-JSON, network error, timeout), the app falls back to
Basic Pitch and labels the song "On-device".

- Python: reuses `~/agent/projects/amt-eval/venv` (torch cu126 + transkun 2.0).
- Runs as system units: `~/agent/bridge/deploy/cascade-transcribe.service` (this helper) and
  `cascade-preview.service` (:5191). Logs are in `~/agent/bridge/logs/cascade-*.log`.
- After `npm run build`, run `sudo systemctl restart cascade-preview`.
- Gates and checks: `~/agent/projects/amt-eval/tx-app-desktop.mjs` (accuracy through the app) and
  `check-desktop-engine.mjs` (sliders, fallback replies, Cancel). Results are in
  `~/agent/artifacts/piano-app/transcription-swap-report.md`.
