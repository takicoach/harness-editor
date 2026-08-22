import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadProject, type ProjectFiles } from '../../core/project';
import { cutOrderingOf } from '../../core/cutOrder';
import { createEditState, toEditorProject } from './editState';
import {
  CUT_DATA_REORDERED_SOURCE,
  EXPECTED_PLAYBACK_ORDER,
  VIDEO_CONFIG_REORDERED_SOURCE,
} from '../../core/__fixtures__/cutDataReordered.fixture';

const TRANSCRIPT = readFileSync(
  new URL('../../core/__fixtures__/transcript.fixture.json', import.meta.url),
  'utf8',
);

const FILES: ProjectFiles = {
  videoConfigSource: VIDEO_CONFIG_REORDERED_SOURCE,
  telopDataSource: `export const telopData = [];\n`,
  cutDataSource: CUT_DATA_REORDERED_SOURCE,
  transcriptJson: TRANSCRIPT,
  projectConfigJson: null,
  seDataSource: null,
  insertImageDataSource: null,
  titleDataSource: null,
};

describe('EditState への並び替え情報の持ち回り', () => {
  it('createEditState が再生順アンカーと原素材総尺を引き取り、UI から写像を再導出できる', () => {
    const project = loadProject(FILES);
    const state = createEditState(project);
    expect(state.cutOrder).toHaveLength(14);
    expect(state.originalTotalFrames).toBe(11228);
    const ordering = cutOrderingOf(state);
    expect(ordering.identity).toBe(false);
    expect(ordering.segments.map((s) => s.playbackStart)).toEqual(
      EXPECTED_PLAYBACK_ORDER.map((s) => s.playbackStart),
    );
  });

  it('toEditorProject が再生順アンカーを保存側へ渡す（保存で並び順が落ちない）', () => {
    const project = loadProject(FILES);
    const state = createEditState(project);
    expect(toEditorProject(state, project).cutOrder).toEqual(project.cutOrder);
  });
});
