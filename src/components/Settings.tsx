import { useEffect, useRef } from 'react';
import { useStore, type PracticeMode } from '../store';
import { midiSupported } from '../lib/midiInput';
import { CleanupSection } from './CleanupSection';
import { formatTime } from '../lib/format';
import { CloseIcon, ExportVideoIcon, MicIcon, SettingsIcon } from './icons';

const MODES: { value: PracticeMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Song plays normally.' },
  { value: 'listen', label: 'Listen', hint: 'Song plays through — play along on your keyboard.' },
  { value: 'wait', label: 'Wait', hint: 'Song holds on each note until you play it.' },
];

const SPEED_PRESETS = [0.5, 0.75, 1, 1.5];

interface Props {
  onToggleMidi: (enabled: boolean) => void;
  onRate: (r: number) => void;
  onSetLoopA: () => void;
  onSetLoopB: () => void;
  onExport: () => void;
  onPlayAlong: () => void;
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <button className={`switch${value ? ' on' : ''}`} onClick={() => onChange(!value)}>
        <span className="knob" />
      </button>
    </label>
  );
}

export function Settings({ onToggleMidi, onRate, onSetLoopA, onSetLoopB, onExport, onPlayAlong }: Props) {
  const show = useStore((s) => s.showSettings);
  const setShow = useStore((s) => s.setShowSettings);
  const glow = useStore((s) => s.glow);
  const setGlow = useStore((s) => s.setGlow);
  const impacts = useStore((s) => s.impacts);
  const setImpacts = useStore((s) => s.setImpacts);
  const showHands = useStore((s) => s.showHands);
  const setShowHands = useStore((s) => s.setShowHands);
  const fallSpeed = useStore((s) => s.fallSpeed);
  const setFallSpeed = useStore((s) => s.setFallSpeed);
  const practiceMode = useStore((s) => s.practiceMode);
  const setPracticeMode = useStore((s) => s.setPracticeMode);
  const midiEnabled = useStore((s) => s.midiEnabled);
  const midiDevices = useStore((s) => s.midiDevices);
  const rate = useStore((s) => s.rate);
  const showLeft = useStore((s) => s.showLeft);
  const showRight = useStore((s) => s.showRight);
  const toggleHand = useStore((s) => s.toggleHand);
  const loopA = useStore((s) => s.loopA);
  const loopB = useStore((s) => s.loopB);
  const clearLoop = useStore((s) => s.clearLoop);

  const panelRef = useRef<HTMLDivElement>(null);

  // Non-modal dropdown: the stage stays live behind it, so no backdrop or focus trap.
  // Focus moves in on open, Escape closes, focus returns to where it was.
  useEffect(() => {
    if (!show) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>('button, [href], input, select')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setShow(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
    };
  }, [show, setShow]);

  return (
    <>
      <button
        className={`settings-btn${show ? ' open' : ''}`}
        onClick={() => setShow(!show)}
        title="Settings"
        aria-label="Settings"
        aria-expanded={show}
      >
        <SettingsIcon size={18} />
      </button>

      {show && (
      <div className="settings-dropdown" ref={panelRef} role="dialog" aria-label="Settings">
        <div className="settings-head">
          <span>Settings</span>
          <button className="x" onClick={() => setShow(false)} aria-label="Close settings">
            <CloseIcon size={20} />
          </button>
        </div>

        <div className="settings-section first">Song</div>

        <label className="field">
          <span>
            Speed: <b>{rate.toFixed(2)}×</b>
          </span>
          <input
            type="range"
            min={0.25}
            max={2}
            step={0.05}
            value={rate}
            onChange={(e) => onRate(parseFloat(e.target.value))}
          />
        </label>
        <div className="settings-row">
          {SPEED_PRESETS.map((p) => (
            <button
              key={p}
              className={`mini${Math.abs(rate - p) < 0.001 ? ' active' : ''}`}
              onClick={() => onRate(p)}
            >
              {p}×
            </button>
          ))}
        </div>

        <div className="settings-loop">
          <span>
            A–B loop:{' '}
            <b>
              {loopA == null && loopB == null
                ? 'off'
                : `${loopA != null ? formatTime(loopA) : '…'} – ${loopB != null ? formatTime(loopB) : 'end'}`}
            </b>
          </span>
          <div className="settings-row">
            <button className={`mini${loopA != null ? ' active' : ''}`} onClick={onSetLoopA}>
              Set A here
            </button>
            <button className={`mini${loopB != null ? ' active' : ''}`} onClick={onSetLoopB}>
              Set B here
            </button>
            {(loopA != null || loopB != null) && (
              <button className="mini" onClick={clearLoop}>
                Clear
              </button>
            )}
          </div>
        </div>

        <Toggle label="Left hand notes" value={showLeft} onChange={() => toggleHand('left')} />
        <Toggle label="Right hand notes" value={showRight} onChange={() => toggleHand('right')} />

        <div className="settings-row">
          <button
            className="ghost-btn small"
            onClick={() => {
              setShow(false);
              onPlayAlong();
            }}
          >
            <MicIcon size={15} /> Play along
          </button>
          <button
            className="ghost-btn small"
            onClick={() => {
              setShow(false);
              onExport();
            }}
          >
            <ExportVideoIcon size={15} /> Export video
          </button>
        </div>

        <div className="settings-section">Playback</div>

        <Toggle label="Strike glow" value={glow} onChange={setGlow} />
        <Toggle label="Impact effects" value={impacts} onChange={setImpacts} />
        <Toggle label="Show hands" value={showHands} onChange={setShowHands} />

        <label className="field">
          <span>
            Fall speed: <b>{fallSpeed}</b> px/s
          </span>
          <input
            type="range"
            min={120}
            max={420}
            step={10}
            value={fallSpeed}
            onChange={(e) => setFallSpeed(parseInt(e.target.value, 10))}
          />
        </label>

        <div className="settings-section">MIDI keyboard practice</div>

        {midiSupported() ? (
          <>
            <Toggle label="MIDI keyboard input" value={midiEnabled} onChange={onToggleMidi} />
            {midiEnabled && (
              <p className="midi-status">
                {midiDevices.length
                  ? `Connected: ${midiDevices.join(', ')}`
                  : 'No MIDI devices found — plug one in.'}
              </p>
            )}
          </>
        ) : (
          <p className="midi-status">Web MIDI isn’t supported in this browser (try Chrome).</p>
        )}

        <div className="segmented">
          {MODES.map((m) => (
            <button
              key={m.value}
              className={`seg${practiceMode === m.value ? ' active' : ''}`}
              onClick={() => setPracticeMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="settings-hint">
          {MODES.find((m) => m.value === practiceMode)!.hint}
          {practiceMode === 'wait' &&
            ' The keys you need glow green — tap them on screen or play your MIDI keyboard.'}
        </p>

        <CleanupSection />
      </div>
      )}
    </>
  );
}
