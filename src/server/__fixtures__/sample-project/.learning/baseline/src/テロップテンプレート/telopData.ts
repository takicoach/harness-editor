import type { TelopSegment } from './telopTypes';
import { FPS as CONFIG_FPS, DURATION_FRAMES } from '../videoConfig';

export const FPS = CONFIG_FPS;
export const TOTAL_FRAMES = DURATION_FRAMES;

export const telopData: TelopSegment[] = [
  {
    id: 1,
    startFrame: 30,
    endFrame: 150,
    text: "ゆる素振り",
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
  },
  {
    id: 3,
    startFrame: 6000,
    endFrame: 6100,
    text: "つなぎ目より後ろのテロップ",
    style: "normal",
    template: 1,
    animation: "fadeOnly",
  },
];
