import { clampBgm, projectBgm } from './bgmEngine';
import type { BgmClip, CutRegion, EditorBgmClip } from './types';

/**
 * BGM の再生導出の正本（プレビューと書き出しで共有 — 描き手は1つ）。
 * clampBgm→projectBgm の順で射影し、縮退区間（endFrame<=startFrame）を除外する。
 * 返り値は**単調再生座標**。ダッキング（プレビューのみ）・並び替え・最終座標化
 * （exportTimeline.attachAudio）は呼び出し側の責務。
 */
export function deriveBgmPlayback(
  bgm: readonly EditorBgmClip[],
  cutRegions: CutRegion[],
): BgmClip[] {
  const { bgm: clamped } = clampBgm([...bgm], cutRegions);
  return projectBgm(clamped, cutRegions).filter((c) => c.endFrame > c.startFrame);
}
