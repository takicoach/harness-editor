/** 効果音クリップの長さが不明（ロード前/デコード失敗）のときに使う仮幅（フレーム）。 */
export const SE_FALLBACK_FRAMES = 8;

/**
 * 音源の長さ（秒）からクリップのフレーム数を求める。
 * 長さが不明（null/非有限/0以下）または fps<=0 なら fallbackFrames を返す。
 */
export function clipFramesFromDuration(
  durationSec: number | null,
  fps: number,
  fallbackFrames: number,
): number {
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return fallbackFrames;
  }
  if (fps <= 0) return fallbackFrames;
  return Math.max(1, Math.round(durationSec * fps));
}
