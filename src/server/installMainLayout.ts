import { installNativeDataPack, isNativeDataPackInstalled } from './nativeDataPacks';
import { serializeMainLayoutData, formatColorGradeExport } from '../core/mainLayoutData';
import { DEFAULT_COLOR_GRADE, type ColorGrade } from '../core/colorGrade';
import type { MainLayout, SegmentLayout } from '../core/types';
import type { LayoutKeyframe } from '../core/layoutKeyframes';

export function isMainLayoutInstalled(dir: string): boolean {
  return isNativeDataPackInstalled('mainLayout', dir);
}

/** Data only: the native renderer owns layout, keys and color. */
export function installMainLayout(dir: string): { installed: boolean } {
  return installNativeDataPack('mainLayout', dir);
}

/** Keep required exports when saving an installed layout at its defaults. */
export function writeMainLayoutAlways(
  layout: MainLayout,
  segmentLayouts: Record<number, SegmentLayout> = {},
  layoutKeyframes: LayoutKeyframe[] = [],
  colorGrade: ColorGrade = DEFAULT_COLOR_GRADE,
): string {
  return (
    serializeMainLayoutData(layout, segmentLayouts, layoutKeyframes, colorGrade) ??
    `// Harness Editor が生成・更新します（メイン動画のレイアウト）\n\n` +
      `export const MAIN_LAYOUT = { position: { x: 0, y: 0 }, scale: 1, background: '#000000' };\n` +
      `export const SEGMENT_LAYOUTS: Record<number, { position: { x: number; y: number }; scale: number; rotation?: number; flipH?: boolean; flipV?: boolean }> = {  };\n` +
      `export const LAYOUT_KEYFRAMES: { originalFrame: number; x: number; y: number; scale: number; rotation: number }[] = [];\n` +
      formatColorGradeExport(colorGrade)
  );
}
