import type { SoundEffect, TelopSegment } from './types';

/** 学習ループ: SE 差分（追加=人間が足した / 削除=AI配置を人間が外した）。 */
export interface SeDiffItem {
  kind: 'added' | 'removed';
  startFrame: number;
  file: string;
  /** 近傍テロップのテキスト（無ければ ''）。文脈の手がかり。 */
  nearbyText: string;
}

/** endFrame 省略時は旧データ互換で 90 フレーム区間とみなす（SE 区間の既定長の契約と同式）。 */
function seEnd(s: SoundEffect): number {
  return s.endFrame ?? s.startFrame + 90;
}

function overlapLength(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** frame を含む telop があればそのテキスト、無ければ最も近い telop のテキスト。telops が空なら ''。 */
function nearbyTelopText(telops: TelopSegment[], frame: number): string {
  const containing = telops.find((t) => frame >= t.startFrame && frame < t.endFrame);
  if (containing) return containing.text;
  if (telops.length === 0) return '';
  let best = telops[0]!;
  let bestDist = Infinity;
  for (const t of telops) {
    const dist = Math.min(Math.abs(t.startFrame - frame), Math.abs(t.endFrame - frame));
    if (dist < bestDist) {
      bestDist = dist;
      best = t;
    }
  }
  return best.text;
}

/**
 * baseline（AI が置いた SE のスナップショット）と current（現在の seData.ts）を比較する。
 * 同一 file かつ区間が重なるものだけを対応ペアとみなす（貪欲法・overlap 最大優先）。
 * ペアが見つからない baseline 側 SE は removed、current 側 SE は added。
 */
export function diffSeData(baseline: SoundEffect[], current: SoundEffect[], telops: TelopSegment[]): SeDiffItem[] {
  interface Candidate {
    baseIndex: number;
    curIndex: number;
    overlap: number;
  }
  const candidates: Candidate[] = [];
  baseline.forEach((b, baseIndex) => {
    current.forEach((c, curIndex) => {
      if (b.file !== c.file) return;
      const overlap = overlapLength(b.startFrame, seEnd(b), c.startFrame, seEnd(c));
      if (overlap > 0) candidates.push({ baseIndex, curIndex, overlap });
    });
  });
  candidates.sort((a, b) => b.overlap - a.overlap);

  const matchedBase = new Set<number>();
  const matchedCur = new Set<number>();
  for (const c of candidates) {
    if (matchedBase.has(c.baseIndex) || matchedCur.has(c.curIndex)) continue;
    matchedBase.add(c.baseIndex);
    matchedCur.add(c.curIndex);
  }

  const items: SeDiffItem[] = [];
  baseline.forEach((b, baseIndex) => {
    if (!matchedBase.has(baseIndex)) {
      items.push({ kind: 'removed', startFrame: b.startFrame, file: b.file, nearbyText: nearbyTelopText(telops, b.startFrame) });
    }
  });
  current.forEach((c, curIndex) => {
    if (!matchedCur.has(curIndex)) {
      items.push({ kind: 'added', startFrame: c.startFrame, file: c.file, nearbyText: nearbyTelopText(telops, c.startFrame) });
    }
  });
  return items;
}
