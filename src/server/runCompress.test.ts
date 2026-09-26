/**
 * runCompress.ts のユニットテスト。
 * - normalizeRgba: A=0 画素の RGB ゼロ化・A>0 は無変換・入力非破壊
 *
 * I-1（正本統一）: run 圧縮そのもの（旧 compressRuns のバッチ版）はここから削除した。
 * production 経路の正本は captureDriver.ts の逐次比較ロジックであり、その run 分割・
 * endFrame 排他・書き出し伝播の pin は captureDriver.test.ts が担う（判断根拠は
 * runCompress.ts 冒頭の doc）。
 */

import { describe, expect, it } from 'vitest';
import { normalizeRgba, type RgbaFrame } from './runCompress';

function frame(width: number, height: number, data: number[]): RgbaFrame {
  return { width, height, data: Uint8Array.from(data) };
}

// ---------------------------------------------------------------------------
// normalizeRgba
// ---------------------------------------------------------------------------

describe('normalizeRgba', () => {
  it('A=0 の画素は RGB が異なっていても正規化後に一致する', () => {
    const f1 = frame(1, 1, [10, 20, 30, 0]);
    const f2 = frame(1, 1, [200, 210, 220, 0]);
    const n1 = normalizeRgba(f1);
    const n2 = normalizeRgba(f2);
    expect(Array.from(n1)).toEqual([0, 0, 0, 0]);
    expect(Array.from(n2)).toEqual([0, 0, 0, 0]);
  });

  it('A=1（ほぼ不透明）では1bit の RGB 差でも正規化後に一致しない', () => {
    const f1 = frame(1, 1, [10, 20, 30, 1]);
    const f2 = frame(1, 1, [11, 20, 30, 1]);
    const n1 = normalizeRgba(f1);
    const n2 = normalizeRgba(f2);
    expect(Array.from(n1)).not.toEqual(Array.from(n2));
    expect(Array.from(n1)).toEqual([10, 20, 30, 1]);
  });

  it('入力バッファを破壊しない', () => {
    const f = frame(1, 1, [10, 20, 30, 0]);
    const before = Array.from(f.data);
    normalizeRgba(f);
    expect(Array.from(f.data)).toEqual(before);
  });
});
