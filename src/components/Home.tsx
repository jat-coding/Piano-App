import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { listSongs, deleteSong, type SavedSongMeta } from '../lib/library';
import { loadFile, loadSavedSong } from '../lib/pipeline';
import { formatTime } from '../lib/format';
import { PlayIcon, MusicIcon, TrashIcon } from './icons';

/** Deterministic pseudo-random from a string, so a song's mock sheet is stable. */
function seeded(str: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A mock music-sheet card: staves + decorative noteheads + the song title. */
function SongSheet({ song }: { song: SavedSongMeta }) {
  const rand = seeded(song.name + song.id);
  const notes = (yBase: number) =>
    Array.from({ length: 7 }, (_, i) => {
      const x = 26 + i * 30 + rand() * 8;
      const y = yBase + Math.round(rand() * 4) * 6 - 12;
      return <ellipse key={`${yBase}-${i}`} cx={x} cy={y} rx="6" ry="4.5" transform={`rotate(-20 ${x} ${y})`} />;
    });

  const staff = (top: number, clef: string) => (
    <g>
      {[0, 1, 2, 3, 4].map((l) => (
        <line key={l} x1="14" x2="246" y1={top + l * 6} y2={top + l * 6} />
      ))}
      <text x="18" y={top + 20} className="clef">
        {clef}
      </text>
      <g className="noteheads">{notes(top + 12)}</g>
    </g>
  );

  return (
    <svg className="sheet-svg" viewBox="0 0 260 340" role="img" aria-label={song.name}>
      <rect x="0" y="0" width="260" height="340" rx="6" className="paper" />
      <text x="130" y="34" className="sheet-title" textAnchor="middle">
        {song.name.length > 22 ? song.name.slice(0, 21) + '…' : song.name}
      </text>
      {staff(70, '𝄞')}
      {staff(150, '𝄢')}
      {staff(230, '𝄞')}
    </svg>
  );
}

export function Home() {
  const setView = useStore((s) => s.setView);
  const libraryVersion = useStore((s) => s.libraryVersion);
  const bumpLibrary = useStore((s) => s.bumpLibrary);
  const [songs, setSongs] = useState<SavedSongMeta[]>([]);
  const [chosen, setChosen] = useState<SavedSongMeta | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listSongs().then(setSongs).catch(() => setSongs([]));
  }, [libraryVersion]);

  const open = async (id: string, view: 'player' | 'sheet') => {
    setChosen(null);
    await loadSavedSong(id);
    setView(view);
  };

  return (
    <div className="home">
      <header className="home-head">
        <h1 className="wordmark">Cascade</h1>
        <p className="home-sub">Your music rack — swipe to choose a piece to learn</p>
      </header>

      <div className="rack">
        <button
          className="rack-card add-card"
          onClick={() => inputRef.current?.click()}
          aria-label="Add a song"
        >
          <span className="add-plus">＋</span>
          <span>Add a song</span>
          <span className="add-hint">MIDI · audio · video</span>
        </button>

        {songs.map((s) => (
          <button key={s.id} className="rack-card" onClick={() => setChosen(s)}>
            <SongSheet song={s} />
            <span className="rack-meta">{formatTime(s.duration)}</span>
          </button>
        ))}

        {songs.length === 0 && (
          <div className="rack-empty">
            Nothing on the rack yet — tap <b>Add a song</b> to transcribe your first piece.
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".mid,.midi,audio/*,video/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) loadFile(f);
          e.target.value = '';
        }}
      />

      {chosen && (
        <div className="chooser-backdrop" onClick={() => setChosen(null)}>
          <div className="chooser" onClick={(e) => e.stopPropagation()}>
            <h2>{chosen.name}</h2>
            <p className="chooser-sub">How do you want to learn it?</p>
            <div className="chooser-actions">
              <button className="chooser-btn primary" onClick={() => open(chosen.id, 'player')}>
                <PlayIcon size={22} />
                <span>Falling notes</span>
              </button>
              <button className="chooser-btn" onClick={() => open(chosen.id, 'sheet')}>
                <MusicIcon size={22} />
                <span>Sheet music</span>
              </button>
            </div>
            <button
              className="chooser-remove"
              onClick={async () => {
                await deleteSong(chosen.id);
                setChosen(null);
                bumpLibrary();
              }}
            >
              <TrashIcon size={15} /> Remove from library
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
