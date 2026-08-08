import type { TelopSegment } from './telopTypes';
import { FPS as CONFIG_FPS, DURATION_FRAMES } from '../videoConfig';

// ===== テロップデータ =====
// /video-harness:telop で自動生成されます

export const FPS = CONFIG_FPS;
export const TOTAL_FRAMES = DURATION_FRAMES;

export const telopData: TelopSegment[] = [
  // サンプル:
  // {
  //   id: 1,
  //   startFrame: 0,
  //   endFrame: 100,
  //   text: "サンプルテキスト",
  //   style: "normal",
  //   highlight: "",
  //   animation: "fadeOnly",
  //   template: 2
  // },
];
