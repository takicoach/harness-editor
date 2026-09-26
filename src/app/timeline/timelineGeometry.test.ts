import { describe, expect, it } from 'vitest';
import {
  frameToX,
  framesToWidth,
  xToFrame,
  clampZoom,
  rulerTicks,
  MIN_PX_PER_FRAME,
  MAX_PX_PER_FRAME,
  TRACK_LABEL_GUTTER_PX,
  frameToXMapped,
  widthMapped,
  xToFrameMapped,
  MIN_MAJOR_GAP_PX,
  fitPxPerFrame,
} from './timelineGeometry';
import { buildDisplayMap } from '../../core/timelineDisplayMap';

describe('framesToWidth', () => {
  it('フレーム数 × pxPerFrame（幅＝距離なのでガターを足さない）', () => {
    expect(framesToWidth(120, 1)).toBe(120);
    expect(framesToWidth(30, 2)).toBe(60);
    expect(framesToWidth(0, 2)).toBe(0);
  });

  it('frameToX とは違いガター(88)を含まない', () => {
    // frameToX(120,1)=208（位置）に対し、幅は 120 のまま。
    expect(framesToWidth(120, 1)).not.toBe(frameToX(120, 1));
    expect(framesToWidth(120, 1)).toBe(120);
  });

  it('不変条件: framesToWidth(b-a) === frameToX(b) - frameToX(a)（差でガター相殺）', () => {
    const cases: Array<[number, number, number]> = [
      [30, 150, 1],
      [200, 320, 2],
      [0, 100, 0.5],
    ];
    for (const [a, b, ppf] of cases) {
      expect(framesToWidth(b - a, ppf)).toBe(frameToX(b, ppf) - frameToX(a, ppf));
    }
  });
});

describe('TRACK_LABEL_GUTTER_PX', () => {
  it('88px（CSS --track-label-w と一致）', () => {
    expect(TRACK_LABEL_GUTTER_PX).toBe(88);
  });
});

describe('frameToX', () => {
  it('フレーム 0 は見出し幅ぶん右（ガター=88）から始まる', () => {
    expect(frameToX(0, 2)).toBe(88);
  });

  it('フレーム × pxPerFrame にガターを足した X を返す', () => {
    expect(frameToX(30, 2)).toBe(148); // 88 + 60
    expect(frameToX(100, 0.5)).toBe(138); // 88 + 50
  });
});

describe('xToFrame', () => {
  it('ガター右端(88)はフレーム 0', () => {
    expect(xToFrame(88, 2)).toBe(0);
  });

  it('ガターを差し引いて四捨五入したフレームを返す', () => {
    expect(xToFrame(148, 2)).toBe(30); // (148-88)/2
    expect(xToFrame(149, 2)).toBe(31); // (149-88)/2 = 30.5 → 31
    expect(xToFrame(138, 0.5)).toBe(100); // (138-88)/0.5
  });

  it('ガター内(88未満)・負の X は 0 へクランプする', () => {
    expect(xToFrame(60, 2)).toBe(0);
    expect(xToFrame(-20, 2)).toBe(0);
  });

  it('pxPerFrame が 0 以下なら 0 を返す（ゼロ除算回避）', () => {
    expect(xToFrame(124, 0)).toBe(0);
  });
});

describe('frameToX / xToFrame 往復', () => {
  it('xToFrame(frameToX(f)) === f', () => {
    const cases: Array<[number, number]> = [[0, 1], [30, 2], [100, 0.5], [7, 1]];
    for (const [f, ppf] of cases) {
      expect(xToFrame(frameToX(f, ppf), ppf)).toBe(f);
    }
  });
});

describe('clampZoom', () => {
  it('範囲内はそのまま返す', () => {
    expect(clampZoom(1)).toBe(1);
  });

  it('下限・上限へクランプする', () => {
    expect(clampZoom(0.0001)).toBe(MIN_PX_PER_FRAME);
    expect(clampZoom(9999)).toBe(MAX_PX_PER_FRAME);
  });

  it('NaN は下限へフォールバックする', () => {
    expect(clampZoom(Number.NaN)).toBe(MIN_PX_PER_FRAME);
  });
});

