import { describe, it, expect } from 'vitest';
import {
  DEFAULT_COLOR_GRADE,
  applyColorGrade8,
  clampColorGradeValue,
  colorGradeMatrixValues,
  defaultColorGrade,
  isIdentityColorGrade,
  type ColorGrade,
} from './colorGrade';

const G = (p: Partial<ColorGrade>): ColorGrade => ({ ...DEFAULT_COLOR_GRADE, ...p });

describe('colorGrade — 既定は完全な素通し', () => {
  it('既定は恒等判定', () => {
    expect(isIdentityColorGrade(DEFAULT_COLOR_GRADE)).toBe(true);
    expect(isIdentityColorGrade(undefined)).toBe(true);
    expect(isIdentityColorGrade(null)).toBe(true);
  });

  it('1 つでも非ゼロなら恒等ではない', () => {
    for (const k of ['brightness', 'contrast', 'saturation', 'temperature'] as const) {
      expect(isIdentityColorGrade(G({ [k]: 1 }))).toBe(false);
      expect(isIdentityColorGrade(G({ [k]: -1 }))).toBe(false);
    }
  });

  it('既定の行列は恒等行列（書き出しの絵が 1 画素も変わらない）', () => {
    expect(colorGradeMatrixValues(DEFAULT_COLOR_GRADE)).toBe(
      '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0',
    );
  });

  it('既定では任意の画素が不変', () => {
    for (const px of [[0, 0, 0], [255, 255, 255], [12, 200, 77], [128, 128, 128]] as const) {
      expect(applyColorGrade8(DEFAULT_COLOR_GRADE, px)).toEqual([...px]);
    }
  });
});

describe('colorGrade — 値のクランプ', () => {
  it('NaN は 0、範囲外は端へ', () => {
    expect(clampColorGradeValue(Number.NaN)).toBe(0);
    expect(clampColorGradeValue(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampColorGradeValue(-999)).toBe(-100);
    expect(clampColorGradeValue(37)).toBe(37);
  });

  it('defaultColorGrade は毎回新しいオブジェクト（共有事故防止）', () => {
    const a = defaultColorGrade();
    a.brightness = 50;
    expect(defaultColorGrade().brightness).toBe(0);
  });
});

describe('colorGrade — 各パラメータの意味', () => {
  it('明るさ +100 は 2 倍・-100 は真っ黒', () => {
    expect(applyColorGrade8(G({ brightness: 100 }), [50, 60, 70])).toEqual([100, 120, 140]);
    expect(applyColorGrade8(G({ brightness: -100 }), [50, 60, 70])).toEqual([0, 0, 0]);
  });

  it('コントラストは中間 128 を軸に伸縮し、中間そのものは動かない', () => {
    expect(applyColorGrade8(G({ contrast: 50 }), [128, 128, 128])).toEqual([128, 128, 128]);
    // 0.25 → (0.25-0.5)*1.5+0.5 = 0.125
    expect(applyColorGrade8(G({ contrast: 50 }), [64, 64, 64])[0]).toBe(32);
    // -100 は全部が中間へ潰れる
    expect(applyColorGrade8(G({ contrast: -100 }), [0, 128, 255])).toEqual([128, 128, 128]);
  });

  it('彩度 -100 は白黒（3ch が輝度で揃う）', () => {
    const [r, g, b] = applyColorGrade8(G({ saturation: -100 }), [200, 40, 90]);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it('色温度 + は赤が上がり青が下がる／- はその逆・緑は不変', () => {
    const warm = applyColorGrade8(G({ temperature: 100 }), [100, 100, 100]);
    expect(warm[0]).toBe(130);
    expect(warm[1]).toBe(100);
    expect(warm[2]).toBe(70);
    const cool = applyColorGrade8(G({ temperature: -100 }), [100, 100, 100]);
    expect(cool[0]).toBe(70);
    expect(cool[1]).toBe(100);
    expect(cool[2]).toBe(130);
  });

  it('出力は 0..1 でクランプされる（オーバーフローで巻き戻らない）', () => {
    expect(applyColorGrade8(G({ brightness: 100 }), [250, 250, 250])).toEqual([255, 255, 255]);
  });
});

describe('colorGrade — 行列は feColorMatrix の 20 個', () => {
  it('20 個の数値・アルファ行は恒等', () => {
    const v = colorGradeMatrixValues(G({ brightness: 20, contrast: -10, saturation: 30, temperature: 15 }));
    const nums = v.split(' ');
    expect(nums).toHaveLength(20);
    for (const n of nums) expect(Number.isFinite(Number(n))).toBe(true);
    expect(nums.slice(15).join(' ')).toBe('0 0 0 1 0');
  });

  it('行列は CPU モデル（applyColorGrade8）と同じ変換を表す', () => {
    const g = G({ brightness: 20, contrast: -10, saturation: 30, temperature: 15 });
    const m = colorGradeMatrixValues(g).split(' ').map(Number);
    const px = [200, 90, 40] as const;
    const viaMatrix: number[] = [];
    for (let i = 0; i < 3; i++) {
      const row = m.slice(i * 5, i * 5 + 5);
      const v =
        row[0]! * (px[0] / 255) + row[1]! * (px[1] / 255) + row[2]! * (px[2] / 255) + row[4]!;
      viaMatrix.push(Math.round(Math.min(1, Math.max(0, v)) * 255));
    }
    expect(viaMatrix).toEqual(applyColorGrade8(g, px));
  });
});
