/**
 * Inline SVG icon set (Lucide-style, stroke = currentColor). The design system
 * forbids emoji as UI icons; icon-only buttons must carry their own aria-label.
 */
import type { SVGProps, ReactNode } from 'react';

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function Stroke({ size = 20, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

function Fill({ size = 20, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const PlayIcon = (p: IconProps) => (
  <Fill {...p}>
    <path d="M8 5v14l11-7z" />
  </Fill>
);

export const PauseIcon = (p: IconProps) => (
  <Fill {...p}>
    <rect x="6" y="4" width="4" height="16" rx="1" />
    <rect x="14" y="4" width="4" height="16" rx="1" />
  </Fill>
);

export const Rewind5Icon = (p: IconProps) => (
  <Fill {...p}>
    <path d="M11 19 2 12l9-7v14z" />
    <path d="M22 19l-9-7 9-7v14z" />
  </Fill>
);

export const Forward5Icon = (p: IconProps) => (
  <Fill {...p}>
    <path d="M13 19l9-7-9-7v14z" />
    <path d="M2 19l9-7-9-7v14z" />
  </Fill>
);

export const SettingsIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </Stroke>
);

export const CloseIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M18 6 6 18" />
    <path d="M6 6l12 12" />
  </Stroke>
);

export const TrashIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
  </Stroke>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="m15 18-6-6 6-6" />
  </Stroke>
);

export const MusicIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </Stroke>
);

export const MicIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <path d="M12 19v3" />
  </Stroke>
);

export const VideoIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="m23 7-7 5 7 5V7z" />
    <rect x="1" y="5" width="15" height="14" rx="2" />
  </Stroke>
);

export const SlidersIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
    <path d="M1 14h6M9 8h6M17 16h6" />
  </Stroke>
);

export const RotateIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M21 2v6h-6" />
    <path d="M21 13a9 9 0 1 1-3-7.7L21 8" />
  </Stroke>
);

/** Piano keybed — used as the brand mark and the practice-mode button. */
export const PianoIcon = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M7 4v9M12 4v9M17 4v9" />
    <path d="M5 4v6h2.5V4M9.5 4v6H12V4M14.5 4v6H17V4" fill="currentColor" stroke="none" />
  </Stroke>
);
