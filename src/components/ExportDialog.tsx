import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { getMedia, listSongs } from '../lib/library';
import { whenSaved } from '../lib/pipeline';
import type { ExportPlan, ExportResult } from '../export/exportVideo';
import type { SessionExport } from '../interactive/recording';
import { formatTime } from '../lib/format';
import { ExportVideoIcon } from './icons';

type Phase =
  | { kind: 'loading' }
  | { kind: 'confirm'; plan: ExportPlan }
  | { kind: 'running'; stage: string; ratio: number }
  | { kind: 'done'; result: ExportResult }
  | { kind: 'error'; message: string };

function isIOS(): boolean {
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1)
  );
}

function download(result: ExportResult): void {
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * "Export video": says what the video will contain, renders it with a
 * progress bar + Cancel, then hands over the file. Every failure lands on
 * screen as text — never a silent close.
 */
export function ExportDialog({ onClose, session }: { onClose: () => void; session?: SessionExport | null }) {
  const showHands = useStore((s) => s.showHands);
  const song = useStore((s) => s.song);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const abortRef = useRef<AbortController | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  // "Include the original video" (stacked on top). Off by default: plain falling notes.
  const [stack, setStack] = useState(false);

  // Work out layout + sound source from what the library kept for this song.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (!song) throw new Error('No song is loaded.');
        if (session) {
          const { planSessionExport } = await import('../export/exportVideo');
          if (live) setPhase({ kind: 'confirm', plan: planSessionExport(session) });
          return;
        }
        await whenSaved();
        const id = useStore.getState().currentSavedId;
        const media = id ? await getMedia(id) : null;
        const meta = id ? (await listSongs()).find((s) => s.id === id) : undefined;
        // Loaded on demand so the muxer/demuxer never weigh down app start-up.
        const { planExport } = await import('../export/exportVideo');
        if (live) setPhase({ kind: 'confirm', plan: planExport(song, media, meta?.kind ?? null) });
      } catch (err) {
        console.error(err);
        if (live) setPhase({ kind: 'error', message: (err as Error).message || String(err) });
      }
    })();
    return () => {
      live = false;
    };
  }, [song, session]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = async (plan: ExportPlan) => {
    if (!song) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase({ kind: 'running', stage: 'Starting…', ratio: 0 });
    try {
      const { exportVideo } = await import('../export/exportVideo');
      const result = await exportVideo(
        song,
        plan,
        (p) => setPhase({ kind: 'running', stage: p.stage, ratio: p.ratio }),
        ac.signal,
      );
      console.info('[export]', {
        size: result.blob.size,
        video: result.videoCodec,
        audio: result.audioCodec,
        elapsed: result.elapsed,
        renderFps: result.renderFps,
      });
      (window as any).__cascadeLastExport = result; // read by the headless test
      setPhase({ kind: 'done', result });
      // iOS needs a fresh tap to share; elsewhere download straight away.
      if (!isIOS()) download(result);
    } catch (err) {
      if (ac.signal.aborted) {
        onClose();
        return;
      }
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      (window as any).__cascadeLastExportError = message;
      setPhase({ kind: 'error', message });
    }
  };

  const save = async (result: ExportResult) => {
    setShareError(null);
    if (isIOS()) {
      const file = new File([result.blob], result.fileName, { type: result.mimeType });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: result.fileName });
          return;
        } catch (err) {
          if ((err as DOMException).name === 'AbortError') return; // closed the share sheet
          setShareError(`Sharing failed (${(err as Error).message}). Downloading instead.`);
        }
      }
    }
    download(result);
  };

  const pct = phase.kind === 'running' ? Math.round(phase.ratio * 100) : 0;

  return (
    <div className="export-backdrop" role="dialog" aria-modal="true" aria-label={session ? 'Export my session' : 'Export video'}>
      <div className="export-card">
        <div className="export-icon brass-mark">
          <ExportVideoIcon size={34} />
        </div>
        <h2>{session ? 'Export my session' : 'Export video'}</h2>

        {phase.kind === 'loading' && <p className="export-sub">Checking this song…</p>}

        {phase.kind === 'confirm' && (
          <>
            {phase.plan.session ? (
              <ul className="export-plan">
                <li>Vertical video for your phone, {formatTime(phase.plan.duration)} long.</li>
                <li>The falling notes, with your hits lighting up and wrong keys flashing red, as they happened.</li>
                <li>
                  {phase.plan.session.track.sound === 'mic'
                    ? 'Sound: your playing, as the microphone heard it.'
                    : "Sound: Cascade's piano playing the keys you pressed."}
                </li>
                <li>Your score at the end.</li>
              </ul>
            ) : (
            <ul className="export-plan">
              <li>
                Vertical video for your phone, {formatTime(phase.plan.duration)} long.
              </li>
              <li>
                {stack && phase.plan.canStack
                  ? 'Your original video on top, falling notes below, in sync.'
                  : 'Falling notes filling the screen.'}
              </li>
              <li>
                {phase.plan.sound === 'original'
                  ? 'Sound: your original recording (the part you picked).'
                  : "Sound: Cascade's piano playing the notes."}
              </li>
              <li>
                {showHands
                  ? 'Hands playing the keys (turn off in Settings → Show hands).'
                  : 'No hands (turned off in Settings).'}
              </li>
            </ul>
            )}
            {!phase.plan.session && phase.plan.canStack && (
              <div className="toggle-row export-toggle">
                <span id="export-stack-label">Include the original video (on top)</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={stack}
                  aria-labelledby="export-stack-label"
                  className={`switch${stack ? ' on' : ''}`}
                  onClick={() => setStack(!stack)}
                >
                  <span className="knob" />
                </button>
              </div>
            )}
            {phase.plan.notes.map((n) => (
              <p key={n} className="export-note">
                {n}
              </p>
            ))}
            <p className="export-sub">Made on this device — nothing is uploaded. Keep this screen open.</p>
            <div className="export-actions">
              <button className="ghost-btn" onClick={onClose}>
                Cancel
              </button>
              <button className="primary-btn" onClick={() =>
                  start({
                    ...phase.plan,
                    layout: stack && phase.plan.canStack ? 'video' : 'full',
                    hands: showHands,
                  })
                }>
                Make video
              </button>
            </div>
          </>
        )}

        {phase.kind === 'running' && (
          <>
            <p className="export-stage">{phase.stage}</p>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="progress-num">{pct}%</p>
            <div className="export-actions">
              <button className="ghost-btn" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            </div>
          </>
        )}

        {phase.kind === 'done' && (
          <>
            <p className="export-stage">
              Your video is ready ({(phase.result.blob.size / 1_048_576).toFixed(1)} MB).
            </p>
            {phase.result.warnings.map((w) => (
              <p key={w} className="export-note">
                {w}
              </p>
            ))}
            {shareError && <p className="export-error">{shareError}</p>}
            <div className="export-actions">
              <button className="ghost-btn" onClick={onClose}>
                Close
              </button>
              <button className="primary-btn" onClick={() => save(phase.result)}>
                {isIOS() ? 'Save / Share' : 'Download again'}
              </button>
            </div>
          </>
        )}

        {phase.kind === 'error' && (
          <>
            <p className="export-error" role="alert">
              The video couldn't be made: {phase.message}
            </p>
            <div className="export-actions">
              <button className="ghost-btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
