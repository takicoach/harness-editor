export interface ImageSegment {
  id: number;
  startFrame: number;
  endFrame: number;
  file: string;
  type: 'plain' | 'photo' | 'infographic' | 'overlay';
  scale?: number;
  position?: { x: number; y: number };
  opacity?: number;
  rotation?: number;
  enter?: ElementAnim;
  exit?: ElementAnim;
  motion?: import('./imageMotion').Motion;
}

export interface ElementAnim {
  kind: 'none' | 'fade' | 'slideIn' | 'zoom' | 'pop';
  frames: number;
  direction?: 'left' | 'right' | 'up' | 'down';
}