const kept = [
  { id: 1, originalStart: 0, originalEnd: 80 },
  { id: 2, originalStart: 100, originalEnd: 200 },
];
const cuts = [{ start: 80, end: 100 }];

describe('map 対応ヘルパ', () => {
  it('map 省略時は unmapped と同一', () => {
    expect(frameToXMapped(150, 2)).toBe(frameToX(150, 2));
    expect(widthMapped(100, 200, 2)).toBe(framesToWidth(100, 2));
    expect(xToFrameMapped(frameToX(150, 2), 2)).toBe(150);
  });
  it('identity マップでも unmapped と同一', () => {
    const m = buildDisplayMap(200, cuts, kept, {}, 1);
    expect(frameToXMapped(150, 2, m)).toBe(frameToX(150, 2));
    expect(widthMapped(100, 200, 2, m)).toBe(framesToWidth(100, 2));
    expect(xToFrameMapped(frameToX(150, 2), 2, m)).toBe(150);
  });
  it('伸縮マップで位置・幅が表示座標に', () => {
    const m = buildDisplayMap(200, cuts, kept, { 2: 0.5 }, 1); // id2 0.5x → 表示長2倍
    // 原本150 → 表示200 → frameToX(200)
    expect(frameToXMapped(150, 2, m)).toBe(frameToX(200, 2));
    // id2 全体 [100,200) → 表示 [100,300) → 幅 framesToWidth(200)
    expect(widthMapped(100, 200, 2, m)).toBe(framesToWidth(200, 2));
    // 逆: 表示クリック位置 → 原本
    expect(xToFrameMapped(frameToX(200, 2), 2, m)).toBe(150);
  });
});

describe('波形ズレの主因修正（ガター整合）', () => {
  it('コンテンツ幅（widthMapped(0,total,ppf)）はガター(88)を含まない距離', () => {
    // CutTrack の .tl-video-base / Waveform の CSS 幅はこの「距離」を使う。
    // frameToXMapped(total,...) を width に使うとガター分だけ余計に広がり、
    // 帯・波形の左端が x=0（ガター内）から始まってカット帯・サムネと frame=0 の位置がズレる。
    expect(widthMapped(0, 900, 2)).toBe(framesToWidth(900, 2));
    expect(widthMapped(0, 900, 2)).not.toBe(frameToXMapped(900, 2));
    expect(frameToXMapped(900, 2) - widthMapped(0, 900, 2)).toBe(TRACK_LABEL_GUTTER_PX);
  });

  it('伸縮マップ適用時もコンテンツ幅はガター無しのまま一致する', () => {
    const m = buildDisplayMap(200, cuts, kept, { 2: 0.5 }, 1);
    expect(widthMapped(0, 200, 2, m)).toBe(frameToXMapped(200, 2, m) - TRACK_LABEL_GUTTER_PX);
  });
});

describe('rulerTicks', () => {
  it('総フレーム 0 でも空配列を返さず先頭目盛りだけは出す', () => {
    const ticks = rulerTicks(0, 2, 30);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    const first = ticks[0];
    expect(first?.frame).toBe(0);
  });

  it('major 目盛りには時刻ラベルが付く', () => {
    // 30fps・900 フレーム（30 秒）。
    const ticks = rulerTicks(900, 2, 30);
    const majors = ticks.filter((t) => t.kind === 'major');
    expect(majors.length).toBeGreaterThan(0);
    // 先頭 major は frame=0・ラベル "0:00"
    const head = majors[0];
    expect(head?.frame).toBe(0);
    expect(head?.label).toBe('0:00');
  });

  it('目盛り frame は単調増加し原本末尾を超えない', () => {
    const ticks = rulerTicks(900, 2, 30);
    for (let i = 1; i < ticks.length; i++) {
      const prev = ticks[i - 1];
      const cur = ticks[i];
      expect(prev !== undefined && cur !== undefined).toBe(true);
      if (prev && cur) expect(cur.frame).toBeGreaterThan(prev.frame);
    }
    const last = ticks[ticks.length - 1];
    expect(last !== undefined && last.frame <= 900).toBe(true);
  });

  it('ズームが細かいほど目盛り間隔（秒）は短くなる', () => {
    const coarse = rulerTicks(9000, 0.2, 30); // 全体を狭く描く → 目盛りは粗い
    const fine = rulerTicks(9000, 8, 30); // 全体を広く描く → 目盛りは細かい
    const coarseMajors = coarse.filter((t) => t.kind === 'major');
    const fineMajors = fine.filter((t) => t.kind === 'major');
    expect(fineMajors.length).toBeGreaterThanOrEqual(coarseMajors.length);
  });
});

