import { describe, it, expect } from 'vitest';
import {
  followScrollLeft,
  wheelAction,
  zoomAnchoredScrollLeft,
  edgeScrollVelocity,
  edgeScrollFrameScale,
  edgeScrollSpeed,
  edgeScrollZone,
  EDGE_ZONE_PX,
  MAX_EDGE_SCROLL_PX,
  MAX_EDGE_SCROLL_FRAME_SCALE,
} from './timelineScroll';

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

describe('edgeScrollVelocity（端ドラッグ自動スクロール・edge-autoscroll）', () => {
  // 可視域 [100, 1100]（幅 1000）。端ゾーンは左 [100,140] / 右 [1060,1100]。
  const L = 100;
  const R = 1100;

  it('定数は設計どおり（ゾーン 40px・最大 20px/フレーム）', () => {
    expect(EDGE_ZONE_PX).toBe(40);
    expect(MAX_EDGE_SCROLL_PX).toBe(20);
  });

  it('ゾーン外（中央）は 0＝スクロールしない', () => {
    expect(edgeScrollVelocity(600, L, R)).toBe(0);
  });

  it('ゾーン境界ちょうどは 0（ゾーンに入った瞬間は速度ゼロから始まる）', () => {
    expect(edgeScrollVelocity(L + EDGE_ZONE_PX, L, R)).toBe(0);
    expect(edgeScrollVelocity(R - EDGE_ZONE_PX, L, R)).toBe(0);
  });

  it('左端は負（左へスクロール）・端ちょうどで最大速度', () => {
    expect(edgeScrollVelocity(L, L, R)).toBe(-MAX_EDGE_SCROLL_PX);
  });

  it('右端は正（右へスクロール）・端ちょうどで最大速度', () => {
    expect(edgeScrollVelocity(R, L, R)).toBe(MAX_EDGE_SCROLL_PX);
  });

  it('深さに比例する（ゾーンの半分の深さなら半分の速度）', () => {
    expect(edgeScrollVelocity(L + EDGE_ZONE_PX / 2, L, R)).toBe(-MAX_EDGE_SCROLL_PX / 2);
    expect(edgeScrollVelocity(R - EDGE_ZONE_PX / 2, L, R)).toBe(MAX_EDGE_SCROLL_PX / 2);
  });

  it('可視域の外へ出ても最大速度でクランプ（暴走させない）', () => {
    expect(edgeScrollVelocity(L - 500, L, R)).toBe(-MAX_EDGE_SCROLL_PX);
    expect(edgeScrollVelocity(R + 500, L, R)).toBe(MAX_EDGE_SCROLL_PX);
  });

  it('可視域が端ゾーン 2 つ分より狭いときは近い方の端が勝つ', () => {
    // 幅 50（[0,50]）→ 左右のゾーンが重なる。x=10 は左端に近い＝負。
    expect(edgeScrollVelocity(10, 0, 50)).toBeLessThan(0);
    // x=40 は右端に近い＝正。
    expect(edgeScrollVelocity(40, 0, 50)).toBeGreaterThan(0);
  });

  it('非有限値・幅ゼロは 0（計測前でも壊れない）', () => {
    expect(edgeScrollVelocity(Number.NaN, L, R)).toBe(0);
    expect(edgeScrollVelocity(600, Number.NaN, R)).toBe(0);
    expect(edgeScrollVelocity(0, 0, 0)).toBe(0);
  });
});

describe('edgeScrollFrameScale（可変フレームレートの正規化）', () => {
  it('初回フレーム（前回時刻なし）は 1 倍', () => {
    expect(edgeScrollFrameScale(null)).toBe(1);
  });

  it('60Hz（16.67ms）はちょうど 1 倍＝速度定数の意味を変えない', () => {
    expect(edgeScrollFrameScale(1000 / 60)).toBe(1);
  });

  it('30Hz（33.3ms）は 2 倍＝実時間あたりのスクロール速度が揃う', () => {
    expect(edgeScrollFrameScale(1000 / 30)).toBeCloseTo(2, 10);
  });

  it('120Hz（8.33ms）は 0.5 倍＝高リフレッシュで倍速にならない', () => {
    expect(edgeScrollFrameScale(1000 / 120)).toBeCloseTo(0.5, 10);
  });

  it('タブ復帰などの巨大 dt は上限でクランプ（一気に飛ばさない）', () => {
    expect(edgeScrollFrameScale(5000)).toBe(MAX_EDGE_SCROLL_FRAME_SCALE);
    expect(MAX_EDGE_SCROLL_FRAME_SCALE).toBe(3);
  });

  it('0・負・非有限は 1 倍（計測不能時は等倍で素通し）', () => {
    expect(edgeScrollFrameScale(0)).toBe(1);
    expect(edgeScrollFrameScale(-16)).toBe(1);
    expect(edgeScrollFrameScale(Number.NaN)).toBe(1);
  });
});

