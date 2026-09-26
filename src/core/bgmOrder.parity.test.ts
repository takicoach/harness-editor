import { describe, expect, it } from 'vitest';
import { loadProject, serializeProject, type ProjectFiles } from './project';
import { buildPlaybackModel } from '../preview/playbackModel';
import { parseBgmData } from './bgmData';
import { VIDEO_CONFIG_SOURCE } from './__fixtures__/videoConfig.fixture';

const files: ProjectFiles = {
  videoConfigSource: VIDEO_CONFIG_SOURCE.replace('FPS = 60', 'FPS = 30').replace('DURATION_FRAMES = 12000', 'DURATION_FRAMES = 60'),
  telopDataSource: 'export const telopData = [];', cutDataSource: null,
  transcriptJson: '{"durationMs":2000,"words":[],"segments":[]}', projectConfigJson: null,
  seDataSource: null, insertImageDataSource: null, titleDataSource: null,
};

describe('全尺BGMの並べ替え後のpreview/save/load一致', () => {
  for (const scenario of [
    { name: '通常順', reverse: false, speed: 1, cut: false, overlap: false, duration: 60 },
    { name: '前後逆順', reverse: true, speed: 1, cut: false, overlap: false, duration: 60 },
    { name: '逆順と半速', reverse: true, speed: 0.5, cut: false, overlap: false, duration: 120 },
    { name: '削除区間と逆順', reverse: true, speed: 1, cut: true, overlap: false, duration: 50 },
    { name: '逆順と重なり6frame', reverse: true, speed: 1, cut: false, overlap: true, duration: 54 },
  ]) it(scenario.name, () => {
    const project = loadProject(files);
    project.bgm = [{ id: 1, originalStart: 0, originalEnd: 60, file: 'owned.wav', volume: 0.5, fadeInFrames: 2, fadeOutFrames: 3 }];
    project.ducking = { enabled: false, strength: 'mid' };
    project.mainSpeed = scenario.speed;
    if (scenario.cut) project.cutRegions = [{ start: 10, end: 20 }];
    if (scenario.reverse) project.cutOrder = scenario.cut
      ? [{ originalStart: 20, originalEnd: 60 }, { originalStart: 0, originalEnd: 10 }]
      : [{ originalStart: 30, originalEnd: 60 }, { originalStart: 0, originalEnd: 30 }];
    if (scenario.overlap) project.sceneTransitions = [{ id: 1, at: 60, kind: 'crossfade', durationFrames: 6 }];
    const expected = [{ id: 1, startFrame: 0, endFrame: scenario.duration, file: 'owned.wav', volume: 0.5, fadeInFrames: 2, fadeOutFrames: 3 }];
    const model = buildPlaybackModel(project);
    expect(model.durationInFrames).toBe(scenario.duration);
    expect(model.bgm).toEqual(expected);
    const saved = serializeProject(project);
    expect(parseBgmData(saved.bgmDataSource)).toEqual(expected);
    const reloaded = loadProject({ ...files, ...saved });
    expect(buildPlaybackModel(reloaded).bgm).toEqual(expected);
    expect(parseBgmData(serializeProject(reloaded).bgmDataSource)).toEqual(expected);
  });
});
