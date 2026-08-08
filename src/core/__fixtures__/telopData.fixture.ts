export const TELOP_DATA_SOURCE = `import type { TelopSegment } from './telopTypes';
import { FPS as CONFIG_FPS, DURATION_FRAMES } from '../videoConfig';

// ===== テロップデータ =====
// /video-harness:telop で自動生成されます

export const FPS = CONFIG_FPS;
export const TOTAL_FRAMES = DURATION_FRAMES;

export const telopData: TelopSegment[] = [
  {
    id: 1,
    startFrame: 30,
    endFrame: 150,
    text: "ゆる素振り\\nご紹介いたします",
    style: "emphasis",
    template: 1,
    animation: "slideIn",
    highlight: "ゆる素振り",
  },
  {
    id: 2,
    startFrame: 200,
    endFrame: 320,
    text: "長いアイアン2本ですね",
    style: "normal",
    template: 2,
    animation: "fadeOnly",
    highlight: "",
  },
];
`;
