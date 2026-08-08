import { describe, expect, it } from 'vitest';
import { joinMarkSpecs } from './JoinMarkers';
import type { Join } from '../../core/joinEngine';

describe('joinMarkSpecs', () => {
  it('頭=0・尾=tailFrame・つなぎ目は atOriginal（原本座標）で配置する', () => {
    // 手前にカットがあり playbackFrame < atOriginal の join（offset あり）。
    const joins: Join[] = [
      { atOriginal: 2000, playbackFrame: 2000 }, // offset 0
      { atOriginal: 9000, playbackFrame: 8000 }, // offset 1000（手前のカット分）
    ];
    const specs = joinMarkSpecs(joins, 11000);
    expect(specs.map((s) => ({ at: s.at, frame: s.frame }))).toEqual([
      { at: 'head', frame: 0 },
      { at: 2000, frame: 2000 },
      // 回帰の核心: playbackFrame(8000) ではなく atOriginal(9000) を使う。
      // 再生フレームを使うとカット帯（原本座標で描画）と一致せず実機で見つからない。
      { at: 9000, frame: 9000 },
      { at: 'tail', frame: 11000 },
    ]);
  });

  it('カット無し（join 0 件）でも頭尾は出る', () => {
    expect(joinMarkSpecs([], 12000).map((s) => s.at)).toEqual(['head', 'tail']);
  });
});
