import { describe, expect, it } from 'vitest';
import { BUILTIN_TELOP_ANIMATION_IDS, NEW_TELOP_ANIMATION_IDS } from '../../core/telopAnimation';
import { ANIMATION_CROP_MARGIN_PX, animationMotionBounds, animationSampleMargin, type TextBox } from './nativeSampleFit';

describe('animationMotionBounds', () => {
  it('stampPress は scale(2.2) から始まり（入場フレーム0で到達）、平行移動は伴わない', () => {
    expect(animationMotionBounds('stampPress', 64)).toEqual({ maxScale: 2.2, maxTranslatePx: 0 });
  });

  it('popIn は scale(1.15) 付近までオーバーシュートし、平行移動は伴わない', () => {
    const bounds = animationMotionBounds('popIn', 64);
    expect(bounds.maxScale).toBeGreaterThan(1.1);
    expect(bounds.maxScale).toBeLessThanOrEqual(1.15);
    expect(bounds.maxTranslatePx).toBe(0);
  });

  it('jumpPop は文字サイズに比例した平行移動（0.5 倍の付近）まで到達し、スケールは変えない', () => {
    const bounds = animationMotionBounds('jumpPop', 64);
    expect(bounds.maxTranslatePx).toBeGreaterThan(0.4 * 64);
    expect(bounds.maxTranslatePx).toBeLessThanOrEqual(0.5 * 64);
    expect(bounds.maxScale).toBe(1);
  });

  it('旧 9 種（none 以外）は NativeText の平行移動定数どおりで、スケールは変えない', () => {
    expect(animationMotionBounds('slideFromLeft', 64)).toEqual({ maxScale: 1, maxTranslatePx: 60 });
    expect(animationMotionBounds('slideIn', 64)).toEqual({ maxScale: 1, maxTranslatePx: 50 });
    expect(animationMotionBounds('fadeBlurFromBottom', 64)).toEqual({ maxScale: 1, maxTranslatePx: 40 });
    expect(animationMotionBounds('none', 64)).toEqual({ maxScale: 1, maxTranslatePx: 0 });
  });
});

describe('animationSampleMargin', () => {
  const box: TextBox = { left: 100, top: 200, width: 300, height: 80 };

  // レビュアーの裁定（再レビュー Needs fixes）: 静止時に他カードと同じ大きさで読めることを優先し、
  // scale は余白に含めない。再生中のピークの拡大は舞台の overflow:hidden で切れてよい。
  it('scale は余白に影響しない（stampPress の scale(2.2) でも従来の床 70px のまま）', () => {
    expect(animationSampleMargin('stampPress', box)).toBe(ANIMATION_CROP_MARGIN_PX);
  });

  it('箱の寸法を変えても、拡大系の動き（stampPress）の余白は変わらない（scale 非依存の確認）', () => {
    const bigger: TextBox = { ...box, width: 600, height: 200 };
    expect(animationSampleMargin('stampPress', bigger)).toBe(animationSampleMargin('stampPress', box));
  });

  it('translate の項は残る（jumpPop は文字サイズ比例の平行移動 + 10px 分、床の70pxを超える）', () => {
    const tall: TextBox = { ...box, height: 200 };   // jumpPop の translateY は box.height を fontSizePx の代わりに使う
    expect(animationSampleMargin('jumpPop', tall)).toBeGreaterThan(ANIMATION_CROP_MARGIN_PX);
  });

  it.each(BUILTIN_TELOP_ANIMATION_IDS)('旧 9 種（%s）は従来どおり 70px 以上になる', id => {
    expect(animationSampleMargin(id, box)).toBeGreaterThanOrEqual(ANIMATION_CROP_MARGIN_PX);
  });

  it.each(NEW_TELOP_ANIMATION_IDS)('新 8 種（%s）も常に 70px 以上になる（拡大・平行移動が無い動きでも床を割らない）', id => {
    expect(animationSampleMargin(id, box)).toBeGreaterThanOrEqual(ANIMATION_CROP_MARGIN_PX);
  });
});
