type IconName =
  | 'folder' | 'chevron-down' | 'chevron-left' | 'chevron-right' | 'undo' | 'redo' | 'save'
  | 'panel-left-close' | 'panel-left-open' | 'search' | 'plus'
  | 'portrait' | 'landscape' | 'square' | 'message' | 'trash'
  | 'sun' | 'moon' | 'gear' | 'home' | 'music' | 'transcript' | 'captions' | 'script'
  | 'play' | 'pause' | 'skip-back' | 'skip-forward' | 'step-back' | 'step-forward' | 'rewind' | 'fast-forward'
  | 'eye' | 'eye-off' | 'scissors' | 'cursor' | 'magnet' | 'pen' | 'check' | 'x' | 'volume' | 'mute'
  | 'sparkles' | 'panel-left' | 'panel-right' | 'layout-wide' | 'type' | 'image' | 'shapes' | 'film'
  | 'sliders' | 'question' | 'arrow-up' | 'arrow-down' | 'export' | 'grip' | 'layout-tall'
  | 'refresh' | 'maximize' | 'minimize' | 'rows' | 'ripple' | 'link' | 'fade-handle';

const PATHS: Record<IconName, string> = {
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  home: 'M3 10.5L12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5',
  music: 'M9 18V5l11-2v13M9 8l11-2M9 18a3 2 0 1 1-6 0 3 2 0 0 1 6 0M20 16a3 2 0 1 1-6 0 3 2 0 0 1 6 0',
  transcript: 'M4 5h16M4 10h10M4 15h7M16 12v8M13 16l3 4 3-4',
  captions: 'M4 5h16v14H4zM7 10h3M7 14h3M14 10h3M14 14h3',
  script: 'M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-right': 'M9 6l6 6-6 6',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h4',
  save: 'M5 3h11l3 3v15H5zM8 3v6h7M8 21v-7h8v7',
  'panel-left-close': 'M4 4h16v16H4zM10 4v16M14 10l-3 2 3 2',
  'panel-left-open': 'M4 4h16v16H4zM10 4v16M11 10l3 2-3 2',
  search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  portrait: 'M7 3h10v18H7z',
  landscape: 'M3 7h18v10H3z',
  square: 'M5 5h14v14H5z',
  message: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-5.3A8 8 0 1 1 21 12z',
  trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  gear: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z',
  play: 'M8 5v14l11-7z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  'skip-back': 'M19 20L9 12l10-8zM5 4v16',
  'skip-forward': 'M5 4l10 8-10 8zM19 4v16',
  'step-back': 'M17 6l-6 6 6 6M8 6v12',
  'step-forward': 'M7 6l6 6-6 6M16 6v12',
  rewind: 'M11 19l-9-7 9-7zM22 19l-9-7 9-7z',
  'fast-forward': 'M13 19l9-7-9-7zM2 19l9-7-9-7z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  'eye-off': 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 4.1-.9',
  scissors: 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12',
  cursor: 'M4 4l7.5 16 2.3-6.2L20 11.5z',
  magnet: 'M4 8V4h5v4a3 3 0 0 0 6 0V4h5v4a8 8 0 0 1-16 0zM4 8h5M15 8h5',
  pen: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  check: 'M5 12l4 4L19 6',
  x: 'M6 6l12 12M18 6L6 18',
  volume: 'M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6',
  mute: 'M4 9v6h4l5 4V5L8 9zM18 9l4 6M22 9l-4 6',
  sparkles: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 15l1 2 2 1-2 1-1 2-1-2-2-1 2-1z',
  'panel-left': 'M3 4h18v16H3zM9 4v16',
  'panel-right': 'M3 4h18v16H3zM15 4v16',
  'layout-wide': 'M3 4h18v16H3zM15 4v10M3 14h18',
  'layout-tall': 'M3 4h18v16H3zM14 4v16M3 14h11',
  type: 'M4 7V4h16v3M12 4v16M9 20h6',
  image: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM21 15l-5-5L5 21',
  shapes: 'M12 3l4 7H8zM3 14h7v7H3zM17.5 14a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  film: 'M3 3h18v18H3zM7 3v18M17 3v18M3 9h4M3 15h4M17 9h4M17 15h4',
  sliders: 'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4M16 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM14 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  question: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.2 9.5a2.8 2.8 0 0 1 5.5.8c0 1.8-2.7 2.4-2.7 4M12 17.5h.01',
  'arrow-up': 'M12 19V5M5 12l7-7 7 7',
  'arrow-down': 'M12 5v14M19 12l-7 7-7-7',
  export: 'M12 3v12M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
  grip: 'M9 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM15 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM9 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM15 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM9 17a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM15 17a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  refresh: 'M4 12a8 8 0 0 1 14.5-4.6M20 12a8 8 0 0 1-14.5 4.6M4 4v5h5M20 20v-5h-5',
  maximize: 'M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5',
  minimize: 'M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5',
  rows: 'M4 5h16M4 12h16M4 19h16',
  ripple: 'M3 12h7M7 8l3 4-3 4M21 12h-7M17 8l-3 4 3 4',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  'fade-handle': 'M3 5h18L12 19z',
};

export function Icon({ name, size = 16, filled = false, strokeWidth = 1.8 }: { name: IconName; size?: number; filled?: boolean; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export type { IconName };
