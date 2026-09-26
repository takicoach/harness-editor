// src/shared/captureOverlays.test.ts
/**
 * 撮影（native capture）が要るかの述語（M2d T2 修正 I-3）。
 * サーバ（fastCutPlan）とクライアント（App の ExportDialog needsCapture）で同じ判定を使う。
 */
import { describe, it, expect } from 'vitest';
import { hasCaptureOverlays } from './captureOverlays';
import { buildPlaybackModel } from '../preview/playbackModel';
import type { EditorProject } from '../core/types';

describe('hasCaptureOverlays', () => {
  it('telops / titles / images がすべて空なら false', () => {
    expect(hasCaptureOverlays({ telops: [], titles: [], images: [] })).toBe(false);
  });

  it('いずれか1つでも非空なら true', () => {
    expect(hasCaptureOverlays({ telops: [{}], titles: [], images: [] })).toBe(true);
    expect(hasCaptureOverlays({ telops: [], titles: [{}], images: [] })).toBe(true);
    expect(hasCaptureOverlays({ telops: [], titles: [], images: [{}] })).toBe(true);
  });
});

/** 縮退 fixture: テロップが丸ごとカット区間に入る＝射影後は消える（サーバと同じ結論になるか）。 */
function projectWithTelopInsideCut(): EditorProject {
  return {
    videoConfig: {
      format: 'short',
      fps: 30,
      durationFrames: 300,
      videoFile: 'main.mp4',
      resolution: { width: 1080, height: 1920 },
      orientation: 'portrait',
      titleStyle: { top: 60, left: 30, fontSize: 30 },
    },
    projectConfig: null,
    transcript: { durationMs: 10000, words: [], segments: [] },
    // カット区間 [100,200) の内側だけに存在するテロップ（射影で縮退して消える）。
    telops: [{ id: 1, originalStart: 120, originalEnd: 180, text: 'あ' }],
    cutRegions: [{ start: 100, end: 200 }],
    se: [],
    images: [],
    videoInserts: [],
    bgm: [],
    shapes: [],
    telopDataSource: '',
    cutDataSource: null,
    seDataSource: null,
    insertImageDataSource: null,
    titles: [],
    titleDataSource: null,
    mainSpeed: 1,
    segmentSpeeds: {},
  };
}

describe('hasCaptureOverlays × プレビュー射影（App 側の needsCapture）', () => {
  it('テロップが全てカット区間内に収まるプロジェクトは false（射影後は消えるためサーバ判定と一致）', () => {
    const model = buildPlaybackModel(projectWithTelopInsideCut());
    // 非退化 fixture であることの確認（元データにはテロップが在る）。
    expect(projectWithTelopInsideCut().telops).toHaveLength(1);
    expect(hasCaptureOverlays(model)).toBe(false);
  });

  it('カット区間の外にテロップが残るなら true', () => {
    const p = projectWithTelopInsideCut();
    p.telops = [{ id: 1, originalStart: 10, originalEnd: 50, text: 'あ' }];
    expect(hasCaptureOverlays(buildPlaybackModel(p))).toBe(true);
  });
});
