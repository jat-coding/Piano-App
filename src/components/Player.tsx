import { useCallback, useEffect, useRef, useState } from 'react';
import { Renderer } from '../render/Renderer';
import { PlaybackEngine } from '../audio/playback';
import { useStore } from '../store';
import { Controls } from './Controls';
import { Scrubber } from './Scrubber';
import { CleanupPanel } from './CleanupPanel';
import { Settings } from './Settings';
import { MidiInput } from '../lib/midiInput';
import { RotateIcon } from './icons';

function isMobile(): boolean {
  return (
    (navigator.maxTouchPoints ?? 0) > 0 &&
    Math.min(window.innerWidth, window.innerHeight) < 820
  );
}

export function Player() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const engineRef = useRef<PlaybackEngine>(new PlaybackEngine());
  const midiRef = useRef<MidiInput>(new MidiInput());
  const rafRef = useRef(0);
  const hideTimerRef = useRef<number>(0);

  const [uiVisible, setUiVisible] = useState(true);
  const [portrait, setPortrait] = useState(false);

  const song = useStore((s) => s.song);
  const setCurrentTime = useStore((s) => s.setCurrentTime);
  const setPlaying = useStore((s) => s.setPlaying);
  const setRate = useStore((s) => s.setRate);
  const setLoadingAudio = useStore((s) => s.setLoadingAudio);
  const loadingAudio = useStore((s) => s.loadingAudio);
  const setWaiting = useStore((s) => s.setWaiting);
  const setExpected = useStore((s) => s.setExpected);
  const setLoopA = useStore((s) => s.setLoopA);
  const setLoopB = useStore((s) => s.setLoopB);
  const setMidi = useStore((s) => s.setMidi);
  const waiting = useStore((s) => s.waiting);

  // ---- one-time setup: renderer, engine, resize, rAF loop ----
  useEffect(() => {
    const canvas = canvasRef.current!;
    const container = containerRef.current!;
    const renderer = new Renderer(canvas);
    rendererRef.current = renderer;
    const engine = engineRef.current;

    const ro = new ResizeObserver(() => {
      const r = container.getBoundingClientRect();
      renderer.resize(r.width, r.height);
    });
    ro.observe(container);
    const r0 = container.getBoundingClientRect();
    renderer.resize(r0.width, r0.height);

    setLoadingAudio(true);
    engine.init().finally(() => setLoadingAudio(false));

    let lastWaiting = false;
    let lastExpectedKey = '';
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const loop = () => {
      const st = useStore.getState();
      engine.muteLeft = !st.showLeft;
      engine.muteRight = !st.showRight;
      engine.loopA = st.loopA;
      engine.loopB = st.loopB;
      const wantWait = st.practiceMode === 'wait';
      if (engine.practice !== wantWait) engine.setPractice(wantWait);

      renderer.opts.showLeft = st.showLeft;
      renderer.opts.showRight = st.showRight;
      renderer.opts.glow = st.glow;
      renderer.opts.impacts = st.impacts && !reduceMotion;
      renderer.opts.pixelsPerSecond = st.fallSpeed;

      const t = engine.tick();

      // Surface wait-mode state to the UI + renderer only when it changes.
      const expected = engine.expectedMidis();
      const expectedKey = expected.join(',');
      if (engine.waiting !== lastWaiting) {
        lastWaiting = engine.waiting;
        setWaiting(engine.waiting);
      }
      if (expectedKey !== lastExpectedKey) {
        lastExpectedKey = expectedKey;
        renderer.setExpected(expected);
        setExpected(expected);
      }

      renderer.draw(t);
      setCurrentTime(t);

      // Engine may auto-stop at the end of the song.
      if (st.isPlaying && !engine.playing) setPlaying(false);

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      engine.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- load song into renderer + engine when it changes ----
  useEffect(() => {
    rendererRef.current?.setSong(song);
    engineRef.current.setSong(song);
    setPlaying(false);
  }, [song, setPlaying]);

  // ---- orientation tracking ----
  useEffect(() => {
    const check = () =>
      setPortrait(isMobile() && window.matchMedia('(orientation: portrait)').matches);
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, []);

  // ---- auto-hide controls after 3s ----
  const poke = useCallback(() => {
    setUiVisible(true);
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (engineRef.current.playing) setUiVisible(false);
    }, 3000);
  }, []);

  // ---- transport handlers ----
  const goFullscreenLandscape = useCallback(async () => {
    if (!isMobile()) return;
    try {
      await containerRef.current?.requestFullscreen?.();
      // Lock works only in fullscreen, and only where supported (not iOS Safari).
      await (screen.orientation as any)?.lock?.('landscape');
    } catch {
      /* unsupported — the rotate overlay is the fallback */
    }
  }, []);

  const playPause = useCallback(async () => {
    const engine = engineRef.current;
    if (engine.playing) {
      engine.pause();
      setPlaying(false);
    } else {
      await goFullscreenLandscape();
      await engine.play();
      setPlaying(true);
    }
    poke();
  }, [setPlaying, poke, goFullscreenLandscape]);

  const seek = useCallback(
    (t: number) => {
      engineRef.current.seek(t);
      setCurrentTime(engineRef.current.songTime);
    },
    [setCurrentTime],
  );

  const skip = useCallback((delta: number) => {
    const e = engineRef.current;
    e.seek(e.songTime + delta);
  }, []);

  const changeRate = useCallback(
    (r: number) => {
      engineRef.current.setRate(r);
      setRate(engineRef.current.rate);
    },
    [setRate],
  );

  // ---- A–B loop: set markers at the current playhead, keeping A < B ----
  const setLoopAtA = useCallback(() => {
    const a = engineRef.current.songTime;
    const b = useStore.getState().loopB;
    if (b != null && a >= b) setLoopB(null);
    setLoopA(a);
  }, [setLoopA, setLoopB]);

  const setLoopAtB = useCallback(() => {
    const b = engineRef.current.songTime;
    const a = useStore.getState().loopA;
    if (a != null && b <= a) setLoopA(null);
    setLoopB(b);
  }, [setLoopA, setLoopB]);

  // ---- MIDI keyboard input (wait mode) ----
  const toggleMidi = useCallback(
    async (enabled: boolean) => {
      const midi = midiRef.current;
      if (enabled) {
        try {
          const devices = await midi.enable({
            onNoteOn: (m, v) => {
              engineRef.current.notePlayed(m);
              engineRef.current.audition(m, v);
            },
            onNoteOff: () => {},
          });
          setMidi(true, devices);
        } catch (err) {
          console.error(err);
          setMidi(false, []);
        }
      } else {
        midi.disable();
        setMidi(false, []);
      }
    },
    [setMidi],
  );

  useEffect(() => () => midiRef.current.disable(), []);

  // ---- keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!song) return;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          playPause();
          break;
        case 'ArrowLeft':
          skip(-5);
          break;
        case 'ArrowRight':
          skip(5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          changeRate(Math.min(2, useStore.getState().rate + 0.05));
          break;
        case 'ArrowDown':
          e.preventDefault();
          changeRate(Math.max(0.25, useStore.getState().rate - 0.05));
          break;
      }
      poke();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [song, playPause, skip, changeRate, poke]);

  return (
    <div
      ref={containerRef}
      className={`player${uiVisible ? '' : ' ui-hidden'}`}
      onPointerMove={poke}
      onMouseLeave={() => engineRef.current.playing && setUiVisible(false)}
    >
      <canvas
        ref={canvasRef}
        className="stage"
        onPointerDown={(e) => {
          if (e.target !== canvasRef.current) return;
          const renderer = rendererRef.current;
          const canvas = canvasRef.current;
          if (!renderer || !canvas) return;
          const rect = canvas.getBoundingClientRect();
          const midi = renderer.keyAtPoint(e.clientX - rect.left, e.clientY - rect.top);
          if (midi != null) {
            // Tapped a key — play it, and let it answer wait-mode.
            engineRef.current.unlock();
            engineRef.current.notePlayed(midi);
            engineRef.current.audition(midi, 0.8);
            renderer.flashKey(midi);
          } else {
            // Tapped the falling-notes area — toggle playback.
            playPause();
          }
          poke();
        }}
      />

      {loadingAudio && <div className="audio-loading">Loading piano…</div>}
      {waiting && <div className="wait-hint">Waiting — play the green keys (tap or MIDI)</div>}

      <CleanupPanel />
      <Settings onToggleMidi={toggleMidi} />

      <div className="bottom-bar">
        <Scrubber onSeek={seek} />
        <Controls
          onPlayPause={playPause}
          onSkip={skip}
          onRate={changeRate}
          onSetLoopA={setLoopAtA}
          onSetLoopB={setLoopAtB}
        />
      </div>

      {portrait && (
        <div className="rotate-overlay">
          <div className="rotate-icon">
            <RotateIcon size={56} />
          </div>
          <p>Rotate your phone</p>
          <span>Landscape gives you the full keyboard</span>
        </div>
      )}
    </div>
  );
}
