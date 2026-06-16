import { useStore } from '../store';
import { updateBuild, updateCleanup } from '../lib/pipeline';
import { MIN_MIDI, MAX_MIDI } from '../types';
import type { Quantize } from '../lib/cleanup';
import { SlidersIcon, CloseIcon } from './icons';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiName(m: number): string {
  return `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
}

/** Tuning panel shown for transcribed (audio/video) songs. */
export function CleanupPanel() {
  const rawNotes = useStore((s) => s.rawNotes);
  const show = useStore((s) => s.showCleanup);
  const setShow = useStore((s) => s.setShowCleanup);
  const build = useStore((s) => s.build);
  const cleanup = useStore((s) => s.cleanup);
  const transcribing = useStore((s) => s.transcribing);
  const noteCount = useStore((s) => s.song?.notes.length ?? 0);

  if (!rawNotes) return null;

  if (!show) {
    return (
      <button className="cleanup-toggle" onClick={() => setShow(true)} title="Cleanup & hands">
        <SlidersIcon size={16} /> Tune
      </button>
    );
  }

  const splitMidi = build.splitMidi ?? 60;

  return (
    <div className="cleanup-panel">
      <div className="cleanup-head">
        <span>Cleanup &amp; hands</span>
        <div className="cleanup-head-right">
          {transcribing && <span className="updating">updating…</span>}
          <span className="note-count">{noteCount} notes</span>
          <button className="x" onClick={() => setShow(false)} aria-label="Close cleanup panel">
            <CloseIcon size={18} />
          </button>
        </div>
      </div>

      {/* Hand split */}
      <label className="field">
        <span>
          Hand split:{' '}
          <b>{build.splitMidi == null ? 'Auto' : midiName(build.splitMidi)}</b>
        </span>
        <div className="row">
          <input
            type="range"
            min={MIN_MIDI}
            max={MAX_MIDI}
            value={splitMidi}
            onChange={(e) => updateBuild({ splitMidi: parseInt(e.target.value, 10) })}
          />
          <button
            className={`mini${build.splitMidi == null ? ' active' : ''}`}
            onClick={() => updateBuild({ splitMidi: null })}
          >
            Auto
          </button>
        </div>
      </label>

      {/* Confidence (onset threshold) */}
      <label className="field">
        <span>
          Confidence: <b>{cleanup.onsetThresh.toFixed(2)}</b>
        </span>
        <input
          type="range"
          min={0.05}
          max={0.9}
          step={0.05}
          value={cleanup.onsetThresh}
          onChange={(e) => updateCleanup({ onsetThresh: parseFloat(e.target.value) })}
        />
      </label>

      {/* Min note length */}
      <label className="field">
        <span>
          Min note length: <b>{cleanup.minNoteLenMs} ms</b>
        </span>
        <input
          type="range"
          min={20}
          max={300}
          step={10}
          value={cleanup.minNoteLenMs}
          onChange={(e) => updateCleanup({ minNoteLenMs: parseInt(e.target.value, 10) })}
        />
      </label>

      {/* Quantize */}
      <label className="field">
        <span>Quantize</span>
        <div className="row">
          {(['off', '1/8', '1/16'] as Quantize[]).map((q) => (
            <button
              key={q}
              className={`mini${build.quantize === q ? ' active' : ''}`}
              onClick={() => updateBuild({ quantize: q })}
            >
              {q}
            </button>
          ))}
          {build.quantize !== 'off' && (
            <span className="bpm">
              <input
                type="number"
                min={40}
                max={240}
                value={build.bpm}
                onChange={(e) =>
                  updateBuild({ bpm: Math.max(40, Math.min(240, parseInt(e.target.value, 10) || 120)) })
                }
              />{' '}
              BPM
            </span>
          )}
        </div>
      </label>
    </div>
  );
}
