export type VideoFormat = 'youtube' | 'short' | 'square';
export const FORMAT: VideoFormat = 'short';
export const FPS = 60;
export const DURATION_FRAMES = 12000;
export const VIDEO_FILE = 'main.mp4';
const RESOLUTION_MAP = {
  youtube: { width: 1920, height: 1080 },
  short: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
} as const;
export const RESOLUTION = RESOLUTION_MAP[FORMAT];
