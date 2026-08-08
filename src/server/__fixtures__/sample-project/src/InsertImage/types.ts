export type ImageType = 'photo' | 'infographic' | 'overlay';

export type ElementAnim = {
  kind: 'none' | 'fade' | 'zoom' | 'pop' | 'slideIn';
  frames: number;
  direction?: 'left' | 'right' | 'up' | 'down';
};

export interface ImageSegment {
  id: number;
  startFrame: number;
  endFrame: number;
  file: string;
  type: ImageType;
  scale?: number;
  position?: { x: number; y: number };
  opacity?: number;
  rotation?: number;
  enter?: ElementAnim;
  exit?: ElementAnim;
}