describe('rulerTicks（表示マップ検算・監査 interaction-5）', () => {
  // rate=4 の案件。残す区間は表示長が 1/4 に潰れるため、等速換算の間隔選択では
  // 実 px 間隔が MIN_MAJOR_GAP_PX(64) の 1/4 になり時刻ラベルが重なる。
  const fps = 30;
  const total = 9000; // 5 分
  const map4 = buildDisplayMap(
    total,
    [],
    [{ id: 1, originalStart: 0, originalEnd: total }],
    {},
    4,
  );

  it('rate=4 では major 間隔が等速時より粗くなる（ラベルが重ならない）', () => {
    // 等速換算で 1 秒 = 30*2.2 = 66px ≧ 64 → 従来は 1 秒間隔を選ぶ。
    const ppf = 2.2;
    const uniform = rulerTicks(total, ppf, fps).filter((t) => t.kind === 'major');
    const scaled = rulerTicks(total, ppf, fps, map4).filter((t) => t.kind === 'major');
    expect(uniform[1]?.frame).toBe(30); // 1 秒間隔（従来）
    expect(scaled[1]?.frame).toBeGreaterThan(30); // 粗い候補へ後退した
  });

  it('rate=4 で選ばれた間隔は実配置でも 64px 以上を保つ', () => {
    const ppf = 2.2;
    const majors = rulerTicks(total, ppf, fps, map4).filter((t) => t.kind === 'major');
    for (let i = 1; i < majors.length; i++) {
      const a = frameToXMapped(majors[i - 1]!.frame, ppf, map4);
      const b = frameToXMapped(majors[i]!.frame, ppf, map4);
      expect(b - a).toBeGreaterThanOrEqual(MIN_MAJOR_GAP_PX);
    }
  });

  it('identity マップを渡しても map 省略時と同一結果（既存挙動を変えない）', () => {
    const idMap = buildDisplayMap(total, [], [{ id: 1, originalStart: 0, originalEnd: total }], {}, 1);
    expect(idMap.identity).toBe(true);
    for (const ppf of [0.2, 1, 2.2, 8]) {
      expect(rulerTicks(total, ppf, fps, idMap)).toEqual(rulerTicks(total, ppf, fps));
    }
  });
});

describe('fitPxPerFrame（全体を表示）', () => {
  it('見出しガターを除いた可視幅にちょうど収まる倍率を返す', () => {
    // 1200px の可視幅から 88px のガターを除いた 1112px に 26000 フレームを収める。
    const ppf = fitPxPerFrame(26000, 1200);
    expect(ppf).not.toBeNull();
    expect(frameToX(26000, ppf as number)).toBeCloseTo(1200, 6);
  });

  it('14 分（26000 フレーム）でも下限に張り付かない', () => {
    expect(fitPxPerFrame(26000, 1200)).toBeGreaterThan(MIN_PX_PER_FRAME);
  });

  it('短い案件で上限を超えないようクランプする', () => {
    expect(fitPxPerFrame(10, 1200)).toBe(MAX_PX_PER_FRAME);
  });

  it('幅 0・フレーム 0・ガター未満の幅は null（今の倍率を維持する）', () => {
    expect(fitPxPerFrame(26000, 0)).toBeNull();
    expect(fitPxPerFrame(0, 1200)).toBeNull();
    expect(fitPxPerFrame(26000, TRACK_LABEL_GUTTER_PX)).toBeNull();
    expect(fitPxPerFrame(Number.NaN, 1200)).toBeNull();
  });
});
