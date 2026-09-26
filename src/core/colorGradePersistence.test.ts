/**
 * カラー補正の永続化ひとまわり（F-2）。
 *
 * 「エディタの編集状態 → EditorProject → mainLayoutData.ts の本文 → 読み戻し → 編集状態」
 * を通しで往復させる。どこか 1 段でも colorGrade を落とすと、
 * **保存したのに次に開いたら補正が消えている**（＝データ損失）になるので、
 * 段ごとのユニットテストではなくこの通しの計器で固定する。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadProject, serializeProject, type ProjectFiles } from './project';
import { VIDEO_CONFIG_SOURCE } from './__fixtures__/videoConfig.fixture';
import { TELOP_DATA_SOURCE } from './__fixtures__/telopData.fixture';
import { CUT_DATA_SOURCE } from './__fixtures__/cutData.fixture';
import { createEditState, toEditorProject } from '../app/edit/editState';
import { setColorGradeField, currentColorGrade } from '../app/edit/mainVideoOps';
import { DEFAULT_COLOR_GRADE } from './colorGrade';

const TRANSCRIPT = readFileSync(
  new URL('./__fixtures__/transcript.fixture.json', import.meta.url),
  'utf8',
);

const FILES: ProjectFiles = {
  videoConfigSource: VIDEO_CONFIG_SOURCE,
  telopDataSource: TELOP_DATA_SOURCE,
  cutDataSource: CUT_DATA_SOURCE,
  transcriptJson: TRANSCRIPT,
  projectConfigJson: null,
  seDataSource: null,
  insertImageDataSource: null,
  titleDataSource: null,
};

/** 編集 → 保存 → 読み戻しの 1 往復。戻ってきた編集状態を返す。 */
function roundTrip(edit: (s: ReturnType<typeof createEditState>) => ReturnType<typeof createEditState>) {
  const base = loadProject(FILES);
  const edited = edit(createEditState(base));
  const project = toEditorProject(edited, base);
  const sources = serializeProject(project);
  const reloaded = loadProject({ ...FILES, mainLayoutDataSource: sources.mainLayoutDataSource });
  return { sources, state: createEditState(reloaded) };
}

describe('カラー補正の保存往復', () => {
  it('4 項目すべてが保存され、読み戻して同じ値になる', () => {
    const { sources, state } = roundTrip((s) => {
      let n = setColorGradeField(s, 'brightness', 25);
      n = setColorGradeField(n, 'contrast', -30);
      n = setColorGradeField(n, 'saturation', 45);
      n = setColorGradeField(n, 'temperature', -12);
      return n;
    });
    expect(sources.mainLayoutDataSource).not.toBeNull();
    expect(sources.mainLayoutDataSource).toContain('COLOR_GRADE');
    expect(currentColorGrade(state)).toEqual({
      brightness: 25, contrast: -30, saturation: 45, temperature: -12,
    });
  });

  it('無補正のままなら mainLayoutData.ts を作らない（既存案件にファイルが生えない）', () => {
    const { sources, state } = roundTrip((s) => s);
    expect(sources.mainLayoutDataSource).toBeNull();
    expect(currentColorGrade(state)).toEqual(DEFAULT_COLOR_GRADE);
  });

  it('元動画のファイル名・カット区間は補正で一切変わらない（非破壊）', () => {
    const before = loadProject(FILES);
    const { state } = roundTrip((s) => setColorGradeField(s, 'brightness', 40));
    const after = loadProject({ ...FILES });
    expect(after.videoConfig.videoFile).toBe(before.videoConfig.videoFile);
    expect(after.cutRegions).toEqual(before.cutRegions);
    expect(currentColorGrade(state).brightness).toBe(40);
  });
});