describe('edgeScrollSpeed', () => {
  // 可視域 X=100..1100・Y=0..400、ガター 120、zone=80 明示 / maxSpeed=1600。
  const base = { rect: { left: 100, right: 1100, top: 0, bottom: 400 }, gutter: 120, pointerY: 200, zone: 80 };

  it('中央付近では 0（不用意に動かない）', () => {
    expect(edgeScrollSpeed({ ...base, pointerX: 600 })).toBe(0);
  });

  it('右端に近いほど速く右へ（端で最速）', () => {
    const mid = edgeScrollSpeed({ ...base, pointerX: 1060 });
    const near = edgeScrollSpeed({ ...base, pointerX: 1090 });
    expect(mid).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(mid);
    expect(edgeScrollSpeed({ ...base, pointerX: 1100 })).toBe(1600);
  });

  it('発動域の入り口は 0 でごく低速から立ち上がる（2乗）', () => {
    expect(edgeScrollSpeed({ ...base, pointerX: 1020 })).toBe(0);
    expect(edgeScrollSpeed({ ...base, pointerX: 1060 })).toBeCloseTo(1600 * 0.25);
  });

  it('左の発動域はガターの右端から数え、負（左へ）を返す', () => {
    // ガター右端（X=220）が最速、そこから 80px 右（X=300）で 0 に戻る。
    expect(edgeScrollSpeed({ ...base, pointerX: 220 })).toBe(-1600);
    expect(edgeScrollSpeed({ ...base, pointerX: 260 })).toBeCloseTo(-1600 * 0.25);
    expect(edgeScrollSpeed({ ...base, pointerX: 300 })).toBe(0);
    // ガターの上（見出し列）では発動しない。
    expect(edgeScrollSpeed({ ...base, pointerX: 150 })).toBe(0);
  });

  it('可視域の外（上下・左右）では 0＝即停止', () => {
    expect(edgeScrollSpeed({ ...base, pointerX: 1090, pointerY: 500 })).toBe(0);
    expect(edgeScrollSpeed({ ...base, pointerX: 1200 })).toBe(0);
    expect(edgeScrollSpeed({ ...base, pointerX: 50 })).toBe(0);
  });

  it('可視域が狭い時は発動域を半分ずつに分ける（左右の取り合いを防ぐ）', () => {
    const narrow = { rect: { left: 0, right: 200, top: 0, bottom: 400 }, gutter: 120, pointerY: 200, zone: 80 };
    // inner=80 → z=40。中点 X=160 はどちらの域にも食い込まず 0。
    expect(edgeScrollSpeed({ ...narrow, pointerX: 160 })).toBe(0);
    expect(edgeScrollSpeed({ ...narrow, pointerX: 200 })).toBe(1600);
    expect(edgeScrollSpeed({ ...narrow, pointerX: 120 })).toBe(-1600);
  });
});

describe('edgeScrollZone', () => {
  it('可視幅の 4%（画面が小さいほど発動域も狭い）', () => {
    expect(edgeScrollZone(1000)).toBe(40);
  });

  it('広い画面（4K 等）では 64px で頭打ち', () => {
    expect(edgeScrollZone(3000)).toBe(64);
  });

  it('狭い画面でも 28px は確保（狙えなくならない）', () => {
    expect(edgeScrollZone(300)).toBe(28);
    expect(edgeScrollZone(0)).toBe(28);
  });
});

describe('edgeScrollSpeed の既定 zone', () => {
  it('zone 省略時は可視幅から自動算出する', () => {
    // 可視域 1120px・ガター 120 → inner 1000 → zone 40。
    const auto = { rect: { left: 0, right: 1120, top: 0, bottom: 400 }, gutter: 120, pointerY: 200 };
    expect(edgeScrollSpeed({ ...auto, pointerX: 1080 })).toBe(0);
    expect(edgeScrollSpeed({ ...auto, pointerX: 1100 })).toBeCloseTo(1600 * 0.25);
    expect(edgeScrollSpeed({ ...auto, pointerX: 1120 })).toBe(1600);
  });
});
