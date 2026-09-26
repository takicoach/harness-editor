import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadProject, serializeProject, type ProjectFiles } from '../../core/project';
import { parseCutData } from '../../core/cutData';
import { cutOrderingOf } from '../../core/cutOrder';
import { CUT_DATA_REORDERED_SOURCE, VIDEO_CONFIG_REORDERED_SOURCE } from '../../core/__fixtures__/cutDataReordered.fixture';
import { createEditState, samePersistedContent, toEditorProject } from './editState';
import { moveCutSegment } from './cutOrderOps';

const files: ProjectFiles = {
  videoConfigSource: VIDEO_CONFIG_REORDERED_SOURCE,
  cutDataSource: CUT_DATA_REORDERED_SOURCE,
  telopDataSource: `export const telopData = [
    { id: 1, startFrame: 900, endFrame: 1000, text: '素材に追随する字幕', style: 'normal', template: 1, animation: 'fadeOnly', highlight: '' },
    { id: 2, startFrame: 100, endFrame: 200, text: '冒頭の字幕', style: 'normal', template: 1, animation: 'fadeOnly', highlight: '' }
  ];`,
  transcriptJson: readFileSync(new URL('../../core/__fixtures__/transcript.fixture.json', import.meta.url), 'utf8'),
  projectConfigJson: null, seDataSource: null, insertImageDataSource: null, titleDataSource: null,
};

describe('manual ordering independent persistence audit', () => {
  it('moving a clip to the end survives serialization while subtitles retain their source timing', () => {
    const project = loadProject(files);
    const original = createEditState(project);
    const originalOrder = cutOrderingOf(original).segments;
    const changed = moveCutSegment(original, originalOrder[0]!.id, originalOrder.length - 1);
    const saved = serializeProject(toEditorProject(changed, project));
    const parsed = parseCutData(saved.cutDataSource);
    expect(parsed.map(s => s.originalStart)).toEqual([
      ...originalOrder.slice(1).map(s => s.originalStart), originalOrder[0]!.originalStart,
    ]);
    const reloaded = loadProject({ ...files, ...saved });
    expect(reloaded.telops).toEqual(project.telops);
    expect(parsed.at(-1)!.playbackEnd).toBe(originalOrder.at(-1)!.playbackEnd);
    expect(samePersistedContent(changed, createEditState(reloaded))).toBe(true);
  });

  it('moving back restores original content and does not mutate the prior undo state', () => {
    const project = loadProject(files);
    const original = createEditState(project);
    const snapshot = JSON.stringify(original);
    const order = cutOrderingOf(original).segments;
    const moved = moveCutSegment(original, order[0]!.id, order.length - 1);
    const movedOrder = cutOrderingOf(moved).segments;
    const restored = moveCutSegment(moved, movedOrder.at(-1)!.id, 0);
    expect(samePersistedContent(original, restored)).toBe(true);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(serializeProject(toEditorProject(restored, project))).toEqual(serializeProject(project));
  });
});
