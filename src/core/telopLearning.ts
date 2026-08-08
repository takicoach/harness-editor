import type { TelopSegment } from './types';

/** 学習ループ: テロップ差分（テキストのみ・スタイル/テンプレは対象外）。 */
export interface TelopDiffItem {
  kind: 'changed' | 'added' | 'removed';
  startFrame: number;
  endFrame: number;
  /** removed/changed で有効。added は ''。 */
  before: string;
  /** added/changed で有効。removed は ''。 */
  after: string;
}

/** 半開区間 [aStart,aEnd) と [bStart,bEnd) の重なり幅（フレーム）。重ならなければ 0。 */
function overlapLength(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * baseline（書き出し時の telopData.ts スナップショット）と current（現在の telopData.ts）を比較する。
 * 対応付けはフレーム範囲の重なりが最大のものを 1 対 1 でペアにする貪欲法。
 * ペアのテキストが違えば changed、baseline 側で相手が見つからなければ removed、
 * current 側で相手が見つからなければ added。スタイル/テンプレ等は今回スコープ外（テキストのみ）。
 */
export function diffTelopData(baseline: TelopSegment[], current: TelopSegment[]): TelopDiffItem[] {
  interface Candidate {
    baseIndex: number;
    curIndex: number;
    overlap: number;
  }
  const candidates: Candidate[] = [];
  baseline.forEach((b, baseIndex) => {
    current.forEach((c, curIndex) => {
      const overlap = overlapLength(b.startFrame, b.endFrame, c.startFrame, c.endFrame);
      if (overlap > 0) candidates.push({ baseIndex, curIndex, overlap });
    });
  });
  candidates.sort((a, b) => b.overlap - a.overlap);

  const matchedBase = new Set<number>();
  const matchedCur = new Set<number>();
  const pairs: Array<{ baseIndex: number; curIndex: number }> = [];
  for (const c of candidates) {
    if (matchedBase.has(c.baseIndex) || matchedCur.has(c.curIndex)) continue;
    matchedBase.add(c.baseIndex);
    matchedCur.add(c.curIndex);
    pairs.push({ baseIndex: c.baseIndex, curIndex: c.curIndex });
  }

  const items: TelopDiffItem[] = [];
  for (const { baseIndex, curIndex } of pairs) {
    const b = baseline[baseIndex]!;
    const c = current[curIndex]!;
    if (b.text !== c.text) {
      items.push({ kind: 'changed', startFrame: c.startFrame, endFrame: c.endFrame, before: b.text, after: c.text });
    }
  }
  baseline.forEach((b, baseIndex) => {
    if (!matchedBase.has(baseIndex)) {
      items.push({ kind: 'removed', startFrame: b.startFrame, endFrame: b.endFrame, before: b.text, after: '' });
    }
  });
  current.forEach((c, curIndex) => {
    if (!matchedCur.has(curIndex)) {
      items.push({ kind: 'added', startFrame: c.startFrame, endFrame: c.endFrame, before: '', after: c.text });
    }
  });
  return items;
}
