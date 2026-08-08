import { describe, it, expect } from 'vitest';
import { followScrollLeft, wheelAction, zoomAnchoredScrollLeft } from './timelineScroll';

describe('followScrollLeft', () => {
  // 可視幅 1000・anchor 0.45 → anchor 線は X=450。
  it('ヘッドが anchor 線より左なら 0（先頭は左から流れる）', () => {
    expect(followScrollLeft(100, 1000, 5000, 0.45)).toBe(0);
    expect(followScrollLeft(450, 1000, 5000, 0.45)).toBe(0);
  });

  it('anchor 線を越えるとヘッドを anchor 位置へ寄せる scrollLeft を返す', () => {
    // playheadX 1450 → desired = 1450 - 450 = 1000。
    expect(followScrollLeft(1450, 1000, 5000, 0.45)).toBe(1000);
  });

  it('末尾では scrollWidth - clientWidth でクランプ（行き過ぎない）', () => {
    // max = 5000 - 1000 = 4000。desired = 4900 - 450 = 4450 → 4000 にクランプ。
    expect(followScrollLeft(4900, 1000, 5000, 0.45)).toBe(4000);
  });

  it('コンテンツが可視幅以下なら常に 0（スクロール不要）', () => {
    expect(followScrollLeft(900, 1000, 800, 0.45)).toBe(0);
  });
});

describe('zoomAnchoredScrollLeft', () => {
  // ガター 88・可視幅 1000。アンカーはコンテンツ X=1088（＝ガター右 1000px の位置）を
  // 画面左から 400px の所で掴んでいる状態（scrollLeft は 688）。
  const base = { anchorContentX: 1088, viewportOffset: 400, gutter: 88, clientWidth: 1000, scrollWidth: 100000 };

  it('2 倍ズームでもアンカーは画面上の同じ位置に留まる', () => {
    // ガター右の距離 1000 → 2000。アンカーのコンテンツ X は 2088。
    // 画面左から 400px に留めるので scrollLeft = 2088 - 400 = 1688。
    expect(zoomAnchoredScrollLeft({ ...base, ratio: 2 })).toBe(1688);
  });

  it('0.5 倍ズームでもアンカーは画面上の同じ位置に留まる', () => {
    // 1000 → 500。アンカー 588 − 400 = 188。
    expect(zoomAnchoredScrollLeft({ ...base, ratio: 0.5 })).toBe(188);
  });

  it('ratio=1 なら現在のスクロール位置を保つ', () => {
    expect(zoomAnchoredScrollLeft({ ...base, ratio: 1 })).toBe(688);
  });

  it('先頭付近では負にならず 0 でクランプ', () => {
    expect(zoomAnchoredScrollLeft({ ...base, anchorContentX: 100, viewportOffset: 400, ratio: 0.5 })).toBe(0);
  });

  it('末尾では scrollWidth - clientWidth でクランプ', () => {
    // 縮小後の全幅が可視幅を少ししか超えない場合。
    expect(zoomAnchoredScrollLeft({ ...base, ratio: 2, scrollWidth: 1500 })).toBe(500);
  });
});

describe('wheelAction', () => {
  const base = { ctrlKey: false, metaKey: false, shiftKey: false, deltaX: 0, deltaY: 0 };

  it('Ctrl＋上ホイールはズームイン（factor>1）', () => {
    expect(wheelAction({ ...base, ctrlKey: true, deltaY: -10 })).toEqual({ kind: 'zoom', factor: 1.2 });
  });

  it('Cmd＋下ホイールはズームアウト（factor<1）', () => {
    const a = wheelAction({ ...base, metaKey: true, deltaY: 10 });
    expect(a.kind).toBe('zoom');
    expect(a.kind === 'zoom' && a.factor).toBeCloseTo(1 / 1.2);
  });

  it('Shift＋縦ホイールは横パン（縦量を dx へ）', () => {
    expect(wheelAction({ ...base, shiftKey: true, deltaY: 40 })).toEqual({ kind: 'pan', dx: 40 });
  });

  it('素の縦ホイールは native（縦スクロールに委ねる＝下が下）', () => {
    expect(wheelAction({ ...base, deltaY: 40 })).toEqual({ kind: 'native' });
  });

  it('横スワイプ（deltaX 主体）は native（ブラウザ標準の横スクロール）', () => {
    expect(wheelAction({ ...base, deltaX: 40, deltaY: 2 })).toEqual({ kind: 'native' });
  });
});
