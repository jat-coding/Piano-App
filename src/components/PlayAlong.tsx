import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlaybackEngine } from '../audio/playback';
import type { Renderer } from '../render/Renderer';
import { PlayAlongSession, type Phase, type SessionScore } from '../interactive/session';
import { MicError, MicInput } from '../interactive/mic';
import { midiSupported } from '../lib/midiInput';
import { useStore } from '../store';
import { MicIcon, PianoIcon } from './icons';
import type { SessionExport } from '../interactive/recording';

type Input = 'mic' | 'midi';

type View =
  | { kind: 'intro' }
  | { kind: 'opening' }
  | { kind: 'calibrating' }
  | { kind: 'countdown' }
  | { kind: 'running' }
  | { kind: 'finishing' }
  | { kind: 'done'; score: SessionScore }
  | { kind: 'error'; message: string };

interface Props {
  engine: PlaybackEngine;
  renderer: () => Renderer | null;
  /** Hand the live session to the player's frame loop (null = none). */
  bind: (s: PlayAlongSession | null) => void;
  onToggleMidi: (enabled: boolean) => Promise<void> | void;
  onExport: (session: SessionExport) => void;
  onClose: () => void;
}

/**
 * Play along: the song waits for the player's piano, heard through the mic (or a
 * MIDI keyboard). Intro → mic check (quiet, then "play any note") → 3-2-1 → the song
 * → score, with "Export my session", "Try again" and "Done".
 */
