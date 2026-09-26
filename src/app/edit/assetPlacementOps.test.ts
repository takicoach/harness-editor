import { expect, it } from 'vitest';
import { loadProject } from '../../core/project';
import { buildPlaybackModel } from '../../preview/playbackModel';
import { createEditState, toEditorProject } from './editState';
import { assetFinalRange, placeAsset, splitPlacedText, ASSET_KEYS, type AssetKind } from './assetPlacementOps';

function fixture() {
  const p = loadProject({ videoConfigSource: "export const FORMAT='youtube';export const FPS=30;export const DURATION_FRAMES=120;export const VIDEO_FILE='main.mp4';export const RESOLUTION={width:320,height:180};",
    telopDataSource: 'export const telopData=[];', cutDataSource: null, transcriptJson: '{"words":[],"segments":[]}', projectConfigJson: null, seDataSource: null, insertImageDataSource: null, titleDataSource: null });
  const common = { id: 1, originalStart: 0, originalEnd: 20 };
  p.telops = [{ ...common, text: '字幕' }]; p.titles = [{ ...common, text: '題名' }];
  p.images = [{ ...common, file: 'a.png', type: 'photo' }];
  p.videoInserts = [{ ...common, file: 'a.mp4', sourceInFrame: 12, playbackRate: 1.5 }];
  p.bgm = [{ ...common, file: 'a.wav', volume: 1, fadeInFrames: 0, fadeOutFrames: 0 }];
  p.se = [{ ...common, file: 'a.wav', volume: 1 }];
  p.shapes = [{ ...common, kind: 'rect', color: '#fff', thickness: 'medium', opacity: 1, x1: 0, y1: 0, x2: 1, y2: 1 }];
  p.mainSpeed = 2;
  const state = { ...createEditState(p), telops: p.telops, titles: p.titles, nextTelopId: 2, nextTitleId: 2 };
  return { p, state, model: buildPlaybackModel(toEditorProject(state, p)) };
}
it.each(Object.keys(ASSET_KEYS) as AssetKind[])('only an actual %s time change creates an independent placement', kind => {
  const { p, state, model } = fixture();
  const range = assetFinalRange(model, kind, 1)!;
  expect(placeAsset(state, model, kind, 1, range.start, range.end)).toBe(state);
  const next = placeAsset(state, model, kind, 1, 25, 35);
  expect(assetFinalRange(buildPlaybackModel(toEditorProject(next, p)), kind, 1)).toEqual({ start: 25, end: 35 });
  expect(next[ASSET_KEYS[kind]][0]).toMatchObject({ originalStart: 0, originalEnd: 20, timelinePlacement: { startFrame: 25, endFrame: 35 } });
  for (const other of Object.keys(ASSET_KEYS) as AssetKind[]) if (other !== kind) expect(next[ASSET_KEYS[other]]).toBe(state[ASSET_KEYS[other]]);
});
it('subvideo movement captures effective speed once; a left trim advances its source', () => {
  const { p, state, model } = fixture();
  const moved = placeAsset(state, model, 'videoInsert', 1, 25, 35, 'move');
  expect(moved.videoInserts[0]).toMatchObject({ sourceInFrame: 12, playbackRate: 3 });
  const nextModel = buildPlaybackModel(toEditorProject(moved, p));
  const trimmed = placeAsset(moved, nextModel, 'videoInsert', 1, 30, 35, 'trim-start');
  expect(trimmed.videoInserts[0]).toMatchObject({ sourceInFrame: 27, playbackRate: 3 });
  expect(placeAsset(moved, nextModel, 'videoInsert', 1, 0, 35, 'trim-start')).toBe(moved);
});

it.each(['telop', 'title'] as const)('splits a placed %s at the final playhead without shifting its text or source anchors', kind => {
  const { p, state, model } = fixture();
  const placed = placeAsset(state, model, kind, 1, 25, 45);
  const placedModel = buildPlaybackModel(toEditorProject(placed, p));
  const next = splitPlacedText(placed, placedModel, kind, 1, 35);
  const key = ASSET_KEYS[kind];
  expect(next[key]).toHaveLength(2);
  expect(next[key].map(x => [x.id, x.originalStart, x.originalEnd, x.text, x.timelinePlacement])).toEqual([
    [1, 0, 20, state[key][0]!.text, { startFrame: 25, endFrame: 35 }],
    [2, 0, 20, state[key][0]!.text, { startFrame: 35, endFrame: 45 }],
  ]);
  const output = buildPlaybackModel(toEditorProject(next, p));
  expect(assetFinalRange(output, kind, 1)).toEqual({ start: 25, end: 35 });
  expect(assetFinalRange(output, kind, 2)).toEqual({ start: 35, end: 45 });
  expect(next.selection).toEqual({ kind, id: 2 });
  expect(next[kind === 'telop' ? 'nextTelopId' : 'nextTitleId']).toBe(3);
  expect(next.images).toBe(placed.images);
  for (const frame of [24, 25, 45, 46, 30.5]) expect(splitPlacedText(placed, placedModel, kind, 1, frame)).toBe(placed);
});
