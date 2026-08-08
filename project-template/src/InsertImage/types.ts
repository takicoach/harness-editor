export interface ImageSegment {
  id: number;
  startFrame: number;
  endFrame: number;
  file: string;
  type: 'photo' | 'infographic' | 'overlay';
  scale?: number;
  position?: { x: number; y: number };
  opacity?: number;
  rotation?: number;
}
