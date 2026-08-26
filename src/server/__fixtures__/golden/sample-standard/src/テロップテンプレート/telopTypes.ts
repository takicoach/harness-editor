export interface TelopSegment {
  id: number;
  startFrame: number;
  endFrame: number;
  text: string;
  highlight?: string;
  style?: 'normal' | 'emphasis' | 'warning' | 'success';
  template?: 1 | 2 | 3 | 4 | 5 | 6;
  animation?: 'none' | 'slideIn' | 'fadeOnly' | 'slideFromLeft' | 'fadeBlurFromBottom' | 'slideLeftFadeBlur' | 'fadeFromRight' | 'fadeFromLeft' | 'charByChar';
  position?: { x: number; y: number };
  scale?: number;
}
