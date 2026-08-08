import { describe, it, expect } from 'vitest';
import {
  scaleStartEnd, unscaleStartEnd, scaleSe, unscaleSe, scaleVideoInserts, unscaleVideoInserts,
} from './speedProject';
import {
  segmentRateAt,
  scaleStartEndPiecewise, unscaleStartEndPiecewise,
  scaleSePiecewise, unscaleSePiecewise,
  scaleVideoInsertsPiecewise, unscaleVideoInsertsPiecewise,
} from './speedProject';
import type { SpeedSegment } from './speedEngine';

/** サブ動画テスト用の最小型（playbackRate は任意＝実データと同じ）。 */
type Vi = { startFrame: number; endFrame: number; sourceInFrame: number; playbackRate?: number };

describe('speedProject', () => {
  it('scaleStartEnd: rate=1 は同一参照・0.5x で 2 倍・他フィールド不変', () => {
    const a = [{ startFrame: 100, endFrame: 200, originalStart: 7, text: 'x' }];
    expect(scaleStartEnd(a, 1)).toBe(a);
    const s = scaleStartEnd(a, 0.5);
    expect(s[0]).toMatchObject({ startFrame: 200, endFrame: 400, originalStart: 7, text: 'x' });
  });
  it('unscaleStartEnd は scaleStartEnd の逆（往復恒等・整数）', () => {
    const a = [{ startFrame: 100, endFrame: 250 }];
    expect(unscaleStartEnd(scaleStartEnd(a, 0.5), 0.5)).toEqual(a);
    expect(unscaleStartEnd(scaleStartEnd(a, 2), 2)).toEqual(a);
  });
  it('scaleSe: endFrame 省略可（undefined はそのまま）', () => {
    expect(scaleSe([{ startFrame: 100 }], 0.5)).toEqual([{ startFrame: 200 }]);
    expect(scaleSe([{ startFrame: 100, endFrame: 150 }], 0.5)).toEqual([{ startFrame: 200, endFrame: 300 }]);
    const a = [{ startFrame: 1 }];
    expect(scaleSe(a, 1)).toBe(a);
  });
  it('unscaleSe は scaleSe の逆（endFrame あり/なし両方往復・rate=1 同一参照）', () => {
    const withEnd = [{ startFrame: 100, endFrame: 200 }];
    expect(unscaleSe(scaleSe(withEnd, 0.5), 0.5)).toEqual(withEnd);
    const noEnd = [{ startFrame: 100 }];
    expect(unscaleSe(scaleSe(noEnd, 0.5), 0.5)).toEqual(noEnd);
    const a = [{ startFrame: 1 }];
    expect(unscaleSe(a, 1)).toBe(a);
  });
  it('scaleVideoInserts: startFrame/endFrame は scale、playbackRate は own×rate、sourceInFrame 不変', () => {
    const a = [{ startFrame: 100, endFrame: 200, sourceInFrame: 30, playbackRate: 2 }];
    expect(scaleVideoInserts(a, 0.5)).toEqual([{ startFrame: 200, endFrame: 400, sourceInFrame: 30, playbackRate: 1 }]);
    // playbackRate 未指定は own=1 として rate を書き、逆変換で undefined（未指定=1）へ戻る
    const b: Vi[] = [{ startFrame: 100, endFrame: 200, sourceInFrame: 0 }];
    const sb = scaleVideoInserts(b, 0.5);
    expect(sb[0]?.playbackRate).toBe(0.5);
    expect(unscaleVideoInserts(sb, 0.5)[0]?.playbackRate).toBeUndefined();
  });
  it('scaleVideoInserts: rate=1 は同一参照・playbackRate 未指定を追加しない（バイト同値）', () => {
    const a: Vi[] = [{ startFrame: 100, endFrame: 200, sourceInFrame: 0 }];
    expect(scaleVideoInserts(a, 1)).toBe(a);
    expect(scaleVideoInserts(a, 1)[0]?.playbackRate).toBeUndefined();
  });
  it('unscaleVideoInserts は scaleVideoInserts の逆（own を復元）', () => {
    const a = [{ startFrame: 100, endFrame: 200, sourceInFrame: 30, playbackRate: 2 }];
    expect(unscaleVideoInserts(scaleVideoInserts(a, 0.5), 0.5)).toEqual(a);
  });
});

