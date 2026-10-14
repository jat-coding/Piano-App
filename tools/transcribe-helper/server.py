"""Cascade desktop transcription helper: Transkun (piano AMT) behind a tiny HTTP API.

POST /api/transcribe   body = mono 16-bit PCM WAV, 44.1 kHz (the model's own rate; other
                       rates are resampled with soxr, but every accuracy number we have is
                       at 44.1 kHz, so the app sends that)
   200 -> {"engine": "transkun", "device": "cuda"|"cpu", "seconds": float,
           "audioSeconds": float, "notes": RawNote[], "pedals": [...]}
   4xx/5xx -> {"error": "..."}; 499 when the client went away mid-job (cancelled)
GET  /api/transcribe/health -> {"ok": true, "engine": "transkun", "device": ..., "busy": bool}

RawNote = {startTimeSeconds, durationSeconds, pitchMidi, amplitude (= velocity/127)}: the
same contract the app's Basic Pitch worker returns, so cleanup/hands code doesn't change.
pedals = sustain-pedal spans Transkun also outputs; returned but not used by the app yet.

The model is loaded ONCE at startup and kept resident (not the CLI per call, which reloads
the checkpoint every time). One job at a time: a second request waits for the first.
If the client disconnects (the app's Cancel aborts the fetch, the vite proxy then drops
the upstream socket) the running job stops at the next ~segment boundary.

Binds 127.0.0.1 only; the phone reaches it through the :5191 preview server's same-origin
/api/transcribe proxy (vite.config.ts), never directly.
"""
import io, json, os, select, socket, sys, threading, time, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch

HOST = os.environ.get('TRANSCRIBE_HOST', '127.0.0.1')
PORT = int(os.environ.get('TRANSCRIBE_PORT', '5192'))
MAX_BYTES = 200 * 1024 * 1024  # ~38 min of 44.1k mono 16-bit


def log(*a):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), *a, flush=True)


def load_model():
    import moduleconf
    from importlib.resources import files
    pre = files('transkun') / 'pretrained'
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    conf_mgr = moduleconf.parseFromFile(str(pre / '2.0.conf'))
    TransKun = conf_mgr['Model'].module.TransKun
    ckpt = torch.load(str(pre / '2.0.pt'), map_location=device)
    model = TransKun(conf=conf_mgr['Model'].config).to(device)
    model.load_state_dict(ckpt['best_state_dict'] if 'best_state_dict' in ckpt else ckpt['state_dict'], strict=False)
    model.eval()
    return model, device


torch.set_grad_enabled(False)
t0 = time.time()
MODEL, DEVICE = load_model()
log(f'transkun loaded on {DEVICE} in {time.time() - t0:.1f}s (fs={MODEL.fs})',
    torch.cuda.get_device_name(0) if DEVICE == 'cuda' else '')

JOB_LOCK = threading.Lock()
_cancel = threading.local()


class Cancelled(Exception):
    pass


# Check for cancellation between the model's segments (transcribe() loops over ~16 s windows).
_orig_frames = MODEL.transcribeFrames


def _checked_frames(*a, **k):
    ev = getattr(_cancel, 'event', None)
    if ev is not None and ev.is_set():
        raise Cancelled()
    return _orig_frames(*a, **k)


MODEL.transcribeFrames = _checked_frames

# Warm up once at startup: the first real call otherwise pays CUDA/cuDNN kernel setup
# (measured 148 s for the first 30 s clip under heavy disk load vs 2-3 s warm).
t0 = time.time()
MODEL.transcribe(torch.from_numpy(np.random.default_rng(0).normal(0, 0.01, (MODEL.fs * 4, 1)).astype(np.float32)).to(DEVICE))
log(f'warm-up done in {time.time() - t0:.1f}s')


