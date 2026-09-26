import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadProject, serializeProject, type ProjectFiles } from './project';
import { parseCutData, serializeCutData } from './cutData';
import { parseTelopData } from './telopData';
import { applyCuts } from './cutEngine';
import { addCutRegion } from './cutEngine';
import { buildPlaybackModel } from '../preview/playbackModel';
import { VIDEO_CONFIG_SOURCE } from './__fixtures__/videoConfig.fixture';
import { TELOP_DATA_SOURCE } from './__fixtures__/telopData.fixture';
import { CUT_DATA_SOURCE } from './__fixtures__/cutData.fixture';
import {
  CUT_DATA_REORDERED_SOURCE,
  VIDEO_CONFIG_REORDERED_SOURCE,
} from './__fixtures__/cutDataReordered.fixture';

const TRANSCRIPT = readFileSync(
  new URL('./__fixtures__/transcript.fixture.json', import.meta.url),
  'utf8',
);

/** 並び替えプロジェクト（04_golf-short-0811 相当）のテロップ。再生 900-1000＝原素材 627-727。 */
const REORDERED_TELOP_SOURCE = `import type { TelopSegment } from './telopTypes';
export const telopData: TelopSegment[] = [
  { id: 1, startFrame: 900, endFrame: 1000, text: "並び替え区間の中", style: "normal", template: 1, animation: "fadeOnly", highlight: "" },
  { id: 2, startFrame: 100, endFrame: 200, text: "先頭区間", style: "normal", template: 1, animation: "fadeOnly", highlight: "" },
];
`;

const REORDERED_FILES: ProjectFiles = {
  videoConfigSource: VIDEO_CONFIG_REORDERED_SOURCE,
  telopDataSource: REORDERED_TELOP_SOURCE,
  cutDataSource: CUT_DATA_REORDERED_SOURCE,
  transcriptJson: TRANSCRIPT,
  projectConfigJson: null,
  seDataSource: null,
  insertImageDataSource: null,
  titleDataSource: null,
};

const IDENTITY_FILES: ProjectFiles = {
  videoConfigSource: VIDEO_CONFIG_SOURCE,
  telopDataSource: TELOP_DATA_SOURCE,
  cutDataSource: CUT_DATA_SOURCE,
  transcriptJson: TRANSCRIPT,
  projectConfigJson: null,
  seDataSource: null,
  insertImageDataSource: null,
  titleDataSource: null,
};

function playbackOrderOf(cutDataSource: string): unknown[] {
  return parseCutData(cutDataSource).map((s) => ({
    originalStart: s.originalStart,
    originalEnd: s.originalEnd,
    playbackStart: s.playbackStart,
    playbackEnd: s.playbackEnd,
  }));
}

describe('カット並び替え: 読込', () => {
  it('cutData.ts の配列順を再生順アンカーとして保持する', () => {
    const project = loadProject(REORDERED_FILES);
    expect(project.cutOrder).toHaveLength(14);
    expect(project.cutOrder?.[5]).toEqual({ originalStart: 602, originalEnd: 1383 });
  });

  it('並び替え後の再生座標で保存されたテロップを正しい原素材位置へアンカーする', () => {
    const project = loadProject(REORDERED_FILES);
    // 再生 900 は再生順 5 番目（原素材 602-1383・再生 875-1656）の 25 フレーム目。
    expect(project.telops[0]!.originalStart).toBe(627);
    expect(project.telops[0]!.originalEnd).toBe(727);
    // 再生 100 は先頭区間（原素材 378-589）。
    expect(project.telops[1]!.originalStart).toBe(478);
  });
});

describe('カット並び替え: 保存（往復）', () => {
  it('load→save で cutData.ts の並び順・再生フレームが保存される', () => {
    const project = loadProject(REORDERED_FILES);
    const out = serializeProject(project);
    // 明示された14区間は、原素材上で順方向に隣接していても分割境界を保つ。
    expect(playbackOrderOf(out.cutDataSource)).toEqual(playbackOrderOf(CUT_DATA_REORDERED_SOURCE));
    expect(out.cutDataSource).toContain('CUT_DURATION_FRAMES = 3272');
    expect(out.cutDataSource).toContain('ORIGINAL_DURATION_FRAMES = 11228');
  });

  it('テロップの再生フレームが往復で不変（並び替え区間の中でも）', () => {
    const project = loadProject(REORDERED_FILES);
    const out = serializeProject(project);
    const telops = parseTelopData(out.telopDataSource, project.videoConfig.fps, 11228);
    expect(telops[0]).toMatchObject({ startFrame: 900, endFrame: 1000 });
    expect(telops[1]).toMatchObject({ startFrame: 100, endFrame: 200 });
  });

  it('カット編集後も再生順が維持される（アンカーで rank を再導出）', () => {
    const project = loadProject(REORDERED_FILES);
    // 原素材 700-800 を追加カット（再生順 5 番目 [602,1383) の内部を削る）。
    const edited = { ...project, cutRegions: addCutRegion(project.cutRegions, { start: 700, end: 800 }) };
    const out = serializeProject(edited);
    const cuts = parseCutData(out.cutDataSource);
    // 分割された 2 区間は元の再生位置（5・6 番目）に留まり、後続はそのまま。
    const expectedStarts = parseCutData(CUT_DATA_REORDERED_SOURCE).flatMap(segment =>
      segment.originalStart === 602 ? [602, 800] : [segment.originalStart]);
    expect(cuts.map((c) => c.originalStart)).toEqual(expectedStarts);
    // 再生フレームは並び順で連続している。
    expect(cuts[0]!.playbackStart).toBe(0);
    for (let i = 1; i < cuts.length; i++) {
      expect(cuts[i]!.playbackStart).toBe(cuts[i - 1]!.playbackEnd);
    }
    // 総尺は 100 フレーム減る。
    expect(cuts.at(-1)!.playbackEnd).toBe(3272 - 100);
  });
});

describe('カット並び替え: 恒等順列プロジェクト（回帰）', () => {
  it('cutData.ts の出力が従来実装（applyCuts そのまま）とバイト同値', () => {
    const project = loadProject(IDENTITY_FILES);
    const out = serializeProject(project);
    const legacy = serializeCutData(
      CUT_DATA_SOURCE,
      applyCuts(12000, project.cutRegions),
      12000,
      11400,
    );
    expect(out.cutDataSource).toBe(legacy);
  });

  it('恒等順列では telopData の出力も従来どおり（再読込で同値）', () => {
    const project = loadProject(IDENTITY_FILES);
    const out = serializeProject(project);
    const again = loadProject({ ...IDENTITY_FILES, telopDataSource: out.telopDataSource, cutDataSource: out.cutDataSource });
    expect(again.telops).toEqual(project.telops);
  });
});

describe('カット並び替え: プレビュー再生モデル', () => {
  it('keptSegments が再生順（並び替え後）で並ぶ', () => {
    const project = loadProject(REORDERED_FILES);
    const model = buildPlaybackModel(project);
    expect(
      model.keptSegments.map((s) => ({
        originalStart: s.originalStart,
        originalEnd: s.originalEnd,
        playbackStart: s.playbackStart,
        playbackEnd: s.playbackEnd,
      })),
    ).toEqual(playbackOrderOf(CUT_DATA_REORDERED_SOURCE));
    expect(model.playbackDurationInFrames).toBe(3272);
  });

  it('テロップの再生位置が並び替え後の座標になる', () => {
    const project = loadProject(REORDERED_FILES);
    const model = buildPlaybackModel(project);
    expect(model.telops[0]).toMatchObject({ startFrame: 900, endFrame: 1000 });
  });
});
