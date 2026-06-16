import { useEffect, useState } from 'react';
import { listSongs, deleteSong, type SavedSongMeta } from '../lib/library';
import { loadSavedSong } from '../lib/pipeline';
import { formatTime } from '../lib/format';
import { MusicIcon, MicIcon, VideoIcon, TrashIcon } from './icons';

const KIND_ICON = { midi: MusicIcon, audio: MicIcon, video: VideoIcon } as const;

export function Library() {
  const [songs, setSongs] = useState<SavedSongMeta[]>([]);

  const refresh = () => listSongs().then(setSongs).catch(() => setSongs([]));
  useEffect(() => {
    refresh();
  }, []);

  if (songs.length === 0) return null;

  return (
    <div className="library">
      <h2>Your library</h2>
      <ul>
        {songs.map((s) => {
          const KindIcon = KIND_ICON[s.kind] ?? MusicIcon;
          return (
            <li key={s.id}>
              <button className="lib-item" onClick={() => loadSavedSong(s.id)}>
                <span className="lib-icon">
                  <KindIcon size={18} />
                </span>
                <span className="lib-name">{s.name}</span>
                <span className="lib-dur">{formatTime(s.duration)}</span>
              </button>
              <button
                className="lib-del"
                title="Delete"
                aria-label={`Delete ${s.name}`}
                onClick={async () => {
                  await deleteSong(s.id);
                  refresh();
                }}
              >
                <TrashIcon size={16} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
