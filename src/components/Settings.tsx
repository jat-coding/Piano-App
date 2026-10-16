import { useEffect, useRef } from 'react';
import { useStore, type PracticeMode } from '../store';
import { midiSupported } from '../lib/midiInput';
import { CleanupSection } from './CleanupSection';
import { CloseIcon, SettingsIcon } from './icons';

const MODES: { value: PracticeMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Song plays normally.' },
  { value: 'listen', label: 'Listen', hint: 'Song plays through — play along on your keyboard.' },
  { value: 'wait', label: 'Wait', hint: 'Song holds on each note until you play it.' },
];

interface Props {
  onToggleMidi: (enabled: boolean) => void;
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

export function Settings({ onToggleMidi }: Props) {
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

        <div className="settings-section first">Playback</div>

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