def read_wav(buf: bytes):
    with wave.open(io.BytesIO(buf)) as w:
        fs, ch, sw, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    if sw == 2:
        y = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 2 ** 15
    elif sw == 4:
        y = np.frombuffer(raw, dtype='<i4').astype(np.float32) / 2 ** 31
    else:
        raise ValueError(f'unsupported sample width {sw}')
    y = y.reshape(-1, ch).mean(axis=1, keepdims=True)  # (frames, 1), like transkun's own reader
    return fs, y


def transcribe(audio_fs, y, cancel_event):
    if audio_fs != MODEL.fs:
        import soxr
        y = soxr.resample(y, audio_fs, MODEL.fs).astype(np.float32).reshape(-1, 1)
    x = torch.from_numpy(np.ascontiguousarray(y)).to(DEVICE)
    _cancel.event = cancel_event
    try:
        events = MODEL.transcribe(x, discardSecondHalf=False)
    finally:
        _cancel.event = None
        if DEVICE == 'cuda':
            torch.cuda.empty_cache()
    notes, pedals = [], []
    for e in events:
        if e.pitch > 0:
            notes.append({'startTimeSeconds': float(e.start), 'durationSeconds': float(max(e.end - e.start, 0.0)),
                          'pitchMidi': int(e.pitch), 'amplitude': float(e.velocity) / 127.0})
        else:
            pedals.append({'cc': int(-e.pitch), 'startTimeSeconds': float(e.start), 'endTimeSeconds': float(e.end)})
    notes.sort(key=lambda n: (n['startTimeSeconds'], n['pitchMidi']))
    return notes, pedals


def watch_disconnect(sock, done, cancel_event):
    """Set cancel_event if the peer closes the connection before the job finishes."""
    while not done.is_set():
        try:
            r, _, _ = select.select([sock], [], [], 0.5)
            if r and not sock.recv(1, socket.MSG_PEEK):
                cancel_event.set()
                return
        except (OSError, ValueError):
            cancel_event.set()
            return


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *a):
        log('http', self.address_string(), fmt % a)

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        try:
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path.rstrip('/') in ('/api/transcribe/health', '/health'):
            return self._json(200, {'ok': True, 'engine': 'transkun', 'device': DEVICE, 'busy': JOB_LOCK.locked()})
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path.split('?')[0].rstrip('/') not in ('/api/transcribe', '/transcribe'):
            return self._json(404, {'error': 'not found'})
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BYTES:
            return self._json(413 if n > MAX_BYTES else 400, {'error': f'bad body length {n}'})
        buf = self.rfile.read(n)
        try:
            fs, y = read_wav(buf)
        except Exception as e:  # noqa: BLE001
            return self._json(400, {'error': f'expected a PCM WAV body: {e}'})
        cancel_event, done = threading.Event(), threading.Event()
        threading.Thread(target=watch_disconnect, args=(self.connection, done, cancel_event), daemon=True).start()
        try:
            with JOB_LOCK:
                if cancel_event.is_set():
                    log('client left while queued; skipped')
                    return self._json(499, {'error': 'cancelled'})
                t = time.time()
                notes, pedals = transcribe(fs, y, cancel_event)
                dt = time.time() - t
        except Cancelled:
            log(f'cancelled by client after {time.time() - t:.1f}s ({len(y) / fs:.1f}s audio)')
            return self._json(499, {'error': 'cancelled'})
        except Exception as e:  # noqa: BLE001
            log('transcribe failed:', repr(e))
            return self._json(500, {'error': str(e)})
        finally:
            done.set()
        log(f'{len(y) / fs:.1f}s audio @ {fs} Hz -> {len(notes)} notes, {len(pedals)} pedal spans, {dt:.1f}s on {DEVICE}')
        self._json(200, {'engine': 'transkun', 'device': DEVICE, 'seconds': round(dt, 3),
                         'audioSeconds': round(len(y) / fs, 3), 'notes': notes, 'pedals': pedals})


if __name__ == '__main__':
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    log(f'listening on http://{HOST}:{PORT}')
    srv.serve_forever()
