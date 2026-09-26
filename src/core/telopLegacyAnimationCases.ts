/** 既存 9 種の数値パリティ用の走査表（共有式領域の**外**。写しには含めない）。 */
import type { LegacyTelopAnimationId } from './telopLegacyAnimation';

const IDS: readonly LegacyTelopAnimationId[] =
  ['none', 'slideIn', 'fadeOnly', 'slideFromLeft', 'fadeBlurFromBottom',
   'slideLeftFadeBlur', 'fadeFromRight', 'fadeFromLeft', 'charByChar'];

/** 標準尺 120fr と短尺 7fr（duration/3 でフェードが潰れる経路）。fps は spring の依存先。 */
export const LEGACY_TELOP_ANIMATION_CASES: ReadonlyArray<{
  id: LegacyTelopAnimationId; durationFrames: number; fps: number;
}> = IDS.flatMap(id =>
  [120, 7].flatMap(durationFrames =>
    [30, 59.94].map(fps => ({ id, durationFrames, fps }))));

/**
 * 走査点は**尺相対**に導出する。固定の `-2..24` だと尺 120 で退場窓（`duration - max(1, fadeOut)`
 * の折れ点）にも終端 clamp にも上限外にも 1 点も当たらず、`packLegacyTelopAnimationFrame` の
 * `localFrame > durationFrames → null` 分岐がどの parity でも実行されない（レビュー Important 1）。
 *
 * - 前半 `-2..12`: 下限外の clamp・入場窓（fadeIn は最大 10）・入場直後の中間。
 * - 後半 `duration-12 .. duration+2`: 中間の出口・退場窓（fadeOut は最大 10）・終端・上限外。
 *
 * 短尺 7 では 2 区間が重なるので、重複を除いて昇順に並べ直す（尺 7 は `-5..12` の 18 点、
 * 尺 120 は `-2..12` と `108..122` の 30 点）。
 */
export const legacyTelopAnimationCaseFrames = (durationFrames: number): readonly number[] => {
  const entry = Array.from({ length: 15 }, (_, index) => index - 2);
  const exit = Array.from({ length: 15 }, (_, index) => durationFrames - 12 + index);
  return [...new Set([...entry, ...exit])].sort((a, b) => a - b);
};
