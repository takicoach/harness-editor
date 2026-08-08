import { describe, it, expect } from 'vitest';
import { computeWaveformBuckets } from './waveform';
import { TRACK_LABEL_GUTTER_PX, widthMapped, framesToWidth } from '../app/timeline/timelineGeometry';
import { buildDisplayMap } from './timelineDisplayMap';

describe('computeWaveformBuckets', () => {
  it('bucketCount が 0 以下なら空配列', () => {
    expect(computeWaveformBuckets(new Float32Array([0.1, 0.2]), 0)).toEqual([]);
    expect(computeWaveformBuckets(new Float32Array([0.1, 0.2]), -3)).toEqual([]);
  });

  it('サンプルが空でも bucketCount ぶんのゼロバケットを返す', () => {
    const buckets = computeWaveformBuckets(new Float32Array([]), 4);
    expect(buckets).toHaveLength(4);
    for (const b of buckets) {
      expect(b.peak).toBe(0);
      expect(b.rms).toBe(0);
    }
  });

  it('一定振幅では rms も peak もその振幅に等しい', () => {
    const samples = new Float32Array(100).fill(0.5);
    const buckets = computeWaveformBuckets(samples, 5);
    expect(buckets).toHaveLength(5);
    for (const b of buckets) {
      expect(b.peak).toBeCloseTo(0.5, 5);
      expect(b.rms).toBeCloseTo(0.5, 5);
    }
  });

  it('負値は絶対値で peak に効き、rms は二乗平均平方根', () => {
    const buckets = computeWaveformBuckets(new Float32Array([-1, 1, -1, 1]), 1);
    expect(buckets[0]?.peak).toBe(1);
    expect(buckets[0]?.rms).toBeCloseTo(1, 5);
  });

  it('バケット境界はサンプルを均等割りする', () => {
    const buckets = computeWaveformBuckets(new Float32Array([1, 1, 0, 0]), 2);
    expect(buckets[0]?.rms).toBeCloseTo(1, 5);
    expect(buckets[1]?.rms).toBe(0);
  });

  it('1 を超える振幅は 1 にクランプする', () => {
    const buckets = computeWaveformBuckets(new Float32Array([2, 2]), 1);
    expect(buckets[0]?.peak).toBe(1);
    expect(buckets[0]?.rms).toBe(1);
  });

  it('NaN サンプルは 0 として扱う（有限値を返す）', () => {
    const buckets = computeWaveformBuckets(new Float32Array([NaN, 0.5]), 1);
    expect(Number.isFinite(buckets[0]?.peak ?? NaN)).toBe(true);
    expect(Number.isFinite(buckets[0]?.rms ?? NaN)).toBe(true);
  });

  it('サンプル数がバケット数より少なくても bucketCount ぶん返す', () => {
    const buckets = computeWaveformBuckets(new Float32Array([1, 1]), 5);
    expect(buckets).toHaveLength(5);
    const empties = buckets.filter((b) => b.peak === 0 && b.rms === 0);
    expect(empties.length).toBeGreaterThan(0);
  });

  describe('波形ズレの主因修正（ガター整合）', () => {
    // Waveform の CSS 幅（= bucketCount の元）は CutTrack がコンテンツ幅（frame*ppf、
    // ガター無し）で渡す契約。誤ってガター(88px)込みの幅を渡すと、同じ canvas 1px=1bucket
    // 描画のまま bucketCount だけ水増しされ、実際のコンテンツより横に間延びした波形になる
    // （＝カット帯・サムネの位置とズレて見える主因）。
    const totalFrames = 900;
    const pxPerFrame = 2;
    const correctBucketCount = Math.round(totalFrames * pxPerFrame); // ガター無し（正）
    const buggyBucketCount = correctBucketCount + TRACK_LABEL_GUTTER_PX; // ガター込み（旧バグ）

    it('正しい bucketCount はガター無しの距離（frame*ppf）と一致する', () => {
      expect(correctBucketCount).toBe(1800);
      expect(buggyBucketCount).not.toBe(correctBucketCount);
      expect(buggyBucketCount - correctBucketCount).toBe(TRACK_LABEL_GUTTER_PX);
    });

    it('bucketCount を水増しすると、同じサンプル数でも 1 バケットが受け持つ実時間が縮み、内容が幅いっぱいに間延びする', () => {
      // 一定振幅の信号。バケット数だけを変えても各バケットの rms/peak は変わらない
      // （＝computeWaveformBuckets 自体は歪みなく比例配分する）ことを確認したうえで、
      // 「バケット数（＝描画幅）が実コンテンツより大きい」こと自体が間延びの原因だと明示する。
      const samples = new Float32Array(correctBucketCount * 4).fill(0.5);
      const correctBuckets = computeWaveformBuckets(samples, correctBucketCount);
      const buggyBuckets = computeWaveformBuckets(samples, buggyBucketCount);

      expect(correctBuckets).toHaveLength(correctBucketCount);
      expect(buggyBuckets).toHaveLength(buggyBucketCount);
      // 1 バケット = 1px 描画なので、bucketCount の差(=88)がそのまま余分な描画幅になる。
      expect(buggyBuckets.length - correctBuckets.length).toBe(TRACK_LABEL_GUTTER_PX);
      // どちらも振幅自体は歪まない（バグはバケット数の選び方＝呼び出し側の契約にある）。
      for (const b of [...correctBuckets, ...buggyBuckets]) {
        expect(b.rms).toBeCloseTo(0.5, 5);
      }
    });
  });

  describe('波形の残ズレ（原因2/3・実測後に判断）', () => {
    // ガター起因の主因（原因1・item-02）修正後も、以下 2 つの残候補を調査した:
    //   原因2: buildDisplayMap が非 identity（区間ごとの speed / カット collapse）を持つとき、
    //           Waveform 側の bucketCount は widthMapped が返す「表示（非一様に伸縮した）幅」から
    //           算出されるが、computeWaveformBuckets は元のサンプル列（原本時間・一様）を
    //           bucketCount 個に単純線形分割するため、区間ごとの rate が一様でない場合は
    //           バケット↔原本時間の対応がズレうる。
    //   原因3: canvas 裏バッファは MAX_WAVEFORM_BUCKETS（2400）でクランプされるため、
    //           表示幅がそれを超える長尺プロジェクトでは canvas がブラウザ側で引き伸ばされる。
    // どちらも実機（実際のズーム倍率・実プロジェクト長・実際のカット構成）での目視測定が
    // 前提の判断であり、本タスクの受入基準どおり「identity 時は既存と一致する」ことのみを
    // 回帰テストでロックし、非 identity 側の追加修正は見送る（実測後に別途判断）。
    it('identity（カット無し・速度変更無し）では widthMapped ベースの bucketCount が既存の値と一致する', () => {
      const totalFrames = 900;
      const pxPerFrame = 2;
      const map = buildDisplayMap(totalFrames, [], [], {}, 1);
      expect(map.identity).toBe(true);

      const contentWidth = widthMapped(0, totalFrames, pxPerFrame, map);
      const bucketCount = Math.max(1, Math.min(2400, Math.round(contentWidth)));

      // map 無し（undefined）で計算した場合と完全一致する（identity 時は map の有無で
      // 結果が変わらないことも合わせてロックする）。
      const contentWidthNoMap = widthMapped(0, totalFrames, pxPerFrame);
      expect(contentWidth).toBe(contentWidthNoMap);
      expect(contentWidth).toBe(1800);
      expect(bucketCount).toBe(1800);
    });

    it('identity マップを持つ keptSegments/cutRegions を渡しても displayTotal は originalTotal と一致する（回帰ロック）', () => {
      const totalFrames = 300;
      const map = buildDisplayMap(
        totalFrames,
        [{ start: 100, end: 150 }],
        [
          { id: 1, originalStart: 0, originalEnd: 100 },
          { id: 2, originalStart: 150, originalEnd: 300 },
        ],
        {},
        1,
      );
      // mainSpeed=1・個別 speed 指定なしなら、カット/残す区間があっても identity のまま
      // （原本全長の帯として描画されるため displayTotal=originalTotal で波形幅もズレない）。
      expect(map.identity).toBe(true);
      expect(map.displayTotal).toBe(totalFrames);
      expect(widthMapped(0, totalFrames, 2, map)).toBe(framesToWidth(totalFrames, 2));
    });
  });
});
