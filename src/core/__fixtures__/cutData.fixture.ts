export const CUT_DATA_SOURCE = `export interface CutSegment {
  id: number;
  originalStart: number;
  originalEnd: number;
  playbackStart: number;
  playbackEnd: number;
}

export const FPS = 60;
const toFrame = (ms: number) => Math.round((ms / 1000) * FPS);

export const cutData: CutSegment[] = [
  { id: 1, originalStart: 0, originalEnd: 3000, playbackStart: 0, playbackEnd: 3000 },
  { id: 2, originalStart: toFrame(60000), originalEnd: 12000, playbackStart: 3000, playbackEnd: 11400 },
];

export const ORIGINAL_DURATION_FRAMES = 12000;
export const CUT_DURATION_FRAMES = 11400;
`;
