import { useStore } from '../store';
import { cancelProcessing } from '../lib/pipeline';
import { MusicIcon } from './icons';

/** Full-screen progress while Basic Pitch runs (in a worker — UI never freezes). */
export function TranscribeOverlay() {
  const transcribing = useStore((s) => s.transcribing);
  const stage = useStore((s) => s.stage);
  const progress = useStore((s) => s.progress);
  const song = useStore((s) => s.song);

  // Only take over the whole screen for the initial transcription, not for the
  // lightweight re-derive that happens when tuning cleanup sliders.
  if (!transcribing || song) return null;

  const determinate = progress >= 0;
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);

  return (
    <div className="transcribe-overlay">
      <div className="logo brass-mark">
        <MusicIcon size={44} />
      </div>
      <h2>{stage || 'Working…'}</h2>
      <div className={`progress-bar${determinate ? '' : ' indeterminate'}`}>
        <div className="progress-fill" style={determinate ? { width: `${pct}%` } : undefined} />
      </div>
      <p className="progress-num">{determinate ? `${pct}%` : 'Loading model…'}</p>
      <p className="disclaimer">
        Audio → MIDI is an estimate (best on clean solo piano). You can clean it up after.
      </p>
      <button className="ghost-btn cancel-btn" onClick={cancelProcessing}>
        Cancel
      </button>
    </div>
  );
}
