/** Native scene scope replaces assertions about the removed Player's DOM wrappers.
 * Actual main/insert/background pixel effects remain covered by colorGradePixels.e2e. */
import { describe, expect, it } from 'vitest';
import type { EditorProject } from '../core/types';
import type { ColorGrade } from '../core/colorGrade';
import { migrateLegacySequence } from '../core/sequence/migrateLegacy';
import { ScenePlan } from '../core/sequence/scenePlan';
import { rational as r } from '../core/sequence/time';

const grade: ColorGrade = { brightness: 20, contrast: -25, saturation: 40, temperature: 35 };
function scene(colorGrade?: ColorGrade) {
  const project: EditorProject = {
    videoConfig: { fps: 30, durationFrames: 120, videoFile: 'main.mp4', format: 'youtube', orientation: 'landscape', resolution: { width: 640, height: 360 }, titleStyle: { top: 10, left: 10, fontSize: 20 } },
    projectConfig: null, transcript: { durationMs: 4000, words: [], segments: [] },
    telops: [{ id: 1, originalStart: 0, originalEnd: 120, text: 'caption', template: 1 }],
    images: [{ id: 1, originalStart: 0, originalEnd: 120, file: 'still.png', type: 'photo', scale: 1 }],
    titles: [{ id: 1, originalStart: 0, originalEnd: 120, text: 'title' }],
    videoInserts: [{ id: 7, originalStart: 0, originalEnd: 120, file: 'insert.mp4', sourceInFrame: 0, scale: 1 }],
    mainLayout: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false, background: '#123456' },
    se: [], cutRegions: [], mainSpeed: 1, segmentSpeeds: {}, colorGrade,
    telopDataSource: '', cutDataSource: null, seDataSource: null, insertImageDataSource: null, titleDataSource: null,
  };
  const { document } = migrateLegacySequence({ id: 'scope', name: 'scope', sourceFingerprint: 'scope', project,
    assets: [
      { id: 'video', kind: 'media', name: 'video', file: 'public/main.mp4', fingerprint: 'video', streams: [{ index: 0, kind: 'video', duration: r(4), codec: 'h264', width: 640, height: 360, frameRate: r(30) }] },
      { id: 'still', kind: 'image', name: 'still', file: 'public/images/still.png', fingerprint: 'still', streams: [] },
      { id: 'component', kind: 'component', name: 'component', file: '.harness/component.js', fingerprint: 'component', streams: [] },
    ], bindings: { main: 'video', telopComponent: 'component', imageComponent: 'component', images: { 1: 'still' }, videoInserts: { 7: 'video' }, bgm: {}, se: {} } });
  return { document, visuals: new ScenePlan(document).frame(15).visuals.map(item => item.clip) };
}

describe('native color correction remains scoped to main and inserted video', () => {
  it('actually plans both video layers and the ungraded image/title/caption controls', () => {
    const { visuals } = scene();
    expect(visuals.filter(clip => clip.content.kind === 'video')).toHaveLength(2);
    expect(visuals.some(clip => clip.id === 'legacy-insert-7')).toBe(true);
    expect(visuals.filter(clip => clip.content.kind !== 'video')).toHaveLength(3);
  });
  it('preserves the same grade on main and inserted video without grading other visual layers or background', () => {
    const { document, visuals } = scene(grade);
    expect(visuals.filter(clip => clip.content.kind === 'video').map(clip => clip.visual?.colorGrade)).toEqual([grade, grade]);
    for (const clip of visuals.filter(clip => clip.content.kind !== 'video')) expect(clip.visual?.colorGrade).toBeUndefined();
    expect(document.background).toBe('#123456');
  });
  it('keeps absent correction absent on every planned visual', () => {
    for (const clip of scene().visuals) expect(clip.visual?.colorGrade).toBeUndefined();
  });
});