// 区間A: playback[0,100) rate=0.5（尺200へ） / 区間B: playback[100,160) rate=2（尺30へ）
const SEGS: SpeedSegment[] = [
  { id: 1, start: 0, end: 100, rate: 0.5 },
  { id: 2, start: 100, end: 160, rate: 2 },
];

describe('speedProject piecewise (per-segment Plan 2)', () => {
  it('segmentRateAt: 区間内は自区間 rate・区間外は最後の区間 rate', () => {
    expect(segmentRateAt(0, SEGS)).toBe(0.5);
    expect(segmentRateAt(99, SEGS)).toBe(0.5);
    expect(segmentRateAt(100, SEGS)).toBe(2);
    expect(segmentRateAt(159, SEGS)).toBe(2);
    expect(segmentRateAt(999, SEGS)).toBe(2); // 範囲外＝末尾
  });
  it('scaleStartEndPiecewise: 区間Aの要素は ×2、区間Bの要素は区間A尺(200)+局所×0.5', () => {
    // playback 50（区間A中間）→ round(50/0.5)=100
    // playback 130（区間B中間, B内オフセット30）→ 200 + round(30/2)=215
    const a = [{ startFrame: 50, endFrame: 130, originalStart: 7 }];
    const s = scaleStartEndPiecewise(a, SEGS);
    expect(s[0]).toMatchObject({ startFrame: 100, endFrame: 215, originalStart: 7 });
  });
  it('unscaleStartEndPiecewise は scaleStartEndPiecewise の逆（往復 ±1）', () => {
    const a = [{ startFrame: 50, endFrame: 130 }];
    const round = unscaleStartEndPiecewise(scaleStartEndPiecewise(a, SEGS), SEGS);
    expect(Math.abs(round[0]!.startFrame - 50)).toBeLessThanOrEqual(1);
    expect(Math.abs(round[0]!.endFrame - 130)).toBeLessThanOrEqual(1);
  });
  it('scaleSePiecewise / unscaleSePiecewise: endFrame 省略可（undefined はそのまま）・往復 ±1', () => {
    expect(scaleSePiecewise([{ startFrame: 50 }], SEGS)).toEqual([{ startFrame: 100 }]);
    expect(scaleSePiecewise([{ startFrame: 50, endFrame: 130 }], SEGS))
      .toEqual([{ startFrame: 100, endFrame: 215 }]);
    // unscale roundtrip
    const c = [{ startFrame: 50, endFrame: 130 }];
    const rc = unscaleSePiecewise(scaleSePiecewise(c, SEGS), SEGS);
    expect(Math.abs(rc[0]!.startFrame - 50)).toBeLessThanOrEqual(1);
    expect(Math.abs(rc[0]!.endFrame! - 130)).toBeLessThanOrEqual(1);
  });
  it('scaleVideoInsertsPiecewise: playbackRate は own × 開始区間 rate、sourceInFrame 不変', () => {
    // 区間A(rate=0.5)で始まるサブ動画・own=2 → 2*0.5=1
    const a = [{ startFrame: 50, endFrame: 90, sourceInFrame: 30, playbackRate: 2 }];
    const s = scaleVideoInsertsPiecewise(a, SEGS);
    expect(s[0]).toMatchObject({ sourceInFrame: 30, playbackRate: 1 });
    expect(s[0]!.startFrame).toBe(100);
  });
  it('unscaleVideoInsertsPiecewise は own を復元（own=1 は undefined）', () => {
    const a = [{ startFrame: 50, endFrame: 90, sourceInFrame: 30, playbackRate: 2 }];
    const round = unscaleVideoInsertsPiecewise(scaleVideoInsertsPiecewise(a, SEGS), SEGS);
    expect(round[0]!.playbackRate).toBe(2);
    // own 未指定（=1）は逆変換で undefined
    const b: { startFrame: number; endFrame: number; sourceInFrame: number; playbackRate?: number }[] = [{ startFrame: 50, endFrame: 90, sourceInFrame: 0 }];
    const sb = scaleVideoInsertsPiecewise(b, SEGS);
    expect(sb[0]!.playbackRate).toBe(0.5); // own=1 * 0.5
    expect(unscaleVideoInsertsPiecewise(sb, SEGS)[0]!.playbackRate).toBeUndefined();
  });
});
