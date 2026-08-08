import { playbackToFinal, finalToPlayback } from '../core/transitionEngine';
import { speedScale, speedUnscale, playbackToSpeed, speedToPlayback } from '../core/speedEngine';
import type { PlaybackModel } from './playbackModel';

type SpeedView = Pick<PlaybackModel, 'speedSegments' | 'playbackOverlaps' | 'mainSpeed'>;

/**
 * 再生フレーム → プレイヤー（速度後）フレーム。
 * まず playbackToFinal（重なり・本スコープでは空＝恒等）、最後に速度段。
 * 個別速度ありは区分線形、無しは一律 speedScale（後方互換）。
 * 本スコープ（区間速度有効時 overlaps 空）では final==playback のため区間座標と整合する。
 */
export function playbackToPlayer(playbackFrame: number, model: SpeedView): number {
  const final = playbackToFinal(playbackFrame, model.playbackOverlaps);
  if (model.speedSegments) return playbackToSpeed(final, model.speedSegments);
  return speedScale(final, model.mainSpeed);
}

/** プレイヤー（速度後）フレーム → 再生フレーム（playbackToPlayer の逆）。 */
export function playerToPlayback(playerFrame: number, model: SpeedView): number {
  const final = model.speedSegments
    ? speedToPlayback(playerFrame, model.speedSegments)
    : speedUnscale(playerFrame, model.mainSpeed);
  return finalToPlayback(final, model.playbackOverlaps);
}