export function PlayAlong({ engine, renderer, bind, onToggleMidi, onExport, onClose }: Props) {
  const song = useStore((s) => s.song);
  const midiEnabled = useStore((s) => s.midiEnabled);
  const [input, setInput] = useState<Input>('mic');
  const [view, setView] = useState<View>({ kind: 'intro' });
  const [calStep, setCalStep] = useState<'quiet' | 'listen'>('quiet');
  const [count, setCount] = useState(3);
  const [streak, setStreak] = useState(0);
  const [waitLong, setWaitLong] = useState(false);
  const [building, setBuilding] = useState(false);
  const meterRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<PlayAlongSession | null>(null);
  const micRef = useRef<MicInput | null>(null);
  const streakRef = useRef(0);

  const stopAll = useCallback(() => {
    sessionRef.current?.dispose();
    sessionRef.current = null;
    bind(null);
    micRef.current?.close();
    micRef.current = null;
    (window as any).__cascadeSession = null;
  }, [bind]);

  useEffect(() => () => stopAll(), [stopAll]);

  const onPhase = useCallback((p: Phase) => {
    const s = sessionRef.current;
    if (!s) return;
    if (p === 'listen') setCalStep('listen');
    else if (p === 'countdown') setView({ kind: 'countdown' });
    else if (p === 'running') setView({ kind: 'running' });
    else if (p === 'tail') setView({ kind: 'finishing' });
    else if (p === 'done') {
      micRef.current?.stopRecording();
      setView({ kind: 'done', score: s.score });
    } else if (p === 'error') setView({ kind: 'error', message: s.error });
  }, []);

  /** Start a session (reusing the mic and its noise floor on "Try again"). */
  const begin = useCallback(
    (previous: PlayAlongSession | null) => {
      if (!song) return;
      const mic = input === 'mic' ? micRef.current : null;
      streakRef.current = 0;
      setStreak(0);
      setWaitLong(false);
      const s = new PlayAlongSession(
        engine,
        song,
        mic,
        {
          onPhase,
          onWrong: (m) => {
            renderer()?.flashWrong(m);
            streakRef.current = 0;
          },
          onHit: (midis) => {
            streakRef.current += midis.length;
          },
        },
        undefined,
        previous?.listener ?? null,
      );
      sessionRef.current = s;
      (window as any).__cascadeSession = s; // read by the headless tests
      bind(s);
      setCalStep('quiet');
      setView(s.phase === 'countdown' ? { kind: 'countdown' } : { kind: 'calibrating' });
    },
    [song, input, engine, onPhase, renderer, bind],
  );

  const start = async () => {
    // Inside the tap: unlock audio and ask for the mic.
    void engine.unlock();
    if (input === 'midi') {
      if (!midiEnabled) await onToggleMidi(true);
      begin(null);
      return;
    }
    setView({ kind: 'opening' });
    try {
      micRef.current = await MicInput.open();
      (window as any).__cascadeMic = micRef.current;
      begin(null);
    } catch (err) {
      const message = err instanceof MicError ? err.message : (err as Error).message || String(err);
      (window as any).__cascadeMicError = message;
      setView({ kind: 'error', message });
    }
  };

  // While it runs: the level meter, the countdown number, the streak, and a hint when the song has been waiting a while.
  useEffect(() => {
    if (view.kind !== 'calibrating' && view.kind !== 'countdown' && view.kind !== 'running') return;
    let raf = 0;
    const tick = () => {
      const s = sessionRef.current;
      if (s) {
        if (meterRef.current) meterRef.current.style.transform = `scaleX(${s.meter.toFixed(3)})`;
        if (view.kind === 'countdown') setCount(Math.max(1, Math.ceil(s.countdown)));
        if (view.kind === 'running') {
          setStreak(streakRef.current);
          setWaitLong(s.waitingFor > 1.5);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [view.kind]);

  const exportSession = async () => {
    const s = sessionRef.current;
    if (!s || !song) return;
    setBuilding(true);
    try {
      const { buildTrack, buildSessionAudio } = await import('../interactive/recording');
      const track = buildTrack(s, song);
      const audio = await buildSessionAudio(s, micRef.current, track, 48000);
      onExport({ track, audio });
    } catch (err) {
      console.error(err);
      setView({ kind: 'error', message: `The session couldn't be prepared for the video (${(err as Error).message}).` });
    } finally {
      setBuilding(false);
    }
  };

  const tryAgain = () => {
    const prev = sessionRef.current;
    prev?.dispose();
    if (input === 'mic' && !micRef.current) {
      void start();
      return;
    }
    // A fresh recording for the new attempt; the room's noise floor is kept.
    micRef.current?.restartRecording();
    begin(prev);
  };

  const done = () => {
    engine.seek(0);
    stopAll();
    onClose();
  };

  if (!song) return null;
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  return (
    <>
      {view.kind === 'intro' && (
        <div className="export-backdrop" role="dialog" aria-modal="true" aria-label="Play along">
          <div className="export-card play-card">
            <div className="export-icon brass-mark">
              <MicIcon size={34} />
            </div>
            <h2>Play along</h2>
            <p className="export-sub">
              Play {song.name} on your piano. The song waits for each right note, and a wrong key flashes red.
              Cascade stays silent.
            </p>
            <div className="segmented play-input" role="radiogroup" aria-label="Listen with">
              <button
                className={`seg${input === 'mic' ? ' active' : ''}`}
                role="radio"
                aria-checked={input === 'mic'}
                onClick={() => setInput('mic')}
              >
                <MicIcon size={16} /> Microphone
              </button>
              {midiSupported() && (
                <button
                  className={`seg${input === 'midi' ? ' active' : ''}`}
                  role="radio"
                  aria-checked={input === 'midi'}
                  onClick={() => setInput('midi')}
                >
                  <PianoIcon size={16} /> MIDI keyboard
                </button>
              )}
            </div>
            <p className="export-sub">
              {input === 'mic'
                ? 'Put the phone near the piano. Everything stays on this phone; nothing is uploaded.'
                : 'Plug in your keyboard. You can export the session afterwards too.'}
            </p>
            <div className="export-actions">
              <button className="ghost-btn" onClick={done}>
                Cancel
              </button>
              <button className="primary-btn" onClick={start}>
                {input === 'mic' ? 'Allow microphone & start' : 'Start'}
              </button>
            </div>
          </div>
        </div>
      )}

      {(view.kind === 'opening' || view.kind === 'calibrating') && (
        <div className="export-backdrop" role="dialog" aria-modal="true" aria-label="Microphone check">
          <div className="export-card play-card">
            <div className="export-icon brass-mark">
              <MicIcon size={34} />
            </div>
            <h2>{view.kind === 'opening' ? 'Opening the microphone…' : calStep === 'quiet' ? 'Stay quiet for a moment…' : 'Now play any note'}</h2>
            <p className="export-sub">
              {view.kind === 'opening'
                ? 'Your browser may ask to use the microphone.'
                : calStep === 'quiet'
                  ? 'Listening to the room so its own sound is ignored.'
                  : 'Any key, any loudness. It checks the microphone can hear the piano.'}
            </p>
            <div className="mic-meter" aria-hidden="true">
              <div ref={meterRef} className="mic-meter-fill" />
            </div>
            <div className="export-actions">
              <button className="ghost-btn" onClick={done}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {view.kind === 'countdown' && (
        <div className="play-countdown" aria-live="assertive">
          <span key={count}>{count}</span>
          <p>Get ready</p>
        </div>
      )}

      {(view.kind === 'running' || view.kind === 'finishing') && (
        <div className="play-hud">
          <span className="play-listening">
            <span className="play-dot" />
            {input === 'mic' ? 'Listening' : 'MIDI'}
          </span>
          <span className="play-streak">Streak {streak}</span>
          <button className="ghost-btn small" onClick={() => sessionRef.current?.finish()}>
            Stop
          </button>
        </div>
      )}
      {view.kind === 'running' && waitLong && <div className="wait-hint">Waiting for you: play the green keys</div>}

      {view.kind === 'done' && (
        <div className="export-backdrop" role="dialog" aria-modal="true" aria-label="Your score">
          <div className="export-card play-card score-card">
            <p className="score-song">{song.name}</p>
            <p className="score-big">{pct(view.score.accuracy)}</p>
            <p className="score-label">accuracy</p>
            <div className="score-row">
              <div>
                <b>{view.score.bestStreak}</b>
                <span>best streak</span>
              </div>
              <div>
                <b>
                  {view.score.clean}/{view.score.total}
                </b>
                <span>clean notes</span>
              </div>
            </div>
            {!view.score.complete && (
              <p className="export-sub">Stopped early: the score counts the notes you got to.</p>
            )}
            <p className="export-sub">Accuracy = notes you hit without a wrong key first.</p>
            <div className="export-actions wrap">
              <button className="ghost-btn" onClick={done}>
                Done
              </button>
              <button className="ghost-btn" onClick={tryAgain}>
                Try again
              </button>
              <button className="primary-btn" onClick={exportSession} disabled={building}>
                {building ? 'Preparing…' : 'Export my session'}
              </button>
            </div>
          </div>
        </div>
      )}

      {view.kind === 'error' && (
        <div className="export-backdrop" role="dialog" aria-modal="true" aria-label="Play along problem">
          <div className="export-card play-card">
            <div className="export-icon brass-mark">
              <MicIcon size={34} />
            </div>
            <h2>Play along</h2>
            <p className="export-error" role="alert">
              {view.message}
            </p>
            <div className="export-actions">
              <button className="ghost-btn" onClick={done}>
                Close
              </button>
              <button
                className="primary-btn"
                onClick={() => {
                  stopAll();
                  setView({ kind: 'intro' });
                }}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
