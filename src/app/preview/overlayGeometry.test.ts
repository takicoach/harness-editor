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
  telopAnchorFrac,
} from './overlayGeometry';
import { telopScaleOriginY } from '../../preview/telopLayout';

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

  // --- プリセット実値（TELOP_CONFIG.bottomOffset）への枠アンカー追従 ---
  // golf-short-gold は bottomOffset=540（標準 short=200）。枠が実描画テキストより
  // 約 340px 下に出る不具合の回帰テスト。
  it('bottomOffset=540 を渡すと箱の下端が (1 - 540/1920) の位置へ来る', () => {
    const box = telopBoxRect(content, { x: 0, y: 0 }, 1, 1080, 1920, 540);
    expect(box.y + box.h).toBeCloseTo(100 * (1 - 540 / 1920), 6);
    // 標準アンカー（200/1920）より上にある＝実描画テキストへ寄る。
    const std = telopBoxRect(content, { x: 0, y: 0 }, 1, 1080, 1920);
    expect(box.y + box.h).toBeLessThan(std.y + std.h);
  });

  it('bottomOffset を渡しても移動量係数（vCoeff）は標準固定のまま（書き出し一致契約）', () => {
    // y=-1 の移動量は標準 vCoeff ぶん。アンカーだけがズレる。
    const base = telopBoxRect(content, { x: 0, y: 0 }, 1, 1080, 1920, 540);
    const up = telopBoxRect(content, { x: 0, y: -1 }, 1, 1080, 1920, 540);
    expect(base.y - up.y).toBeCloseTo(SHORT_VCOEFF, 6);
  });

  // 実描画は「全画面ラッパーへ scale を当て、transformOrigin Y は標準固定 (1 - 200/1920)」
  // （EditorComposition.TelopLayer / プロジェクト側 TelopPlayer.tsx が同式）。
  // 標準プロジェクトは origin == テキスト下端なので拡縮で下端が動かないが、
  // golf-short-gold（540）は origin ≠ 下端なので拡縮で実テキスト下端が動く。枠も追従させる。
  const ORIGIN_FRAC = 1 - 200 / 1920; // 標準固定の transformOrigin Y
  const GOLD_ANCHOR_FRAC = 1 - 540 / 1920; // gold のテキスト下端

  it('bottomOffset=540・scale=2 で枠下端が実描画テキスト下端（origin 基準の拡縮後）と一致する', () => {
    const expected = 100 * (ORIGIN_FRAC + (GOLD_ANCHOR_FRAC - ORIGIN_FRAC) * 2);
    const box = telopBoxRect(content, { x: 0, y: 0 }, 2, 1080, 1920, 540);
    expect(box.y + box.h).toBeCloseTo(expected, 6);
    // 拡大で実テキストは上がる（origin より下にあるため）。
    expect(box.y + box.h).toBeLessThan(100 * GOLD_ANCHOR_FRAC);
  });

  it('bottomOffset=540・scale=0.5 でも実描画テキスト下端と一致する（縮小は下がる）', () => {
    const expected = 100 * (ORIGIN_FRAC + (GOLD_ANCHOR_FRAC - ORIGIN_FRAC) * 0.5);
    const box = telopBoxRect(content, { x: 0, y: 0 }, 0.5, 1080, 1920, 540);
    expect(box.y + box.h).toBeCloseTo(expected, 6);
    expect(box.y + box.h).toBeGreaterThan(100 * GOLD_ANCHOR_FRAC);
  });

  it('標準プロジェクトでは scale を変えても従来値のまま（anchor === origin の恒等縮退）', () => {
    const y = -0.4;
    for (const s of [0.3, 0.5, 1, 2, 3]) {
      // 従来式（scale 非依存）: 下端 = h*(1 - bottomFrac + y*vCoeff)。
      const legacy = 100 * (1 - 200 / 1920 + y * (1 - (2 * 200) / 1920));
      const box = telopBoxRect(content, { x: 0, y }, s, 1080, 1920);
      expect(box.y + box.h).toBeCloseTo(legacy, 6);
      // 標準値 200 を実値として明示的に渡しても完全一致（フォールバック経路と同値）。
      expect(telopBoxRect(content, { x: 0, y }, s, 1080, 1920, 200)).toEqual(box);
      expect(telopBoxRect(content, { x: 0, y }, s, 1080, 1920, null)).toEqual(box);
    }
  });

  it('原点比は telopScaleOriginY（telopLayout の単一ソース）と一致する', () => {
    // 枠の拡縮原点は実描画の transformOrigin と同じ値でなければならない。
    // 定数を写経せず、正本（telopLayout.telopScaleOriginY）から突合する。
    const originFrac = telopScaleOriginY(1080, 1920) / 100;
    // scale=2・bottomOffset=540 の下端は origin + (anchor - origin)*2。
    const anchorFrac = 1 - 540 / 1920;
    const box = telopBoxRect(content, { x: 0, y: 0 }, 2, 1080, 1920, 540);
    expect(box.y + box.h).toBeCloseTo(100 * (originFrac + (anchorFrac - originFrac) * 2), 6);
    // 標準プロジェクトでは origin == anchor なので下端は origin そのもの（scale 不問）。
    const std = telopBoxRect(content, { x: 0, y: 0 }, 2.5, 1080, 1920);
    expect(std.y + std.h).toBeCloseTo(100 * originFrac, 6);
  });

  it('異常に大きい bottomOffset でもアンカー比は [0,1] にクランプされる', () => {
    // compH を超える値（99999）は 1 に張り付き、枠が画面上端より上へ暴走しない。
    const box = telopBoxRect(content, { x: 0, y: 0 }, 1, 1080, 1920, 99999);
    expect(box.y + box.h).toBeCloseTo(0, 6); // 1 - 1 = 0（content 上端）
    expect(telopAnchorFrac(1080, 1920, 99999)).toBe(1);
    expect(telopAnchorFrac(1080, 1920, 540)).toBeCloseTo(540 / 1920, 9);
  });

  it('null / undefined / 非数値 の bottomOffset は従来の標準アンカーへフォールバックする', () => {
    const std = telopBoxRect(content, { x: 0, y: 0 }, 1, 1080, 1920);
    expect(telopBoxRect(content, { x: 0, y: 0 }, 1, 1080, 1920, null)).toEqual(std);
    expect(telopBoxRect(content, { x: 0, y: 0 }, 1, 1080, 1920, undefined)).toEqual(std);
    expect(telopBoxRect(content, { x: 0, y: 0 }, 1, 1080, 1920, Number.NaN)).toEqual(std);
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
