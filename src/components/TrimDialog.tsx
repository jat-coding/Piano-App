import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { confirmTrim, cancelTrim } from '../lib/pipeline';
import { TARGET_SR } from '../lib/audio';
import { formatTime } from '../lib/format';
import { PlayIcon, PauseIcon } from './icons';

const BARS = 900;
const MIN_SELECTION = 0.5; // seconds

/**
 * Shown after a clip is decoded but before transcription: pick the region to
 * keep. Only the selection is transcribed and saved.
 */
export function TrimDialog() {
  const audio = useStore((s) => s.pendingAudio);
  const duration = useStore((s) => s.pendingDuration);
  const name = useStore((s) => s.pendingName);

  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [playing, setPlaying] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<'start' | 'end' | null>(null);

  // Preview audio (own context so it doesn't fight the Tone.js engine).
  const ctxRef = useRef<AudioContext | null>(null);
  const bufRef = useRef<AudioBuffer | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const rafRef = useRef(0);
  const playT0Ref = useRef(0);

  // Peaks for the waveform, computed once per clip.
  const peaks = useMemo(() => {
    if (!audio) return [] as number[];
    const block = Math.max(1, Math.floor(audio.length / BARS));
    const out = new Array(BARS).fill(0);
    let max = 0;
    for (let i = 0; i < BARS; i++) {
      let m = 0;
      const s = i * block;
      for (let j = 0; j < block; j++) {
        const v = Math.abs(audio[s + j] || 0);
        if (v > m) m = v;
      }
      out[i] = m;
      if (m > max) max = m;
    }
    const norm = max || 1;
    return out.map((v) => v / norm);
  }, [audio]);

  // Reset the selection to the whole clip when a new file arrives.
  useEffect(() => {
    setStart(0);
    setEnd(duration);
  }, [audio, duration]);

  const draw = (playheadSec: number | null) => {
    const canvas = canvasRef.current;
    if (!canvas || duration === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const mid = h / 2;
    const startX = (start / duration) * w;
    const endX = (end / duration) * w;
    const barW = Math.max(1, w / peaks.length - 0.5);

    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * w;
      const barH = Math.max(1, peaks[i] * h * 0.92);
      ctx.fillStyle = x >= startX && x <= endX ? '#c2a24a' : '#5a503e';
      ctx.fillRect(x, mid - barH / 2, barW, barH);
    }

    // Dim outside the selection.
    ctx.fillStyle = 'rgba(10,8,5,0.55)';
    ctx.fillRect(0, 0, startX, h);
    ctx.fillRect(endX, 0, w - endX, h);

    if (playheadSec != null) {
      const px = (playheadSec / duration) * w;
      ctx.strokeStyle = '#d8be78';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    }
  };

  // Redraw on selection change.
  useEffect(() => {
    draw(playing ? null : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, peaks]);

  useEffect(() => {
    const onResize = () => draw(null);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, peaks]);

  // ---- drag handles ----
  const secFromX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const t = secFromX(e.clientX);
      if (dragRef.current === 'start') setStart(Math.min(t, end - MIN_SELECTION));
      else setEnd(Math.max(t, start + MIN_SELECTION));
    };
    const up = () => (dragRef.current = null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, duration]);

  // ---- preview playback ----
  const stopPreview = () => {
    cancelAnimationFrame(rafRef.current);
    if (srcRef.current) {
      try {
        srcRef.current.onended = null;
        srcRef.current.stop();
      } catch {
        /* already stopped */
      }
      srcRef.current = null;
    }
    setPlaying(false);
    draw(null);
  };

  const playPreview = async () => {
    if (!audio) return;
    if (playing) {
      stopPreview();
      return;
    }
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    const ctx = ctxRef.current;
    await ctx.resume();
    if (!bufRef.current) {
      const buf = ctx.createBuffer(1, audio.length, TARGET_SR);
      buf.getChannelData(0).set(audio);
      bufRef.current = buf;
    }
    const src = ctx.createBufferSource();
    src.buffer = bufRef.current;
    src.connect(ctx.destination);
    src.start(0, start, Math.max(0.05, end - start));
    srcRef.current = src;
    playT0Ref.current = ctx.currentTime;
    setPlaying(true);
    src.onended = () => stopPreview();

    const tick = () => {
      const sec = start + (ctx.currentTime - playT0Ref.current);
      if (sec >= end) {
        stopPreview();
        return;
      }
      draw(sec);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      try {
        srcRef.current?.stop();
      } catch {
        /* noop */
      }
      ctxRef.current?.close();
    },
    [],
  );

  if (!audio) return null;

  const startPct = duration ? (start / duration) * 100 : 0;
  const endPct = duration ? (end / duration) * 100 : 100;
  const selLen = Math.max(0, end - start);

  const finish = (whole: boolean) => {
    stopPreview();
    confirmTrim(whole ? 0 : start, whole ? duration : end);
  };

  return (
    <div className="trim-overlay">
      <div className="trim-card">
        <h2>Trim “{name}”</h2>
        <p className="trim-sub">Drag the handles to pick the part to turn into a song.</p>

        <div className="waveform-wrap">
          <canvas ref={canvasRef} className="waveform" />
          <div className="wave-track" ref={trackRef}>
            <button
              className="trim-handle"
              style={{ left: `${startPct}%` }}
              onPointerDown={() => (dragRef.current = 'start')}
              aria-label="Selection start"
            />
            <button
              className="trim-handle"
              style={{ left: `${endPct}%` }}
              onPointerDown={() => (dragRef.current = 'end')}
              aria-label="Selection end"
            />
          </div>
        </div>

        <div className="trim-times">
          <span>{formatTime(start)}</span>
          <button className="preview-btn" onClick={playPreview} aria-label="Preview selection">
            {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
            <span>{formatTime(selLen)} selected</span>
          </button>
          <span>{formatTime(end)}</span>
        </div>

        <div className="trim-actions">
          <button className="ghost-btn" onClick={cancelTrim}>
            Cancel
          </button>
          <button className="ghost-btn" onClick={() => finish(true)}>
            Use whole clip
          </button>
          <button className="primary-btn" onClick={() => finish(false)}>
            Transcribe selection
          </button>
        </div>
      </div>
    </div>
  );
}
