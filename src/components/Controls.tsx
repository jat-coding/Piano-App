import { useStore } from '../store';
import {
  PlayIcon,
  PauseIcon,
  Rewind5Icon,
  Forward5Icon,
  CloseIcon,
  PianoIcon,
  SettingsIcon,
} from './icons';

interface Props {
  onPlayPause: () => void;
  onSkip: (delta: number) => void;
  onRate: (r: number) => void;
  onSetLoopA: () => void;
  onSetLoopB: () => void;
}

const SPEED_PRESETS = [0.5, 0.75, 1, 1.5];

export function Controls({ onPlayPause, onSkip, onRate, onSetLoopA, onSetLoopB }: Props) {
  const isPlaying = useStore((s) => s.isPlaying);
  const rate = useStore((s) => s.rate);
  const showLeft = useStore((s) => s.showLeft);
  const showRight = useStore((s) => s.showRight);
  const toggleHand = useStore((s) => s.toggleHand);
  const loopA = useStore((s) => s.loopA);
  const loopB = useStore((s) => s.loopB);
  const clearLoop = useStore((s) => s.clearLoop);
  const practiceMode = useStore((s) => s.practiceMode);
  const setPracticeMode = useStore((s) => s.setPracticeMode);
  const setShowSettings = useStore((s) => s.setShowSettings);

  const nextMode = { off: 'listen', listen: 'wait', wait: 'off' } as const;
  const modeLabel = { off: '', listen: 'Listen', wait: 'Wait' } as const;

  const hasLoop = loopA != null || loopB != null;

  return (
    <div className="controls">
      <div className="controls-left">
        <button className="ctrl-btn" onClick={() => onSkip(-5)} title="Back 5s" aria-label="Back 5 seconds">
          <Rewind5Icon />
        </button>
        <button
          className="ctrl-btn play"
          onClick={onPlayPause}
          title="Play / Pause (Space)"
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
        </button>
        <button className="ctrl-btn" onClick={() => onSkip(5)} title="Forward 5s" aria-label="Forward 5 seconds">
          <Forward5Icon />
        </button>
      </div>

      <div className="controls-center">
        <span className="speed-label">{rate.toFixed(2)}×</span>
        <input
          className="speed-slider"
          type="range"
          min={0.25}
          max={2}
          step={0.05}
          value={rate}
          onChange={(e) => onRate(parseFloat(e.target.value))}
        />
        <div className="presets">
          {SPEED_PRESETS.map((p) => (
            <button
              key={p}
              className={`preset${Math.abs(rate - p) < 0.001 ? ' active' : ''}`}
              onClick={() => onRate(p)}
            >
              {p}×
            </button>
          ))}
        </div>
      </div>

      <div className="controls-right">
        {/* A–B loop */}
        <div className="loop-group" title="A–B practice loop">
          <button className={`loop-btn${loopA != null ? ' set' : ''}`} onClick={onSetLoopA}>
            A
          </button>
          <button className={`loop-btn${loopB != null ? ' set' : ''}`} onClick={onSetLoopB}>
            B
          </button>
          {hasLoop && (
            <button className="loop-btn clear" onClick={clearLoop} title="Clear loop" aria-label="Clear A–B loop">
              <CloseIcon size={14} />
            </button>
          )}
        </div>

        <button
          className={`hand-btn left${showLeft ? ' on' : ''}`}
          onClick={() => toggleHand('left')}
          title="Left hand"
          aria-label="Toggle left hand"
          aria-pressed={showLeft}
        >
          L
        </button>
        <button
          className={`hand-btn right${showRight ? ' on' : ''}`}
          onClick={() => toggleHand('right')}
          title="Right hand"
          aria-label="Toggle right hand"
          aria-pressed={showRight}
        >
          R
        </button>

        <button
          className={`ctrl-btn mode${practiceMode !== 'off' ? ' on' : ''}`}
          onClick={() => setPracticeMode(nextMode[practiceMode])}
          title="MIDI practice: Off → Listen → Wait"
          aria-label={`MIDI practice mode: ${practiceMode}`}
        >
          <PianoIcon size={18} />
          {modeLabel[practiceMode] && <span className="mode-label">{modeLabel[practiceMode]}</span>}
        </button>
        <button
          className="ctrl-btn small"
          onClick={() => setShowSettings(true)}
          title="Settings"
          aria-label="Settings"
        >
          <SettingsIcon size={18} />
        </button>
      </div>
    </div>
  );
}
