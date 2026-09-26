/**
 * プレビュー（NativeText / リポジトリ側）と書き出し（案件テンプレートの凍結部品）が同じ動きを
 * 描くことの土台。式が複製されている以上、片方だけ直す事故が起きうるので走査表の全点で
 * 数値一致を要求する。**これは「写しが同じ」ことしか示さない**ので、Task 16 の描画検証と対にする。
 */
import { describe, expect, it } from 'vitest';
import { telopAnimationEffect } from '../core/telopAnimation';
import { TELOP_ANIMATION_CASES, TELOP_ANIMATION_CASE_FRAMES } from '../core/telopAnimationCases';
import { telopAnimationEffect as templateEffect } from '../../project-template/src/テロップテンプレート/telopAnimationEffect';

describe('案件テンプレートの写しが core と同じ値を返す', () => {
  it('8 種 × frame 0..36 × fps {30,60} × fontSize {40,80} × charCount {1,12,60} の全点で一致', () => {
    let compared = 0, moved = 0;
    for (const item of TELOP_ANIMATION_CASES) {
      let previous: string | undefined;
      for (const localFrame of TELOP_ANIMATION_CASE_FRAMES) {
        const input = { ...item, localFrame };
        const core = telopAnimationEffect(input), copy = templateEffect(input);
        // toStrictEqual: 「キーが undefined」と「キーが無い」を同一視しない（Task 11 Minor）。
        expect(copy, `${item.id} fps=${item.fps} font=${item.fontSizePx} chars=${item.charCount} dur=${item.durationFrames} frame=${localFrame}`).toStrictEqual(core);
        const serialized = JSON.stringify(core);
        if (previous !== undefined && previous !== serialized) moved++;
        previous = serialized; compared++;
      }
    }
    expect(compared).toBe(TELOP_ANIMATION_CASES.length * TELOP_ANIMATION_CASE_FRAMES.length);
    // 値が実際に時間で動いている（null どうし・定数どうしを突き合わせていない）
    expect(moved).toBeGreaterThan(compared / 10);
  });

  it('既存 9 種はどちらも効果を持たない', () => {
    for (const id of ['none', 'slideIn', 'fadeOnly', 'charByChar'] as const) {
      const input = { id, localFrame: 4, durationFrames: 90, fps: 30, fontSizePx: 40, charCount: 8 };
      expect(telopAnimationEffect(input)).toBeNull();
      expect(templateEffect(input)).toBeNull();
    }
  });
});
