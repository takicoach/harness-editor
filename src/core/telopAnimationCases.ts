import { NEW_TELOP_ANIMATION_IDS, type NewTelopAnimationId } from './telopAnimation';

/**
 * 「core と案件テンプレートの写しが同じ式か」を全点で比べるための走査表。
 * 設計 §5: 8 種 × localFrame 0..36 × fps {30,60} × fontSize {40,80} × charCount {1,12,60}。
 * この表だけでは「写しが同じ」ことしか示せないので、必ず Task 16 の描画検証と対にする。
 */
export interface TelopAnimationCase {
  id: NewTelopAnimationId;
  fps: number;
  fontSizePx: number;
  charCount: number;
  durationFrames: number;
}

export const TELOP_ANIMATION_CASE_FRAMES: readonly number[] =
  Array.from({ length: 37 }, (_, index) => index);

export const TELOP_ANIMATION_CASES: readonly TelopAnimationCase[] =
  NEW_TELOP_ANIMATION_IDS.flatMap(id =>
    [30, 60].flatMap(fps =>
      [40, 80].flatMap(fontSizePx =>
        [1, 12, 60].flatMap(charCount =>
          // 通常尺と、縮退が効く短尺の両方を走らせる
          [90, 12].map(durationFrames => ({ id, fps, fontSizePx, charCount, durationFrames }))))));
