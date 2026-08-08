import type { CutRegion, CutSegment } from './types';

/** CutRegion[] を start 昇順へソートし、重複・隣接区間をマージ、空区間を除外する。 */
export function normalizeCutRegions(regions: CutRegion[]): CutRegion[] {
  const sorted = regions
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: CutRegion[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

/**
 * 原本動画（originalTotalFrames）から削除区間 regions を抜いた残り＝CutSegment[] を生成する。
 * 区間は原本上 1:1（時間圧縮なし）で playback タイムラインへ前詰めされる。
 */
export function applyCuts(originalTotalFrames: number, regions: CutRegion[]): CutSegment[] {
  const cuts = normalizeCutRegions(regions);
  const segments: CutSegment[] = [];
  let cursor = 0;
  let playback = 0;
  let id = 1;
  for (const cut of cuts) {
    if (cut.start > cursor) {
      const len = cut.start - cursor;
      segments.push({
        id: id++,
        originalStart: cursor,
        originalEnd: cut.start,
        playbackStart: playback,
        playbackEnd: playback + len,
      });
      playback += len;
    }
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < originalTotalFrames) {
    const len = originalTotalFrames - cursor;
    segments.push({
      id: id++,
      originalStart: cursor,
      originalEnd: originalTotalFrames,
      playbackStart: playback,
      playbackEnd: playback + len,
    });
  }
  return segments;
}

/**
 * 素材（残す区間）の原本フレーム範囲 [start, end] を返す。
 * 先頭・末尾のカット済み領域（素材なし＝カットするものがない）を除いた範囲。
 * カット皆無なら [0, totalFrames]。全カット（残り無し）も [0, totalFrames]（縮退・呼び出し側でガード）。
 * 範囲選択カットの選択帯を素材内へクランプするのに使う。
 */
export function materialBounds(
  originalTotalFrames: number,
  regions: CutRegion[],
): { start: number; end: number } {
  const kept = applyCuts(originalTotalFrames, regions);
  if (kept.length === 0) return { start: 0, end: originalTotalFrames };
  return { start: kept[0]!.originalStart, end: kept[kept.length - 1]!.originalEnd };
}

/** 既存 cutData.ts（残す区間）を、エディタ内部表現の削除区間 CutRegion[] へ変換する。 */
export function cutRegionsFromCutData(
  cutData: CutSegment[],
  originalTotalFrames: number,
): CutRegion[] {
  // 空配列は「残す区間なし」＝カット無し として扱う純粋関数。
  // 「全カット（cutData: []）」と「ファイル不在（null）」の区別は呼び出し元（loadProject）の責務。
  if (cutData.length === 0) return [];
  const sorted = [...cutData].sort((a, b) => a.originalStart - b.originalStart);
  const regions: CutRegion[] = [];
  let cursor = 0;
  for (const seg of sorted) {
    if (seg.originalStart > cursor) {
      regions.push({ start: cursor, end: seg.originalStart });
    }
    cursor = Math.max(cursor, seg.originalEnd);
  }
  if (cursor < originalTotalFrames) {
    regions.push({ start: cursor, end: originalTotalFrames });
  }
  return regions;
}

/** カット適用後（再生）の総フレーム数。 */
export function playbackTotalFrames(originalTotalFrames: number, regions: CutRegion[]): number {
  const removed = normalizeCutRegions(regions).reduce(
    (sum, r) => sum + (Math.min(r.end, originalTotalFrames) - r.start),
    0,
  );
  return Math.max(0, originalTotalFrames - removed);
}

/**
 * 原本フレームをカット後（再生）フレームへ射影する。
 * フレームがカット区間内なら null。
 */
export function originalToPlayback(originalFrame: number, regions: CutRegion[]): number | null {
  const cuts = normalizeCutRegions(regions);
  let removed = 0;
  for (const c of cuts) {
    if (originalFrame >= c.end) {
      removed += c.end - c.start;
      continue;
    }
    if (originalFrame >= c.start) return null; // カット区間内
    break;
  }
  return originalFrame - removed;
}

/** カット後（再生）フレームを原本フレームへ逆射影する。 */
export function playbackToOriginal(playbackFrame: number, regions: CutRegion[]): number {
  const cuts = normalizeCutRegions(regions);
  let original = playbackFrame;
  for (const c of cuts) {
    if (original >= c.start) {
      original += c.end - c.start;
    } else {
      break;
    }
  }
  return original;
}

/** カット区間を 1 つ追加して正規化する（単語/行の削除に対応）。 */
export function addCutRegion(regions: CutRegion[], region: CutRegion): CutRegion[] {
  return normalizeCutRegions([...regions, region]);
}

/** カット区間から target の範囲を差し引く（削除カットの復帰に対応）。 */
export function removeCutRegion(regions: CutRegion[], target: CutRegion): CutRegion[] {
  const out: CutRegion[] = [];
  for (const r of normalizeCutRegions(regions)) {
    if (target.end <= r.start || target.start >= r.end) {
      out.push(r); // 重ならない
      continue;
    }
    if (target.start > r.start) out.push({ start: r.start, end: target.start });
    if (target.end < r.end) out.push({ start: target.end, end: r.end });
  }
  return out;
}
