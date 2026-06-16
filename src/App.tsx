import { useStore } from './store';
import { Uploader } from './components/Uploader';
import { Player } from './components/Player';
import { TranscribeOverlay } from './components/TranscribeOverlay';
import { TrimDialog } from './components/TrimDialog';
import { ChevronLeftIcon } from './components/icons';

export default function App() {
  const song = useStore((s) => s.song);
  const reset = useStore((s) => s.reset);

  return (
    <div className="app">
      {song ? (
        <>
          <Player />
          <button className="back-btn" onClick={reset} title="Load another file">
            <ChevronLeftIcon size={16} /> New file
          </button>
          <div className="song-title">{song.name}</div>
        </>
      ) : (
        <Uploader />
      )}
      <TranscribeOverlay />
      <TrimDialog />
    </div>
  );
}
