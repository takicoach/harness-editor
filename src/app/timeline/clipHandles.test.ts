import { describe, expect, it } from 'vitest';
import { clipHandleWidth, clipHandleStyle, MIN_HANDLE_CLIP_WIDTH_PX } from './clipHandles';

describe('clipHandleWidth（監査 interaction-4）', () => {
  it('極小クリップ（4px）ではつまみを描かない', () => {
    expect(clipHandleWidth(4, 10)).toBeNull();
    expect(clipHandleWidth(4, 6)).toBeNull();
  });

  it('しきい値の境界: 23px は描かない / 24px は描く', () => {
    expect(MIN_HANDLE_CLIP_WIDTH_PX).toBe(24);
    expect(clipHandleWidth(23, 10)).toBeNull();
    expect(clipHandleWidth(24, 10)).toBe(8);
  });

  it('十分広ければ自然幅のまま（従来と同じ見た目）', () => {
    expect(clipHandleWidth(300, 10)).toBe(10);
    expect(clipHandleWidth(300, 6)).toBe(6);
  });

  it('狭いときは幅の 1/3 まで縮める（自然幅を超えない）', () => {
    expect(clipHandleWidth(27, 10)).toBe(9);
    expect(clipHandleWidth(27, 6)).toBe(6);
  });

  it('不変条件: つまみ 2 つの合計はクリップ幅の 2/3 以下＝本体が必ず 1/3 露出する', () => {
    for (let w = MIN_HANDLE_CLIP_WIDTH_PX; w <= 200; w++) {
      for (const natural of [6, 10]) {
        const h = clipHandleWidth(w, natural);
        expect(h).not.toBeNull();
        expect((h as number) * 2).toBeLessThanOrEqual((w * 2) / 3);
      }
    }
  });

  it('NaN・負値は null（描かない側へ倒す）', () => {
    expect(clipHandleWidth(Number.NaN, 10)).toBeNull();
    expect(clipHandleWidth(-5, 10)).toBeNull();
  });
});

describe('clipHandleStyle', () => {
  it('はみ出し量は幅の半分（自然幅 10 なら従来の ±5px と一致）', () => {
    expect(clipHandleStyle(10, 'start')).toEqual({ width: 10, left: -5 });
    expect(clipHandleStyle(10, 'end')).toEqual({ width: 10, right: -5 });
  });

  it('縮めたつまみは、はみ出しも縮む（CSS の決め打ちを上書きする）', () => {
    expect(clipHandleStyle(8, 'start')).toEqual({ width: 8, left: -4 });
    expect(clipHandleStyle(6, 'end')).toEqual({ width: 6, right: -3 });
  });
});

describe('clipHandleStyle（null＝描かない）', () => {
  it('null は display:none（DOM に残すがヒットテスト対象から外れる）', () => {
    expect(clipHandleStyle(null, 'start')).toEqual({ display: 'none' });
    expect(clipHandleStyle(null, 'end')).toEqual({ display: 'none' });
  });

  it('極小クリップ（4px）は両端とも非表示＝本体が必ず掴める', () => {
    const w = clipHandleWidth(4, 10);
    expect(clipHandleStyle(w, 'start')).toEqual({ display: 'none' });
    expect(clipHandleStyle(w, 'end')).toEqual({ display: 'none' });
  });
});
