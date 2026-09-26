import { describe, expect, it } from 'vitest';
import type { EditorProject } from '../../core/types';
import { cutOrderingOf } from '../../core/cutOrder';
import { buildPlaybackModel } from '../../preview/playbackModel';
import {
  frameAtOverviewFraction,
  originalFrameToOverviewFrame,
  overviewFrameToPreviewFrame,
  overviewFractionForFrame,
  overviewWindowForFrames,
  previewFrameToOverviewFrame,
} from './overviewGeometry';

function makeMappedProject(): EditorProject {
  return {
    videoConfig: {
      format: 'short', fps: 30, durationFrames: 1000, videoFile: 'main.mp4',
      resolution: { width: 1920, height: 1080 }, orientation: 'landscape',
      titleStyle: { top: 60, left: 30, fontSize: 30 },
    },
    projectConfig: null,
    transcript: { durationMs: 33333, words: [], segments: [] },
    telops: [],
    cutRegions: [{ start: 200, end: 300 }, { start: 500, end: 600 }],
    cutOrder: [
      { originalStart: 600, originalEnd: 1000 },
      { originalStart: 0, originalEnd: 200 },
      { originalStart: 300, originalEnd: 500 },
    ],
    se: [], images: [], videoInserts: [], bgm: [], shapes: [], titles: [],
    telopDataSource: '', cutDataSource: null, seDataSource: null,
    insertImageDataSource: null, titleDataSource: null,
    mainSpeed: 1,
    segmentSpeeds: { 1: 2, 2: 0.5 },
  };
}

describe('overviewGeometry（完成後の時間軸）', () => {
  it('完成後フレームと全体帯の位置を往復する', () => {
    expect(overviewFractionForFrame(150, 600)).toBe(0.25);
    expect(frameAtOverviewFraction(0.25, 600)).toBe(150);
  });

  it('詳細可視域の両端を全体帯の範囲にする', () => {
    expect(overviewWindowForFrames(300, 500, 1000)).toEqual({ start: 0.3, end: 0.5 });
    expect(overviewWindowForFrames(800, 200, 1000)).toEqual({ start: 0.2, end: 0.8 });
  });

  it('帯の外側は完成動画の先頭と末尾へ丸める', () => {
    expect(frameAtOverviewFraction(-1, 100)).toBe(0);
    expect(frameAtOverviewFraction(2, 100)).toBe(100);
  });

  it('カット・並び替え・区間速度があっても完成後座標と素材確認座標を往復できる', () => {
    const project = makeMappedProject();
    const finalModel = buildPlaybackModel(project);
    const map = {
      originalTotalFrames: project.videoConfig.durationFrames,
      cutRegions: project.cutRegions,
      ordering: cutOrderingOf(project),
      finalModel,
    };

    // 素材確認中の Player frame は原本座標。完成後帯では、先頭へ並び替えられ
    // 2倍速になった区間の位置へ写る必要がある。
    const overviewFrame = previewFrameToOverviewFrame(650, map);
    expect(overviewFrame).not.toBe(650);
    expect(overviewFrameToPreviewFrame(overviewFrame, map)).toBe(650);
    expect(originalFrameToOverviewFrame(650, map)).toBe(overviewFrame);
    expect(finalModel.durationInFrames).toBeLessThan(project.videoConfig.durationFrames);
  });

  it('素材確認中にカット済み区間へ入っても完成後帯の範囲外へ出ない', () => {
    const project = makeMappedProject();
    const finalModel = buildPlaybackModel(project);
    const overviewFrame = previewFrameToOverviewFrame(250, {
      originalTotalFrames: project.videoConfig.durationFrames,
      cutRegions: project.cutRegions,
      ordering: cutOrderingOf(project),
      finalModel,
    });
    expect(overviewFrame).toBeGreaterThanOrEqual(0);
    expect(overviewFrame).toBeLessThan(finalModel.durationInFrames);
  });
});
