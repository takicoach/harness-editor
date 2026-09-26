import type { PlaybackModel } from '../../preview/playbackModel';
import { validTimelinePlacement } from '../../core/timelinePlacement';
import type { EditState } from './editState';

export const ASSET_KEYS = { telop: 'telops', title: 'titles', image: 'images', videoInsert: 'videoInserts', bgm: 'bgm', se: 'se', shape: 'shapes' } as const;
export type AssetKind = keyof typeof ASSET_KEYS;
export type AssetPlacementAction = 'range' | 'move' | 'trim-start' | 'trim-end';

export function assetFinalRange(model: PlaybackModel, kind: AssetKind, id: number) {
  const item = model[ASSET_KEYS[kind]].find(x => x.id === id);
  if (!item) return null;
  if ('playbackStart' in item) return { start: item.playbackStart, end: item.playbackEnd };
  if ('playbackFrame' in item) return { start: item.playbackFrame, end: item.playbackEnd };
  return { start: item.startFrame, end: item.endFrame };
}

/** Only an actual time edit switches a source-following asset to final placement. */
export function placeAsset(state: EditState, model: PlaybackModel, kind: AssetKind, id: number, start: number, end: number, action: AssetPlacementAction = 'range'): EditState {
  if (!validTimelinePlacement({ startFrame: start, endFrame: end }) || end > model.durationInFrames) return state;
  const range = assetFinalRange(model, kind, id);
  if (!range || (range.start === start && range.end === end)) return state;
  const key = ASSET_KEYS[kind];
  const video = kind === 'videoInsert' ? model.videoInserts.find(x => x.id === id) : undefined;
  // Capture the effective playback rate once. Moving later must not multiply it
  // by the main-video speed again. A left trim advances the source in-point.
  const sourceInFrame = video ? (video.sourceInFrame ?? 0) + (action === 'trim-start' ? Math.round((start - range.start) * (video.playbackRate ?? 1)) : 0) : 0;
  if (sourceInFrame < 0) return state;
  return { ...state, [key]: state[key].map(item => item.id !== id ? item : {
    ...item, timelinePlacement: { startFrame: start, endFrame: end },
    ...(video ? { playbackRate: video.playbackRate ?? 1, sourceInFrame } : {}),
  }) };
}

/** A visual text clip keeps its text on both sides, as a title split does. */
export function splitPlacedText(state: EditState, model: PlaybackModel, kind: 'telop' | 'title', id: number, frame: number): EditState {
  const range = assetFinalRange(model, kind, id), key = ASSET_KEYS[kind];
  if (!range || !Number.isSafeInteger(frame) || frame <= range.start || frame >= range.end) return state;
  const item = state[key].find(x => x.id === id);
  if (!item) return state;
  const nextKey = kind === 'telop' ? 'nextTelopId' : 'nextTitleId';
  const nextId = state[nextKey];
  const items = state[key].flatMap(x => x.id !== id ? [x] : [
    { ...x, timelinePlacement: { startFrame: range.start, endFrame: frame } },
    { ...x, id: nextId, timelinePlacement: { startFrame: frame, endFrame: range.end } },
  ]);
  return { ...state, [key]: items, [nextKey]: nextId + 1, selection: { kind, id: nextId }, multiTelopIds: [] };
}
