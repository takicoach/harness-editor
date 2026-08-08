import { describe, it, expect } from 'vitest';
import {
  fitContentRect,
  telopBoxRect,
  pointerToPosition,
  pointerToScale,
  videoInsertBoxRect,
  pointerToVideoInsertPosition,
  pointerToVideoInsertScale,
  clamp,
} from './overlayGeometry';

describe('clamp', () => {
  it('範囲内はそのまま、範囲外は端へ寄せる', () => {
    expect(clamp(0.5, -1, 1)).toBe(0.5);
    expect(clamp(2, -1, 1)).toBe(1);
    expect(clamp(-3, -1, 1)).toBe(-1);
  });
});

describe('fitContentRect', () => {
  it('縦長 composition を contain フィットして中央寄せする', () => {
    // comp 100x200 を stage 100x100 へ → scale 0.5、w50 h100、x25 y0。
    expect(fitContentRect(100, 100, 100, 200)).toEqual({ x: 25, y: 0, w: 50, h: 100 });
  });

  it('いずれかの寸法が 0 以下なら原点サイズ 0 を返す', () => {
    expect(fitContentRect(0, 100, 100, 200)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('telopBoxRect', () => {
  const content = { x: 0, y: 0, w: 100, h: 100 };
  // short(縦) は bottomFrac = 200/1920、vCoeff = 1 - 2*bottomFrac。
  const SHORT_BOTTOM = (200 / 1920) * 100;
  const SHORT_VCOEFF = (1 - 2 * (200 / 1920)) * 100;

  it('position(0,0)・scale 1 で箱の下端をテロップ下端（下端固定）へ合わせる', () => {
    // w = 100*0.76 = 76、h = 100*0.16 = 16、横中央(50)、下端 = 100 - bottomFrac。
    const box = telopBoxRect(content, { x: 0, y: 0 }, 1, 1080, 1920);
    expect(box.w).toBe(76);
    expect(box.h).toBeCloseTo(16, 6);
    expect(box.x).toBe(12);
    expect(box.y + box.h).toBeCloseTo(100 - SHORT_BOTTOM, 6); // 箱の下端＝テロップ下端
  });

  it('position.x=1 で中心が content 右端へ寄る', () => {
    const box = telopBoxRect(content, { x: 1, y: 0 }, 1, 1080, 1920);
    expect(box.x + box.w / 2).toBe(100);
  });

  it('position.y=-1 で箱が縦係数ぶん上へ動く（上端＝下端と対称の余白）', () => {
    const base = telopBoxRect(content, { x: 0, y: 0 }, 1, 1080, 1920);
    const up = telopBoxRect(content, { x: 0, y: -1 }, 1, 1080, 1920);
    expect(up.y).toBeCloseTo(base.y - SHORT_VCOEFF, 6);
    // y=-1 で箱の下端が上端側の余白（= bottomFrac）に来る。
    expect(up.y + up.h).toBeCloseTo(SHORT_BOTTOM, 6);
  });

  it('scale は下端固定で上へ伸ばす（箱の下端は不変）', () => {
    const base = telopBoxRect(content, { x: 0, y: 0 }, 1, 1080, 1920);
    const big = telopBoxRect(content, { x: 0, y: 0 }, 2, 1080, 1920);
    expect(big.w).toBe(152);
    expect(big.h).toBeCloseTo(32, 6);
    expect(big.y + big.h).toBeCloseTo(base.y + base.h, 6); // 下端不変
  });
});

describe('pointerToPosition', () => {
  const content = { x: 0, y: 0, w: 100, h: 100 };
  const SHORT_VCOEFF = 1 - 2 * (200 / 1920);

  it('横移動は中心 50% 係数で正規化 position へ変換する', () => {
    expect(pointerToPosition(content, { x: 0, y: 0 }, 50, 0, 1080, 1920)).toEqual({ x: 1, y: 0 });
  });

  it('縦移動は縦係数で 1:1 追従する（上方向）', () => {
    const dy = -SHORT_VCOEFF * content.h; // y=-1 になる移動量
    expect(pointerToPosition(content, { x: 0, y: 0 }, 0, dy, 1080, 1920).y).toBeCloseTo(-1, 6);
  });

  it('上方向は -1 までクランプ', () => {
    expect(pointerToPosition(content, { x: 0, y: 0 }, 200, -200, 1080, 1920)).toEqual({ x: 1, y: -1 });
  });

  it('下方向（y>0）は 0 でクランプ（テロップは下端より下げない）', () => {
    expect(pointerToPosition(content, { x: 0, y: 0 }, 0, 200, 1080, 1920)).toEqual({ x: 0, y: 0 });
  });
});

describe('pointerToScale', () => {
  it('中心からの距離比でスケールを求める', () => {
    // 中心(0,0)・角(10,0)・ポインタ(20,0)・開始 1 → 2 倍。
    expect(pointerToScale(0, 0, 10, 0, 20, 0, 1)).toBe(2);
  });

  it('結果は [0.3,3.0] へクランプされる', () => {
    expect(pointerToScale(0, 0, 10, 0, 100, 0, 1)).toBe(3);
    expect(pointerToScale(0, 0, 10, 0, 1, 0, 1)).toBe(0.3);
  });
});

describe('videoInsertBoxRect', () => {
  it('position 0・scale 1 は content と一致', () => {
    expect(videoInsertBoxRect({ x: 0, y: 0, w: 100, h: 200 }, { x: 0, y: 0 }, 1))
      .toEqual({ x: 0, y: 0, w: 100, h: 200 });
  });
  it('position は中心から±半分、scale は中心基準', () => {
    // content{0,0,100,200}, position{x:1,y:0}, scale 0.5
    // w=50, h=100, cx=0+50+(1*100)/2=100, cy=0+100+0=100 → x=100-25=75, y=100-50=50
    expect(videoInsertBoxRect({ x: 0, y: 0, w: 100, h: 200 }, { x: 1, y: 0 }, 0.5))
      .toEqual({ x: 75, y: 50, w: 50, h: 100 });
  });
});

describe('pointerToVideoInsertPosition', () => {
  it('両軸 1:1・[-1,1] クランプ', () => {
    const c = { x: 0, y: 0, w: 100, h: 200 };
    expect(pointerToVideoInsertPosition(c, { x: 0, y: 0 }, 50, 100)).toEqual({ x: 1, y: 1 });
    expect(pointerToVideoInsertPosition(c, { x: 0, y: 0 }, 100, 200)).toEqual({ x: 1, y: 1 }); // クランプ
  });
});

describe('pointerToVideoInsertScale', () => {
  it('距離比でスケール・[0.1,5] クランプ', () => {
    expect(pointerToVideoInsertScale(0, 0, 3, 4, 6, 8, 1)).toBeCloseTo(2);
    expect(pointerToVideoInsertScale(0, 0, 3, 4, 30, 40, 1)).toBe(5); // クランプ
  });
});
