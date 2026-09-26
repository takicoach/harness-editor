import { describe, expect, it } from 'vitest';
import { loadProject, serializeProject, type ProjectFiles } from './project';
import { buildPlaybackModel } from '../preview/playbackModel';
import { VIDEO_CONFIG_SOURCE } from './__fixtures__/videoConfig.fixture';
import { createEditState, samePersistedContent } from '../app/edit/editState';
import { evalDataModule } from './dataModule';
import { parseTimelineBindings } from './timelinePlacement';

const files: ProjectFiles = {
  videoConfigSource: VIDEO_CONFIG_SOURCE.replace('FPS = 60', 'FPS = 30').replace('DURATION_FRAMES = 12000', 'DURATION_FRAMES = 60'),
  telopDataSource: 'export const telopData = [];', cutDataSource: null,
  transcriptJson: '{"durationMs":2000,"words":[],"segments":[]}', projectConfigJson: null,
  seDataSource: null, insertImageDataSource: null, titleDataSource: null,
};
function project() {
  const p = loadProject(files);
  const placement = { timelinePlacement: { startFrame: 25, endFrame: 35 }, originalStart: 0, originalEnd: 10, id: 1 };
  p.telops = [{ ...placement, text: '独立字幕' }];
  p.titles = [{ ...placement, text: '独立タイトル' }];
  p.images = [{ ...placement, file: 'owned.png', type: 'photo', scale: 0.6 }];
  p.videoInserts = [{ ...placement, file: 'owned.mp4', sourceInFrame: 12, playbackRate: 1.5 }];
  p.bgm = [{ ...placement, file: 'owned.wav', volume: 0.5, fadeInFrames: 1, fadeOutFrames: 2 }];
  p.se = [{ ...placement, file: 'effect.wav', volume: 0.4 }];
  p.shapes = [{ ...placement, kind: 'rect', x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5, color: '#ffffff', thickness: 'medium', opacity: 0.8 }];
  p.ducking = { enabled: false, strength: 'mid' };
  return p;
}
function ranges(p: ReturnType<typeof project>) {
  const m = buildPlaybackModel(p);
  return [m.telops[0], m.titles[0], m.bgm[0], m.shapes[0]].map(x => [x?.startFrame, x?.endFrame])
    .concat([m.images[0], m.videoInserts[0]].map(x => [x?.playbackStart, x?.playbackEnd]))
    .concat([[m.se[0]?.playbackFrame, m.se[0]?.playbackEnd]]);
}

describe('完成時計での独立配置', () => {
  it('逆順のつなぎ目をまたぐ7種類を、そのままpreview/save/loadへ通す', () => {
    const p = project();
    p.cutOrder = [{ originalStart: 30, originalEnd: 60 }, { originalStart: 0, originalEnd: 30 }];
    expect(ranges(p)).toEqual(Array.from({ length: 7 }, () => [25, 35]));
    const saved = serializeProject(p);
    const loaded = loadProject({ ...files, ...saved });
    expect(ranges(loaded)).toEqual(ranges(p));
    expect(loaded.images[0]).toMatchObject(p.images[0]!);
    expect(loaded.videoInserts?.[0]).toMatchObject(p.videoInserts![0]!);
    expect(serializeProject(loaded)).toEqual(saved);
  });

  it('半速の奇数frameも丸めず、主映像の速度やcutを変えても独立配置を保つ', () => {
    const p = project();
    p.images[0]!.timelinePlacement = { startFrame: 1, endFrame: 11 };
    p.mainSpeed = 0.5;
    p.cutRegions = [{ start: 15, end: 25 }];
    expect(buildPlaybackModel(p).images[0]).toMatchObject({ playbackStart: 1, playbackEnd: 11 });
    const saved = serializeProject(p);
    const reloaded = loadProject({ ...files, ...saved });
    expect(reloaded.images[0]).toMatchObject(p.images[0]!);
    expect(buildPlaybackModel(reloaded).images[0]).toMatchObject({ playbackStart: 1, playbackEnd: 11 });
  });

  it('独立配置の変更がdirtyになり、旧案件にはメタデータを作らない', () => {
    const p = project();
    const a = createEditState(p);
    const b = { ...a, images: a.images.map(x => ({ ...x, timelinePlacement: { startFrame: 26, endFrame: 36 } })) };
    expect(samePersistedContent(a, b)).toBe(false);
    expect(serializeProject(loadProject(files)).editorTimelineJson).toBeNull();
  });

  it('独立BGMのダッキングは完成順の発話に合わせ、保存にも残す', () => {
    const p = project();
    p.bgm![0]!.timelinePlacement = { startFrame: 0, endFrame: 60 };
    p.cutOrder = [{ originalStart: 30, originalEnd: 60 }, { originalStart: 0, originalEnd: 30 }];
    p.transcript.words = [{ text: '話す', start: 100, end: 500 }];
    p.ducking = { enabled: true, strength: 'mid' };
    const expected = buildPlaybackModel(p).bgm[0]!.ducking;
    expect(expected?.regions.length).toBeGreaterThan(0);
    expect(expected?.regions[0]?.start).toBeGreaterThanOrEqual(30);
    const saved = serializeProject(p);
    const clips = evalDataModule(saved.bgmDataSource!, { './types': {}, './BgmSequence': {} }).bgmData as { ducking?: unknown }[];
    expect(clips[0]!.ducking).toEqual(expected);
  });

  it('破損した版・重複登録・不正frameのメタデータを採用しない', () => {
    const entry = { collection: 'images', id: 1, originalStart: 0, originalEnd: 10 };
    for (const value of [{ version: 2, placements: [] }, { version: 1, placements: [entry, entry] }, { version: 1, placements: [{ ...entry, originalStart: 0.5 }] }]) {
      expect(() => parseTimelineBindings(JSON.stringify(value))).toThrow();
    }
  });
});
