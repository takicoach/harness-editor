import type { EditorProject, TranscriptWord } from './types';
import { buildCutOrdering, reorderStartEnd } from './cutOrder';
import { clampTelops, projectTelops } from './telopEngine';
import { computeJoins, projectSceneTransitions } from './joinEngine';
import { buildOverlaps } from './transitionEngine';
import { collapseStartEnd } from './sceneCollapse';
import { hasPerSegmentSpeed, resolveSpeedSegments } from './speedEngine';
import { scaleStartEnd, scaleStartEndPiecewise } from './speedProject';

export interface TimelinePlacement { startFrame: number; endFrame: number }
export interface PlaceableAsset { id: number; originalStart: number; originalEnd: number; timelinePlacement?: TimelinePlacement }
export const ASSET_COLLECTIONS = ['telops', 'titles', 'images', 'videoInserts', 'bgm', 'se', 'shapes'] as const;
export type AssetCollection = typeof ASSET_COLLECTIONS[number];
export type AssetGroups = Pick<EditorProject, AssetCollection>;
export interface TimelineBinding { collection: AssetCollection; id: number; originalStart: number; originalEnd: number }

function frame(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
export function validTimelinePlacement(value: unknown): value is TimelinePlacement {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<TimelinePlacement>;
  return frame(v.startFrame) && frame(v.endFrame) && v.endFrame > v.startFrame;
}
export function sameTimelinePlacement(a?: TimelinePlacement, b?: TimelinePlacement): boolean {
  return a === b || (a !== undefined && b !== undefined && a.startFrame === b.startFrame && a.endFrame === b.endFrame);
}
export function hasTimelinePlacements(project: AssetGroups): boolean {
  return ASSET_COLLECTIONS.some(key => project[key]?.some(item => item.timelinePlacement !== undefined));
}
function mapGroups<T extends AssetGroups>(project: T, map: <A extends PlaceableAsset>(items: A[]) => A[]): T {
  return { ...project, telops: map(project.telops), titles: map(project.titles), images: map(project.images),
    videoInserts: map(project.videoInserts ?? []), bgm: map(project.bgm ?? []), se: map(project.se), shapes: map(project.shapes ?? []) };
}
export function sourceAnchoredProject<T extends AssetGroups>(project: T): T {
  return mapGroups(project, items => items.filter(item => item.timelinePlacement === undefined));
}

/** Source speech is projected to the finished clock before independent BGM ducking. */
function finalWords(project: EditorProject): TranscriptWord[] {
  const fps = project.videoConfig.fps;
  const ordering = buildCutOrdering(project.videoConfig.durationFrames, project.cutRegions, project.cutOrder);
  const transitions = projectSceneTransitions(project.sceneTransitions ?? [], computeJoins(project.videoConfig.durationFrames, project.cutRegions, ordering));
  const overlaps = buildOverlaps(transitions, ordering.segments);
  const raw = project.transcript.words.map((w, id) => ({ id, text: w.text, originalStart: Math.round(w.start * fps / 1000), originalEnd: Math.round(w.end * fps / 1000) }));
  const projected = collapseStartEnd(reorderStartEnd(projectTelops(clampTelops(raw, project.cutRegions).telops, project.cutRegions), ordering), overlaps);
  const rate = project.mainSpeed;
  const speeds = project.segmentSpeeds ?? {};
  const scaled = transitions.length === 0 && hasPerSegmentSpeed(speeds, rate)
    ? scaleStartEndPiecewise(projected, resolveSpeedSegments(ordering.segments, rate, speeds)) : scaleStartEnd(projected, rate);
  return scaled.filter(w => w.endFrame > w.startFrame).map(w => ({ text: w.text, start: w.startFrame * 1000 / fps, end: w.endFrame * 1000 / fps }));
}

/** Reuse the existing asset projection once, on an identity clock. Main video is never replaced. */
export function independentAssetProject(project: EditorProject): EditorProject {
  let durationFrames = project.videoConfig.durationFrames;
  const independent = mapGroups(project, items => items.filter(item => item.timelinePlacement !== undefined).map(item => {
    const { timelinePlacement, ...rest } = item;
    if (!validTimelinePlacement(timelinePlacement)) throw new Error('素材の完成タイムライン範囲が不正です');
    durationFrames = Math.max(durationFrames, timelinePlacement.endFrame);
    return { ...rest, originalStart: timelinePlacement.startFrame, originalEnd: timelinePlacement.endFrame } as typeof item;
  }));
  return { ...independent, videoConfig: { ...project.videoConfig, durationFrames },
    cutRegions: [], cutOrder: [], mainSpeed: 1, segmentSpeeds: {}, sceneTransitions: [],
    transcript: { ...project.transcript, words: finalWords(project) } };
}

/** Keep original stacking order, including gaps where an anchored item was cut away. */
export function mergePlacedAssets<T extends { id: number }>(order: readonly { id: number }[], source: T[], independent: T[]): T[] {
  const items = new Map([...source, ...independent].map(item => [item.id, item]));
  return order.flatMap(item => { const value = items.get(item.id); return value ? [value] : []; });
}

export function serializeTimelineBindings(project: AssetGroups): string | null {
  const placements: TimelineBinding[] = [];
  for (const collection of ASSET_COLLECTIONS) for (const item of project[collection] ?? []) {
    if (item.timelinePlacement === undefined) continue;
    if (!validTimelinePlacement(item.timelinePlacement) || !frame(item.originalStart) || !frame(item.originalEnd) || item.originalEnd <= item.originalStart) {
      throw new Error('素材の配置時刻が不正です');
    }
    placements.push({ collection, id: item.id, originalStart: item.originalStart, originalEnd: item.originalEnd });
  }
  if (placements.length === 0) return null;
  const result = JSON.stringify({ version: 1, placements }, null, 2) + '\n';
  parseTimelineBindings(result);
  return result;
}
export function parseTimelineBindings(source: string | null | undefined): TimelineBinding[] {
  if (source == null) return [];
  const root: unknown = JSON.parse(source);
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('editor-timeline.json が不正です');
  const obj = root as Record<string, unknown>;
  if (obj.version !== 1 || !Array.isArray(obj.placements) || Object.keys(obj).some(k => !['version', 'placements'].includes(k))) throw new Error('未対応の editor-timeline.json です');
  const seen = new Set<string>();
  return obj.placements.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('独立素材の登録が不正です');
    const v = value as Record<string, unknown>;
    if (!ASSET_COLLECTIONS.includes(v.collection as AssetCollection) || !frame(v.id) || !frame(v.originalStart) || !frame(v.originalEnd) || v.originalEnd <= v.originalStart
      || Object.keys(v).some(k => !['collection', 'id', 'originalStart', 'originalEnd'].includes(k))) throw new Error('独立素材の登録が不正です');
    const key = `${v.collection}:${v.id}`;
    if (seen.has(key)) throw new Error('独立素材のIDが重複しています');
    seen.add(key);
    return { collection: v.collection as AssetCollection, id: v.id, originalStart: v.originalStart, originalEnd: v.originalEnd };
  });
}

export function restorePlacedAssets<T extends PlaceableAsset, R extends { id: number; startFrame: number; endFrame?: number }>(
  collection: AssetCollection, legacy: T[], raw: R[], bindings: TimelineBinding[],
): T[] {
  const entries = new Map(bindings.filter(x => x.collection === collection).map(x => [x.id, x]));
  const rawById = new Map(raw.map(x => [x.id, x]));
  const counts = new Map<number, number>();
  for (const item of raw) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  return legacy.map(item => {
    const entry = entries.get(item.id);
    if (!entry) return item;
    const value = rawById.get(item.id);
    if (!value || counts.get(item.id) !== 1 || !validTimelinePlacement(value)) throw new Error('独立素材の完成時刻を読み取れません');
    const { startFrame, endFrame, ...rest } = value;
    return { ...item, ...rest, originalStart: entry.originalStart, originalEnd: entry.originalEnd,
      timelinePlacement: { startFrame, endFrame } };
  });
}
