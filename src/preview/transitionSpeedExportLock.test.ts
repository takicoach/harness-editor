import { describe, it, expect } from 'vitest';
import { planUnifiedSeries, type UnifiedSequenceItem, type UnifiedTransitionItem } from '../server/transitionPayload/unifiedSeries';
import { speedScale } from '../core/speedEngine';
import { buildOverlaps } from '../core/transitionEngine';
import type { CutSegment, SceneTransition } from '../core/types';

// 再生座標の区間（カット後）と転換（at=再生境界）。
const cutData: CutSegment[] = [
  { id: 1, originalStart: 0, originalEnd: 90, playbackStart: 0, playbackEnd: 90 },
  { id: 2, originalStart: 90, originalEnd: 210, playbackStart: 90, playbackEnd: 210 },
  { id: 3, originalStart: 210, originalEnd: 300, playbackStart: 210, playbackEnd: 300 },
];
const transitions: SceneTransition[] = [
  { id: 1, at: 90, kind: 'crossfade', durationFrames: 21 },
  { id: 2, at: 210, kind: 'slide', durationFrames: 17, direction: 'left' },
];

// クランプ発火フィクスチャ（durationFrames が cap=floor(min(lenPrev,lenNext)/2) を超える）。
const clampTransitions: SceneTransition[] = [
  { id: 1, at: 90, kind: 'crossfade', durationFrames: 100 },
  { id: 2, at: 210, kind: 'slide', durationFrames: 80, direction: 'left' },
];

/** EditorComposition(path2) と同じ前処理を core 関数で再現した期待値（applyMainSpeed 相当）。 */
function previewBaseExpectation(
  cutData: CutSegment[],
  transitions: SceneTransition[],
  rate: number,
): { overlaps: { boundary: number; overlap: number }[]; durations: number[] } {
  const segs = cutData.map((s) => ({
    ...s,
    playbackStart: speedScale(s.playbackStart, rate),
    playbackEnd: speedScale(s.playbackEnd, rate),
  }));
  const trans = transitions.map((t) => ({
    ...t,
    at: typeof t.at === 'number' ? speedScale(t.at, rate) : t.at,
    durationFrames: speedScale(t.durationFrames, rate),
  }));
  const overlaps = buildOverlaps(
    trans.filter((t): t is SceneTransition & { at: number } => typeof t.at === 'number'),
    segs,
  );
  const durations = segs.map((s) => Math.max(1, s.playbackEnd - s.playbackStart));
  return { overlaps, durations };
}

describe('トランジション×速度 書き出し＝プレビュー 等価ロック（通常フィクスチャ）', () => {
  for (const rate of [1, 0.5, 0.1, 2, 3, 1.5, 16]) {
    it(`rate=${rate}: 統合プレイヤーの区間尺・overlap が EditorComposition(path2) と一致`, () => {
      const items = planUnifiedSeries(cutData, transitions, rate);
      const exp = previewBaseExpectation(cutData, transitions, rate);

      const seqDur = items
        .filter((i) => i.type === 'sequence')
        .map((i) => (i as UnifiedSequenceItem).durationInFrames);
      expect(seqDur).toEqual(exp.durations);

      const trOverlaps = items
        .filter((i) => i.type === 'transition')
        .map((i) => {
          const t = i as UnifiedTransitionItem;
          return { boundary: t.boundary, overlap: t.overlap };
        });
      expect(trOverlaps).toEqual(exp.overlaps);
    });
  }
});

describe('トランジション×速度 書き出し＝プレビュー 等価ロック（クランプフィクスチャ）', () => {
  for (const rate of [1, 0.5, 0.1, 2, 3, 1.5, 16]) {
    it(`rate=${rate}: クランプ時も統合プレイヤーの区間尺・overlap が EditorComposition(path2) と一致`, () => {
      const items = planUnifiedSeries(cutData, clampTransitions, rate);
      const exp = previewBaseExpectation(cutData, clampTransitions, rate);

      const seqDur = items
        .filter((i) => i.type === 'sequence')
        .map((i) => (i as UnifiedSequenceItem).durationInFrames);
      expect(seqDur).toEqual(exp.durations);

      const trOverlaps = items
        .filter((i) => i.type === 'transition')
        .map((i) => {
          const t = i as UnifiedTransitionItem;
          return { boundary: t.boundary, overlap: t.overlap };
        });
      expect(trOverlaps).toEqual(exp.overlaps);
    });
  }

  it('rate=1: クランプが発火し overlap が cap(=45) に丸められる（絶対値アンカー）', () => {
    const items = planUnifiedSeries(cutData, clampTransitions, 1);
    const trOverlaps = items
      .filter((i) => i.type === 'transition')
      .map((i) => {
        const t = i as UnifiedTransitionItem;
        return { boundary: t.boundary, overlap: t.overlap };
      });
    // boundary 90: cap=floor(min(90,120)/2)=45, durationFrames=100 → 45
    // boundary 210: cap=floor(min(120,90)/2)=45, durationFrames=80 → 45
    expect(trOverlaps).toEqual([
      { boundary: 90, overlap: 45 },
      { boundary: 210, overlap: 45 },
    ]);
  });
});
