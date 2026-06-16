import { useCallback, useRef, useState } from 'react';
import { useStore } from '../store';
import { loadFile } from '../lib/pipeline';
import { Library } from './Library';
import { PianoIcon } from './icons';

export function Uploader() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const parseError = useStore((s) => s.parseError);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  }, []);

  return (
    <div className="uploader">
      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <div className="logo brass-mark">
          <PianoIcon size={52} />
        </div>
        <h1>Cascade</h1>
        <p className="tagline">Drop a MIDI, audio, or video file to watch it fall</p>
        <button className="pick-btn" type="button">
          Choose a file
        </button>
        <p className="hint">
          .mid · .mp3 · .wav · .m4a · .ogg · .mp4 · .mov — transcribed on your device,
          nothing is uploaded
        </p>
        <p className="hint reel-hint">
          From a Reel or TikTok? Save the video to your camera roll, then choose it here.
        </p>
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
        {parseError && <p className="error">{parseError}</p>}
      </div>
      <Library />
    </div>
  );
}
