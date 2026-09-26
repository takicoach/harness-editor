import type {SequenceDocument} from '../../core/sequence/model';
import {resolveCutBoundary} from '../../core/sequence/cutArchive';
import type {CutBoundarySelection} from '../../core/sequence/cutBoundary';

export type FinishBoundaryBias = 'before' | 'after';
export interface FinishLivePiece {
  displayStart: number;
  displayEnd: number;
  startFrame: number;
  endFrame: number;
}
export type FinishDisplayBlock =
  | (FinishLivePiece & {kind: 'live'})
  | {kind: 'archived';displayStart: number;displayEnd: number;entryId: string;
      localStart: 0;localEnd: number;atFrame: number;cut: CutBoundarySelection};
/** start/end are display coordinates, suitable for the existing CutTrack. */
export interface FinishDisplayCut {
  cut: CutBoundarySelection;
  entryIds: string[];
  atFrame: number;
  start: number;
  end: number;
}
export interface FinishUnresolvedCut {
  cut: CutBoundarySelection;
  entryIds: string[];
  frame: number | null;
  code: 'unresolved-boundary' | 'unknown-order';
  reason: string;
}
export interface FinishDisplayMap {
  completionEnd: number;
  displayEnd: number;
  blocks: FinishDisplayBlock[];
  cuts: FinishDisplayCut[];
  unresolved: FinishUnresolvedCut[];
}
export type FinishDisplayPoint =
  | {kind: 'live';frame: number}
  | {kind: 'archived';entryId: string;localFrame: number};

/** Pure projection of a validated document. Live spans keep completion-frame
 * units; every archived span keeps its own saved local-frame units. This is
 * neither a single media-source axis nor the current-rate restoration length.
 * Asset IDs, source seconds and inventory order never establish cut lineage. */
export function buildFinishDisplayMap(document: SequenceDocument): FinishDisplayMap {
  const result: FinishDisplayMap = {completionEnd: document.sequenceEndFrame,
    displayEnd: 0,blocks: [],cuts: [],unresolved: []};
  const entries = new Map(document.cutArchive?.entries.map(entry => [entry.id,entry]) ?? []);
  const grouped = new Set(document.cutArchive?.groups?.flatMap(group => group.entryIds) ?? []);
  const selections = [
    ...(document.cutArchive?.groups ?? []).map(group => ({cut: {kind: 'group' as const,id: group.id},entryIds: [...group.entryIds]})),
    ...(document.cutArchive?.entries ?? []).filter(entry => !grouped.has(entry.id))
      .map(entry => ({cut: {kind: 'entry' as const,id: entry.id},entryIds: [entry.id]})),
  ];
  const resolved: Array<{cut: CutBoundarySelection;entryIds: string[];frame: number}> = [];
  for (const selection of selections) {
    const boundaries = selection.entryIds.map(id => {
      const entry = entries.get(id);
      if (!entry) throw new Error('保存カットのグループ参照が不正です');
      return resolveCutBoundary(document,entry);
    });
    const frame = boundaries[0]?.frame ?? null;
    if (frame === null || boundaries.some(boundary => boundary.frame !== frame)) {
      result.unresolved.push({...selection,frame: null,code: 'unresolved-boundary',
        reason: boundaries.find(boundary => boundary.reason)?.reason ?? 'カット帯の境界が一致しません。位置を確認してください'});
    } else resolved.push({...selection,frame});
  }
  const seamCounts = new Map<number,number>();
  for (const selection of resolved) seamCounts.set(selection.frame,(seamCounts.get(selection.frame) ?? 0) + 1);
  const ordered = resolved.filter(selection => {
    if (seamCounts.get(selection.frame) === 1) return true;
    result.unresolved.push({...selection,code: 'unknown-order',reason: '同じ境界に複数のカットがあります。左右の順序が未確定です'});
    return false;
  }).sort((a,b) => a.frame - b.frame);

  let liveCursor = 0;
  const appendLive = (endFrame: number) => {
    if (endFrame <= liveCursor) return;
    const displayStart = result.displayEnd;
    result.displayEnd += endFrame - liveCursor;
    result.blocks.push({kind: 'live',displayStart,displayEnd: result.displayEnd,startFrame: liveCursor,endFrame});
    liveCursor = endFrame;
  };
  for (const selection of ordered) {
    appendLive(selection.frame);
    const start = result.displayEnd;
    for (const entryId of selection.entryIds) {
      const entry = entries.get(entryId)!;
      const displayStart = result.displayEnd;
      result.displayEnd += entry.durationFrames;
      result.blocks.push({kind: 'archived',displayStart,displayEnd: result.displayEnd,
        entryId,localStart: 0,localEnd: entry.durationFrames,atFrame: selection.frame,cut: {...selection.cut}});
    }
    result.cuts.push({cut: {...selection.cut},entryIds: [...selection.entryIds],atFrame: selection.frame,start,end: result.displayEnd});
  }
  appendLive(document.sequenceEndFrame);
  return result;
}

const inRange = (value: number,end: number) => Number.isFinite(value) && value >= 0 && value <= end;

/** Preserve fractional pointer coordinates. The caller rounds only when forming
 * a frame command, and supplies an explicit side for shared block endpoints.
 * At the outer endpoints the only existing block owns the point. */
export function finishDisplayPoint(map: FinishDisplayMap,displayFrame: number,bias: FinishBoundaryBias): FinishDisplayPoint | null {
  if (!inRange(displayFrame,map.displayEnd)) return null;
  const candidates = map.blocks.filter(block => block.displayStart <= displayFrame && displayFrame <= block.displayEnd);
  const block = bias === 'before' ? candidates[0] : candidates.at(-1);
  if (!block) return map.displayEnd === 0 ? {kind: 'live',frame: 0} : null;
  return block.kind === 'live'
    ? {kind: 'live',frame: block.startFrame + displayFrame - block.displayStart}
    : {kind: 'archived',entryId: block.entryId,localFrame: displayFrame - block.displayStart};
}

/** A completion seam has two display positions: before or after its cut band. */
export function finishLiveToDisplay(map: FinishDisplayMap,frame: number,bias: FinishBoundaryBias): number | null {
  if (!inRange(frame,map.completionEnd)) return null;
  let display = frame;
  for (const cut of map.cuts) if (cut.atFrame < frame || (cut.atFrame === frame && bias === 'after')) display += cut.end - cut.start;
  return display;
}

export function finishArchivedToDisplay(map: FinishDisplayMap,entryId: string,localFrame: number): number | null {
  const block = map.blocks.find(block => block.kind === 'archived' && block.entryId === entryId);
  return block?.kind === 'archived' && inRange(localFrame,block.localEnd) ? block.displayStart + localFrame : null;
}

/** Split all live visual/audio ranges at inserted bands. Returned fragments keep
 * completion coordinates; a caller attaches its original clip/occurrence ID.
 * In particular, a later clip spanning a cut is not stretched across that cut. */
export function projectFinishLiveRange(map: FinishDisplayMap,startFrame: number,endFrame: number): FinishLivePiece[] {
  if (!inRange(startFrame,map.completionEnd) || !inRange(endFrame,map.completionEnd) || startFrame >= endFrame) return [];
  return map.blocks.flatMap(block => {
    if (block.kind !== 'live') return [];
    const start = Math.max(startFrame,block.startFrame),end = Math.min(endFrame,block.endFrame);
    return start < end ? [{displayStart: block.displayStart + start - block.startFrame,
      displayEnd: block.displayStart + end - block.startFrame,startFrame: start,endFrame: end}] : [];
  });
}
