import { describe, it, expect } from 'vitest';
import { createEditState } from './editState';
import { applyInsertMaterial } from './insertMaterial';
import type { EditorProject } from '../../core/types';

// editState.test.ts の sampleProject と同形の最小プロジェクト。
function sampleProject(): EditorProject {
  return {
    videoConfig: {
      format: 'short',
      fps: 30,
      durationFrames: 900,
      videoFile: 'main.mp4',
      resolution: { width: 1080, height: 1920 },
      orientation: 'portrait',
      titleStyle: { top: 60, left: 30, fontSize: 30 },
    },
    projectConfig: null,
    transcript: { durationMs: 30000, words: [], segments: [] },
    telops: [],
    cutRegions: [],
    se: [],
    images: [],
    bgm: [],
    telopDataSource: 'export const telopData = [];\n',
    cutDataSource: null,
    seDataSource: null,
    insertImageDataSource: null,
    titles: [],
    titleDataSource: null,
    mainSpeed: 1,
    segmentSpeeds: {},
  };
}

describe('applyInsertMaterial', () => {
  it('種別に応じた素材を originalStart へ追加する', () => {
    const base = createEditState(sampleProject());
    expect(applyInsertMaterial('se', base, 'beep.mp3', 30).se).toHaveLength(1);
    expect(applyInsertMaterial('image', base, 'a.png', 30).images).toHaveLength(1);
    expect(applyInsertMaterial('bgm', base, 'x.mp3', 30).bgm).toHaveLength(1);
    expect(applyInsertMaterial('video', base, 'sub/c.mp4', 30).videoInserts).toHaveLength(1);
  });
});
