/**
 * トラック種別ごとのインライン SVG アイコン。
 * Task 5: 共有 TrackHeader の部品として各トラック見出しに表示する。
 */

export type TrackKind =
  | 'video'
  | 'jimaku'
  | 'title'
  | 'telop'
  | 'image'
  | 'vi'
  | 'bgm'
  | 'se'
  | 'shape';

interface TrackIconProps {
  kind: TrackKind;
}

export function TrackIcon({ kind }: TrackIconProps) {
  switch (kind) {
    case 'video':
      return (
        <svg
          className="tl-track-icon"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <rect x="1" y="2" width="7" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8 4.5L11 3v6L8 7.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
    case 'jimaku':
      return (
        <svg
          className="tl-track-icon"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <rect x="1" y="3" width="10" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <path d="M3 6h6M3 8h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      );
    case 'title':
      return (
        <svg
          className="tl-track-icon"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 3h8M6 3v6"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'telop':
      return (
        <svg
          className="tl-track-icon"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <rect x="1" y="4" width="10" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <path d="M3 6.5h6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      );
    case 'image':
      return (
        <svg
          className="tl-track-icon"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="4" cy="4" r="1" fill="currentColor" />
          <path d="M1 8l3-3 2.5 2.5L9 5l2 3" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
        </svg>
      );
    case 'vi':
      return (
        <svg
          className="tl-track-icon"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <rect x="1" y="2" width="7" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8 4.5L11 3v6L8 7.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M3 5.5l2 1-2 1z" fill="currentColor" />
        </svg>
      );
    case 'bgm':
      return (
        <svg
          className="tl-track-icon"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M5 3v5.5M5 8.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <path d="M5 3l5-1v5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <ellipse cx="9.5" cy="7" rx="1.5" ry="1.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
    case 'se':
      return (
        <svg
          className="tl-track-icon"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 4.5v3M4 3v6M6 4v4M8 3v6M10 4.5v3"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'shape':
      return (
        <svg
          className="tl-track-icon"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path d="M2 9l3-5 2.5 3L9 4l1 5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      );
  }
}
