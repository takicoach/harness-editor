export type SceneTransitionKind =
  | 'fadeBlack' | 'fadeWhite' | 'fadeColor' | 'crossfade' | 'slide' | 'wipe';
export type SlideDirection = 'left' | 'right' | 'up' | 'down';
export interface SceneTransition {
  id: number;
  at: 'head' | 'tail' | number;
  kind: SceneTransitionKind;
  durationFrames: number;
  color?: string;
  direction?: SlideDirection;
}

/** ハーネス形式の cutData.ts が持つ CutSegment（残す＝再生する区間）。 */
export interface CutSegment {
  id: number;
  originalStart: number;
  originalEnd: number;
  playbackStart: number;
  playbackEnd: number;
}
