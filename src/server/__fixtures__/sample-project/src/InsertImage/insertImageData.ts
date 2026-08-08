import { FPS } from '../videoConfig';
import type { ImageSegment } from './types';

const toFrame = (sec: number) => Math.floor(sec * FPS);

// ==== 挿入画像配置データ ====
export const insertImageData: ImageSegment[] = [
  { id: 1, startFrame: toFrame(1.0), endFrame: toFrame(3.0), file: 'sample.png', type: 'photo' },
];
