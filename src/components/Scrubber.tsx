import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../store';
import { formatTime } from '../lib/format';

interface Props {
  onSeek: (t: number) => void;
}

/**
 * Scrub bar with a note-density minimap. Subscribes to currentTime (60fps) but
 * is a tiny subtree, so the per-frame re-render is cheap.
 */
export function Scrubber({ onSeek }: Props) {
  const currentTime = useStore((s) => s.currentTime);
  const duration = useStore((s) => s.duration);
  const song = useStore((s) => s.song);
  const loopA = useStore((s) => s.loopA);
  const loopB = useStore((s) => s.loopB);
  const barRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // Density buckets for the minimap, recomputed only when the song changes.
  const density = useMemo(() => {
    if (!song || duration === 0) return [];
    const BUCKETS = 160;
    const buckets = new Array(BUCKETS).fill(0);
    for (const n of song.notes) {
      const i = Math.min(BUCKETS - 1, Math.floor((n.startTime / duration) * BUCKETS));
      buckets[i]++;
    }
    const max = Math.max(1, ...buckets);
    return buckets.map((b) => b / max);
  }, [song, duration]);

  const seekFromEvent = (clientX: number) => {
    const el = barRef.current;
    if (!el || duration === 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (draggingRef.current) seekFromEvent(e.clientX);
    };
    const up = () => {
      draggingRef.current = false;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="scrubber">
      <span className="time">{formatTime(currentTime)}</span>
      <div
        ref={barRef}
        className="scrub-track"
        onPointerDown={(e) => {
          draggingRef.current = true;
          seekFromEvent(e.clientX);
        }}
      >
        <div className="minimap">
          {density.map((d, i) => (
            <span key={i} style={{ height: `${Math.max(8, d * 100)}%` }} />
          ))}
        </div>
        {loopA != null && loopB != null && (
          <div
            className="loop-region"
            style={{
              left: `${(loopA / duration) * 100}%`,
              width: `${((loopB - loopA) / duration) * 100}%`,
            }}
          />
        )}
        {loopA != null && (
          <div className="loop-marker a" style={{ left: `${(loopA / duration) * 100}%` }}>
            A
          </div>
        )}
        {loopB != null && (
          <div className="loop-marker b" style={{ left: `${(loopB / duration) * 100}%` }}>
            B
          </div>
        )}
        <div className="scrub-fill" style={{ width: `${pct}%` }} />
        <div className="scrub-handle" style={{ left: `${pct}%` }} />
      </div>
      <span className="time">{formatTime(duration)}</span>
    </div>
  );
}
