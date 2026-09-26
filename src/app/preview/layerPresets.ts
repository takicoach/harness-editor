import { SNAP_LINES } from './previewSnap';

/**
 * レイヤー（画像・図形・タイトルの `visual.layout.position`）の 3×3 基本配置。
 * 中心原点の正規化座標で、三分割の ±1/3。`sceneRenderer` の `translate(y*50%)` は +y が
 * 下向きなので、上段が y=-1/3。値は `previewSnap.ts` の `SNAP_LINES` と同じで、
 * 手でドラッグして吸着させた位置とボタンの位置が一致する。
 *
 * 字幕用の `positionPresets.ts`（下端基準・y 上=-1/中=-0.5/下=0）とは別物。混ぜない。
 */
// SNAP_LINES = [-1/3, 0, 1/3] から導出（3 要素であることを前提）
const [LOW, MID, HIGH] = SNAP_LINES as [number, number, number];
export const LAYER_POSITION_PRESETS: { x: number; y: number }[][] = [
  [{ x: LOW, y: LOW }, { x: MID, y: LOW }, { x: HIGH, y: LOW }],
  [{ x: LOW, y: MID }, { x: MID, y: MID }, { x: HIGH, y: MID }],
  [{ x: LOW, y: HIGH }, { x: MID, y: HIGH }, { x: HIGH, y: HIGH }],
];
