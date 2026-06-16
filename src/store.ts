import { create } from 'zustand';
import type { Song } from './types';
import type { CleanupParams, RawNote } from './lib/transcribe';
import { DEFAULT_CLEANUP } from './lib/transcribe';
import type { BuildOptions } from './lib/cleanup';
import { DEFAULT_BUILD } from './lib/cleanup';
import type { SongKind } from './lib/library';

/**
 * MIDI keyboard practice modes:
 *  - off    → no practice aid; the song plays normally.
 *  - listen → song plays through; you play along and hear your keyboard.
 *  - wait   → song holds on each note until you play the matching key(s).
 */
export type PracticeMode = 'off' | 'listen' | 'wait';

interface AppState {
  song: Song | null;
  isPlaying: boolean;
  currentTime: number; // updated every frame
  duration: number;
  rate: number;
  showLeft: boolean;
  showRight: boolean;
  glow: boolean;
  loadingAudio: boolean;
  parseError: string | null;

  // ---- Phase 2: transcription ----
  rawNotes: RawNote[] | null; // last transcription output (audio/video source)
  sourceName: string;
  transcribing: boolean;
  progress: number; // 0–1 model progress, or -1 for indeterminate stages
  stage: string;
  cleanup: CleanupParams; // worker-side thresholds
  build: BuildOptions; // main-side split + quantize
  showCleanup: boolean;

  // ---- trim step: decoded audio awaiting the user's clip selection ----
  pendingAudio: Float32Array | null;
  pendingName: string;
  pendingKind: SongKind;
  pendingDuration: number; // seconds

  // ---- Phase 3/4: practice, settings, loop, MIDI ----
  loopA: number | null;
  loopB: number | null;
  impacts: boolean;
  fallSpeed: number; // pixels per second
  showSettings: boolean;
  practiceMode: PracticeMode;
  waiting: boolean;
  expected: number[];
  midiEnabled: boolean;
  midiDevices: string[];

  setSong: (song: Song | null) => void;
  setPlaying: (p: boolean) => void;
  setCurrentTime: (t: number) => void;
  setRate: (r: number) => void;
  toggleHand: (hand: 'left' | 'right') => void;
  setGlow: (g: boolean) => void;
  setLoadingAudio: (l: boolean) => void;
  setParseError: (e: string | null) => void;

  setTranscribing: (t: boolean) => void;
  setProgress: (p: number) => void;
  setStage: (s: string) => void;
  setRaw: (raw: RawNote[] | null, name: string) => void;
  setCleanup: (partial: Partial<CleanupParams>) => void;
  setBuild: (partial: Partial<BuildOptions>) => void;
  setShowCleanup: (v: boolean) => void;
  setPending: (audio: Float32Array, name: string, kind: SongKind, duration: number) => void;
  clearPending: () => void;

  setLoopA: (t: number | null) => void;
  setLoopB: (t: number | null) => void;
  clearLoop: () => void;
  setImpacts: (v: boolean) => void;
  setFallSpeed: (v: number) => void;
  setShowSettings: (v: boolean) => void;
  setPracticeMode: (v: PracticeMode) => void;
  setWaiting: (v: boolean) => void;
  setExpected: (m: number[]) => void;
  setMidi: (enabled: boolean, devices: string[]) => void;
  reset: () => void;
}

export const useStore = create<AppState>((set) => ({
  song: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  rate: 1,
  showLeft: true,
  showRight: true,
  glow: true,
  loadingAudio: false,
  parseError: null,

  rawNotes: null,
  sourceName: '',
  transcribing: false,
  progress: -1,
  stage: '',
  cleanup: { ...DEFAULT_CLEANUP },
  build: { ...DEFAULT_BUILD },
  showCleanup: false,

  pendingAudio: null,
  pendingName: '',
  pendingKind: 'audio',
  pendingDuration: 0,

  loopA: null,
  loopB: null,
  impacts: true,
  fallSpeed: 220,
  showSettings: false,
  practiceMode: 'off',
  waiting: false,
  expected: [],
  midiEnabled: false,
  midiDevices: [],

  setSong: (song) =>
    set({
      song,
      duration: song?.duration ?? 0,
      currentTime: 0,
      isPlaying: false,
      loopA: null,
      loopB: null,
      waiting: false,
      expected: [],
    }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setCurrentTime: (currentTime) => set({ currentTime }),
  setRate: (rate) => set({ rate }),
  toggleHand: (hand) =>
    set((s) => (hand === 'left' ? { showLeft: !s.showLeft } : { showRight: !s.showRight })),
  setGlow: (glow) => set({ glow }),
  setLoadingAudio: (loadingAudio) => set({ loadingAudio }),
  setParseError: (parseError) => set({ parseError }),

  setTranscribing: (transcribing) => set({ transcribing }),
  setProgress: (progress) => set({ progress }),
  setStage: (stage) => set({ stage }),
  setRaw: (rawNotes, sourceName) => set({ rawNotes, sourceName }),
  setCleanup: (partial) => set((s) => ({ cleanup: { ...s.cleanup, ...partial } })),
  setBuild: (partial) => set((s) => ({ build: { ...s.build, ...partial } })),
  setShowCleanup: (showCleanup) => set({ showCleanup }),
  setPending: (pendingAudio, pendingName, pendingKind, pendingDuration) =>
    set({ pendingAudio, pendingName, pendingKind, pendingDuration }),
  clearPending: () => set({ pendingAudio: null, pendingName: '', pendingDuration: 0 }),

  setLoopA: (loopA) => set({ loopA }),
  setLoopB: (loopB) => set({ loopB }),
  clearLoop: () => set({ loopA: null, loopB: null }),
  setImpacts: (impacts) => set({ impacts }),
  setFallSpeed: (fallSpeed) => set({ fallSpeed }),
  setShowSettings: (showSettings) => set({ showSettings }),
  setPracticeMode: (practiceMode) => set({ practiceMode, waiting: false, expected: [] }),
  setWaiting: (waiting) => set({ waiting }),
  setExpected: (expected) => set({ expected }),
  setMidi: (midiEnabled, midiDevices) => set({ midiEnabled, midiDevices }),

  reset: () =>
    set({
      song: null,
      rawNotes: null,
      sourceName: '',
      transcribing: false,
      progress: -1,
      stage: '',
      parseError: null,
      isPlaying: false,
      build: { ...DEFAULT_BUILD },
      cleanup: { ...DEFAULT_CLEANUP },
      pendingAudio: null,
      pendingName: '',
      pendingDuration: 0,
      loopA: null,
      loopB: null,
      practiceMode: 'off',
      waiting: false,
      expected: [],
    }),
}));
