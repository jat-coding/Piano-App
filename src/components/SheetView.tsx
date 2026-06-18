import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { ChevronLeftIcon } from './icons';

// pitch class → [diatonic letter index 0..6, isSharp]
const PC: [number, boolean][] = [
  [0, false], [0, true], [1, false], [1, true], [2, false], [3, false],
  [3, true], [4, false], [4, true], [5, false], [5, true], [6, false],
];
const diatonic = (midi: number) => (Math.floor(midi / 12) - 1) * 7 + PC[midi % 12][0];
const isSharp = (midi: number) => PC[midi % 12][1];

const PX_PER_SEC = 90;
const STEP = 5; // half a line-spacing per diatonic step

/**
 * Simplified "sheet music" — the transcribed notes laid on a grand staff by
 * pitch (vertical) and time (horizontal). Not full rhythmic notation, but a
 * readable at-a-glance score derived from the real notes. Scrolls horizontally.
 */
export function SheetView() {
  const song = useStore((s) => s.song);
  const setView = useStore((s) => s.setView);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !song) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssH = 360;
    const cssW = Math.max(640, Math.ceil(song.duration * PX_PER_SEC) + 120);
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#efe5cf';
    ctx.fillRect(0, 0, cssW, cssH);

    const centerY = cssH / 2;
    const dC4 = diatonic(60);
    const yFor = (midi: number) => centerY - (diatonic(midi) - dC4) * STEP;

    // Grand staff reference lines (treble + bass).
    ctx.strokeStyle = 'rgba(40,30,20,0.5)';
    ctx.lineWidth = 1;
    for (const m of [64, 67, 71, 74, 77, 43, 47, 50, 53, 57]) {
      const y = yFor(m);
      ctx.beginPath();
      ctx.moveTo(12, y);
      ctx.lineTo(cssW - 12, y);
      ctx.stroke();
    }
    // Bar guide lines every 2 seconds.
    ctx.strokeStyle = 'rgba(40,30,20,0.14)';
    for (let t = 0; t <= song.duration; t += 2) {
      const x = 60 + t * PX_PER_SEC;
      ctx.beginPath();
      ctx.moveTo(x, yFor(81));
      ctx.lineTo(x, yFor(40));
      ctx.stroke();
    }

    for (const n of song.notes) {
      const x = 60 + n.startTime * PX_PER_SEC;
      const y = yFor(n.midi);
      ctx.fillStyle = n.hand === 'left' ? '#3c5b64' : '#a06a28';
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-0.35);
      ctx.beginPath();
      ctx.ellipse(0, 0, 6, 4.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (isSharp(n.midi)) {
        ctx.fillStyle = 'rgba(30,20,12,0.8)';
        ctx.font = '11px serif';
        ctx.fillText('♯', x - 16, y + 4);
      }
    }
  }, [song]);

  if (!song) return null;

  return (
    <div className="sheet-view">
      <div className="sheet-bar">
        <button className="back-btn" onClick={() => setView('home')}>
          <ChevronLeftIcon size={16} /> Rack
        </button>
        <span className="sheet-name">{song.name}</span>
        <span className="sheet-hint">simplified score</span>
      </div>
      <div className="sheet-scroll">
        <canvas ref={canvasRef} className="sheet-canvas" />
      </div>
    </div>
  );
}
