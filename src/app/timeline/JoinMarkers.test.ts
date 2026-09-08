import { describe, expect, it } from 'vitest';
import { joinMarkSpecs, clusterJoinMarks } from './JoinMarkers';
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

describe('clusterJoinMarks（fit 倍率での束ね・サイクル4 レビュー Important）', () => {
  // 素の x = frame をそのまま px とみなす簡易マップ（倍率は pxPerFrame で作る）。
  const xOf = (pxPerFrame: number) => (frame: number) => frame * pxPerFrame;

  it('間隔が閾値以上なら 1 個ずつのまま（束ねない）', () => {
    const specs = joinMarkSpecs([{ atOriginal: 100, playbackFrame: 100 }], 200);
    const clusters = clusterJoinMarks(specs, xOf(1), 12);
    expect(clusters.map((c) => c.at)).toEqual(['head', 100, 'tail']);
    expect(clusters.every((c) => c.members.length === 1)).toBe(true);
  });

  it('閾値未満に密集したマークは 1 個へ束ね、件数を持つ', () => {
    // fit 倍率 0.05px/frame。100 フレーム間隔＝5px なので 12px 閾値では束ねられる。
    const joins = [100, 200, 300, 400].map((f) => ({ atOriginal: f, playbackFrame: f }));
    const clusters = clusterJoinMarks(joinMarkSpecs(joins, 10_000), xOf(0.05), 12);
    // head(0px) が 100〜400（5〜20px）のうち 12px 未満のものを吸収する。
    expect(clusters.length).toBeLessThan(6);
    const total = clusters.reduce((n, c) => n + c.members.length, 0);
    expect(total, '束ねてもマークの総数は保たれる（取りこぼさない）').toBe(6);
    expect(clusters.some((c) => c.members.length > 1), '密集分は束ねられる').toBe(true);
    // 束ねた後の隣り合う x は必ず閾値以上（＝重ならない）。
    for (let i = 1; i < clusters.length; i++) {
      expect(clusters[i]!.x - clusters[i - 1]!.x).toBeGreaterThanOrEqual(12);
    }
  });

  it('頭・尾は束の中に居ても代表になる（fit でも最初/最後の転換を選べる）', () => {
    const joins = [10, 20].map((f) => ({ atOriginal: f, playbackFrame: f }));
    const clusters = clusterJoinMarks(joinMarkSpecs(joins, 30), xOf(0.05), 12);
    // 全部 1.5px 以内 → 1 束。代表は head（頭尾を優先）。
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.at).toBe('head');
    expect(clusters[0]!.members).toHaveLength(4);
  });

  it('尾だけが遠い場合、尾は自分の束の代表になる', () => {
    const joins = [10, 20].map((f) => ({ atOriginal: f, playbackFrame: f }));
    const clusters = clusterJoinMarks(joinMarkSpecs(joins, 10_000), xOf(0.05), 12);
    expect(clusters.at(-1)!.at).toBe('tail');
  });

  it('再生順が原本座標で逆行する（カット並び替え済み）入力でも、離れたマークを束ねない', () => {
    // computeJoins は再生順に返すので、並び替えがあると atOriginal は 300 → 100 のように逆行する。
    const specs = joinMarkSpecs(
      [
        { atOriginal: 300, playbackFrame: 0 },
        { atOriginal: 100, playbackFrame: 200 },
      ],
      1000,
    );
    const clusters = clusterJoinMarks(specs, xOf(10), 12);
    // 10px/frame なら 100 と 300 は 2000px 離れている。逆行を「負の距離」と読んで吸収してはいけない。
    expect(clusters.map((c) => c.at)).toEqual(['head', 100, 300, 'tail']);
    expect(clusters.every((c) => c.members.length === 1)).toBe(true);
  });

  it('閾値 0（極小）でも入力順と件数を壊さない', () => {
    const specs = joinMarkSpecs([{ atOriginal: 5, playbackFrame: 5 }], 9);
    const clusters = clusterJoinMarks(specs, xOf(1), 0);
    expect(clusters).toHaveLength(3);
  });
});
