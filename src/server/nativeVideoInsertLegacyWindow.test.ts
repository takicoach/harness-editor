import { expect, it } from 'vitest';
import type { EditorProject } from '../core/types';
import { migrateLegacySequence } from '../core/sequence/migrateLegacy';
import { ScenePlan } from '../core/sequence/scenePlan';
import { rational as r } from '../core/sequence/time';

// Fixed inputs from the retired OffthreadVideo props tests. Expected times below
// are literal rational seconds, not outputs from a second current clock helper.
it.each([
  { name: 'half speed', frames: 120, sourceIn: 10, rate: 0.5, first: r(1, 3), middle: r(4, 3), last: r(139, 60) },
  { name: 'default speed', frames: 100, sourceIn: 5, rate: undefined, first: r(1, 6), middle: r(11, 6), last: r(52, 15) },
])('retains the source anchor and complete exclusive display window at $name', row => {
  const project: EditorProject = {
    videoConfig: { fps: 30, durationFrames: 300, videoFile: 'main.mp4', format: 'youtube', orientation: 'landscape',
      resolution: { width: 640, height: 360 }, titleStyle: { top: 60, left: 30, fontSize: 36 }, telopBottomOffset: 80, telopFontSize: 72 },
    projectConfig: null, transcript: { durationMs: 10000, words: [], segments: [] },
    telops: [], titles: [], images: [], se: [], cutRegions: [], mainSpeed: 1, segmentSpeeds: {},
    videoInserts: [{ id: 1, originalStart: 0, originalEnd: row.frames, file: 'sub.mp4', sourceInFrame: row.sourceIn,
      ...(row.rate === undefined ? {} : { playbackRate: row.rate }) }],
    telopDataSource: '', cutDataSource: '', seDataSource: null, insertImageDataSource: null, titleDataSource: null,
  };
  const before = structuredClone(project);
  const { document } = migrateLegacySequence({ id: 'window', name: 'Window', sourceFingerprint: 'fixed-input', project,
    assets: [{ id: 'media', kind: 'media', name: 'Media', file: 'main.mp4', fingerprint: 'fixture', streams: [
      { index: 0, kind: 'video', duration: r(10), codec: 'h264', width: 640, height: 360, frameRate: r(30) },
    ] }], bindings: { main: 'media', videoInserts: { 1: 'media' }, images: {}, bgm: {}, se: {} } });
  const clip = document.clips.find(item => item.content.kind === 'video' && item.trackId !== 'v-main')!;
  expect(clip).toBeDefined();
  expect(clip.startFrame).toBe(0);
  expect(clip.durationFrames).toBe(row.frames);
  expect(clip.content).toMatchObject({ sourceIn: row.first, rate: row.rate === undefined ? r(1) : r(1, 2) });
  const plan = new ScenePlan(document);
  const at = (frame: number) => plan.frame(frame).visuals.find(item => item.clip.id === clip.id);
  expect(at(0)?.sourceTime).toEqual(row.first);
  expect(at(row.frames / 2)?.sourceTime).toEqual(row.middle);
  expect(at(row.frames - 1)?.sourceTime).toEqual(row.last);
  expect(at(row.frames)).toBeUndefined();
  expect(project).toEqual(before);
});
