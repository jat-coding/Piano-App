import { useStore } from './store';
import { Home } from './components/Home';
import { Player } from './components/Player';
import { SheetView } from './components/SheetView';
import { TranscribeOverlay } from './components/TranscribeOverlay';
import { TrimDialog } from './components/TrimDialog';
import { ChevronLeftIcon } from './components/icons';

export default function App() {
  const view = useStore((s) => s.view);
  const song = useStore((s) => s.song);
  const setView = useStore((s) => s.setView);

  return (
    <div className="app">
      {view === 'home' && <Home />}

      {view === 'player' && (
        <>
          <Player />
          <button className="back-btn" onClick={() => setView('home')} title="Back to rack">
            <ChevronLeftIcon size={16} /> Rack
          </button>
          {song && <div className="song-title">{song.name}</div>}
        </>
      )}

      {view === 'sheet' && <SheetView />}

      <TranscribeOverlay />
      <TrimDialog />
    </div>
  );
}
