import { FPS } from '../videoConfig';
import type { ImageSegment } from './types';

const toFrame = (sec: number) => Math.floor(sec * FPS);

// ==== 挿入画像配置データ ====
export const insertImageData: ImageSegment[] = [
  {
    id: 1,
    startFrame: 60,
    endFrame: 180,
    file: "sample.png",
    type: "photo",
  },
];
