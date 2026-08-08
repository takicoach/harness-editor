import { clampMainSpeed, hasPerSegmentSpeed } from './speedEngine';
import type { CutRegion } from './types';

interface Block {
  /** 原本開始（含む）。 */
  oStart: number;
  /** 原本終了（含まず）。 */
  oEnd: number;
  /** 表示開始（累積）。 */
  dStart: number;
  /** 表示長 = (oEnd-oStart)/rate（残す区間）または (oEnd-oStart)（カット帯）。 */
  dLen: number;
  /** この区間の実効 rate（カット帯は 1）。 */
  rate: number;
}

export interface DisplayMap {
  originalTotal: number;
  displayTotal: number;
  identity: boolean;
  /** @internal 実装詳細。外部で参照しないこと。 */
  readonly blocks: readonly Block[];
}

/**
 * 原本タイムラインを「残す区間」と「カット帯」に分解し、各ブロックの表示長を決める。
 * 残す区間: 表示長 = 原本長 / rate（rate = segmentSpeeds[id] ?? mainSpeed）。
 * カット帯: 表示長 = 原本長（1:1）。
 * identity = mainSpeed===1 かつ個別指定が実質ゼロ。
 */
export function buildDisplayMap(
  originalTotal: number,
  cutRegions: CutRegion[],
  keptSegments: { id: number; originalStart: number; originalEnd: number }[],
  segmentSpeeds: Record<number, number>,
  mainSpeed: number,
): DisplayMap {
  const base = clampMainSpeed(mainSpeed);
  const identity = base === 1 && !hasPerSegmentSpeed(segmentSpeeds, 1);

  // 原本順のブロック列を作る（残す区間＝rate付き・カット帯＝rate1）。
  type Raw = { oStart: number; oEnd: number; rate: number };
  const raws: Raw[] = [
    ...keptSegments.map((s) => ({
      oStart: s.originalStart,
      oEnd: s.originalEnd,
      rate: segmentSpeeds[s.id] === undefined ? base : clampMainSpeed(segmentSpeeds[s.id] as number),
    })),
    ...cutRegions.map((c) => ({ oStart: c.start, oEnd: c.end, rate: 1 })),
  ]
    .filter((b) => b.oEnd > b.oStart)
    .sort((a, b) => a.oStart - b.oStart);

  const blocks: Block[] = [];
  let dCursor = 0;
  for (const r of raws) {
    const dLen = Math.round((r.oEnd - r.oStart) / r.rate);
    blocks.push({ oStart: r.oStart, oEnd: r.oEnd, dStart: dCursor, dLen, rate: r.rate });
    dCursor += dLen;
  }
  return {
    originalTotal,
    displayTotal: identity ? originalTotal : dCursor,
    identity,
    blocks,
  };
}

/** 原本フレーム → 表示フレーム（区分線形・単調増加）。 */
export function originalToDisplay(frame: number, map: DisplayMap): number {
  if (map.identity) return Math.max(0, Math.min(frame, map.originalTotal));
  if (frame <= 0) return 0;
  for (const b of map.blocks) {
    if (frame <= b.oStart) return b.dStart;
    if (frame < b.oEnd) return b.dStart + Math.round((frame - b.oStart) / b.rate);
  }
  return map.displayTotal;
}

/** 表示フレーム → 原本フレーム（originalToDisplay の逆）。 */
export function displayToOriginal(frame: number, map: DisplayMap): number {
  if (map.identity) return Math.max(0, Math.min(frame, map.originalTotal));
  if (frame <= 0) return 0;
  for (const b of map.blocks) {
    if (frame <= b.dStart) return b.oStart;
    if (frame < b.dStart + b.dLen) return b.oStart + Math.round((frame - b.dStart) * b.rate);
  }
  const last = map.blocks.at(-1);
  return last ? last.oEnd : 0;
}
