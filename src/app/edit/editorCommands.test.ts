import { describe, expect, it } from 'vitest';
import { scriptAdoptionFixture } from '../../core/__fixtures__/scriptAdoption';
import { applyEditorChanges, validateEditorChanges } from './editorCommands';
import type { EditState } from './editState';
import { createHistory, current, pushState, undo } from './history';

function state(): EditState {
  return { telops: [{ id: 1, originalStart: 30, originalEnd: 60, text: '一つ目' },
    { id: 2, originalStart: 90, originalEnd: 120, text: '二つ目' }],
  cutRegions: [{ start: 0, end: 20 }], se: [], images: [], videoInserts: [], bgm: [], titles: [], shapes: [],
  selection: { kind: 'telop', id: 1 }, multiTelopIds: [], nextTelopId: 3, nextSeId: 1, nextImageId: 1,
  nextVideoInsertId: 1, nextBgmId: 1, nextTitleId: 1, nextShapeId: 1,
  sceneTransitions: [], nextTransitionId: 1, ducking: { enabled: true, strength: 'mid' },
  mainSpeed: 2, segmentSpeeds: {}, segmentLayouts: {}, layoutKeyframes: [] };
}
const context = { projectId: 'video', revision: 'session:3' };
function request() {
  return { schemaVersion: 1, operationId: 'op1', projectId: 'video', baseRevision: 'session:3', changes: [
    { type: 'set_telop_text', elementId: '1', before: '一つ目', after: '最初の字幕', sourceFrameRange: { start: 30, end: 60 } },
    { type: 'set_telop_text', elementId: '2', before: '二つ目', after: '次の字幕', sourceFrameRange: { start: 90, end: 120 } },
  ] };
}
describe('型付き字幕変更案の全件検証', () => {
  it('複数字幕を1つのUndoにまとめ、他の未保存編集を保つ', () => {
    const initial = state(); const next = applyEditorChanges(initial, context, request());
    expect(next.telops.map((t) => t.text)).toEqual(['最初の字幕', '次の字幕']);
    expect(next.cutRegions).toBe(initial.cutRegions);
    expect(next.selection).toBe(initial.selection);
    expect(next.mainSpeed).toBe(2);
    expect(current(undo(pushState(createHistory(initial), next)))).toEqual(initial);
  });
  it('2件目が不正でも1件目を途中まで適用しない', () => {
    const initial = state(); const input = request(); input.changes[1]!.elementId = 'missing';
    expect(() => applyEditorChanges(initial, context, input)).toThrow(/TARGET_NOT_FOUND/);
    expect(initial.telops.map((t) => t.text)).toEqual(['一つ目', '二つ目']);
  });
  it('案件・未保存版・本文・原本範囲の変更を個別に拒否する', () => {
    expect(() => validateEditorChanges(state(), context, { ...request(), projectId: 'other' })).toThrow(/PROJECT_MISMATCH/);
    expect(() => validateEditorChanges(state(), context, { ...request(), baseRevision: 'disk-only' })).toThrow(/REVISION_CONFLICT/);
    const changed = state(); changed.telops[0]!.text = '人が編集中';
    expect(() => validateEditorChanges(changed, context, request())).toThrow(/CONTENT_CONFLICT/);
    const moved = state(); moved.telops[0]!.originalStart = 31;
    expect(() => validateEditorChanges(moved, context, request())).toThrow(/RANGE_CONFLICT/);
  });
  it('重複対象・未知操作・自由コード・誤った版を受け付けない', () => {
    const input = request(); input.changes.push(input.changes[0]!);
    expect(() => validateEditorChanges(state(), context, input)).toThrow(/DUPLICATE_TARGET/);
    expect(() => validateEditorChanges(state(), context, { ...request(), changes: [{ type: 'run_code', code: 'anything' }] })).toThrow();
    expect(() => validateEditorChanges(state(), context, { ...request(), schemaVersion: 2 })).toThrow();
    expect(() => validateEditorChanges(state(), context, { ...request(), path: '/tmp/other' })).toThrow();
  });
});

describe('人が修正した台本変更案', () => {
  it('schema検証済みのmodificationを編集適用へ渡し、元artifactを保つ', () => {
    const artifact = scriptAdoptionFixture('caption');
    const artifactSnapshot = structuredClone(artifact);
    const initial: EditState = {
      ...state(),
      scriptDocument: structuredClone(artifact.input.alignment.packet.script),
      originalTotalFrames: artifact.input.editing.totalFrames,
      telops: artifact.input.editing.telops.map(telop => ({ ...telop })),
      cutRegions: artifact.input.editing.cutRegions.map(cut => ({ ...cut })),
      cutOrder: artifact.input.editing.cutOrder.map(range => ({ ...range })),
    };
    const scriptContext = { projectId: 'project', revision: 'session:script' };
    const input = {
      schemaVersion: 1,
      operationId: 'script:judgment-modified',
      projectId: 'project',
      baseRevision: 'session:script',
      script: {
        judgmentId: 'judgment-modified',
        artifact,
        modification: { kind: 'caption', changes: [{ telopId: 1, after: '人が直した字幕' }] },
      },
      changes: [],
    };

    expect(validateEditorChanges(initial, scriptContext, input)).toEqual([]);
    expect(applyEditorChanges(initial, scriptContext, input).telops[0]!.text).toBe('人が直した字幕');
    expect(artifact).toEqual(artifactSnapshot);
  });

  it('別ID、別kind、無変更のmodificationをcommand境界で拒否する', () => {
    const artifact = scriptAdoptionFixture('caption');
    const base = {
      schemaVersion: 1,
      operationId: 'script:judgment-modified',
      projectId: 'project',
      baseRevision: 'session:script',
      changes: [],
    };
    expect(() => validateEditorChanges(state(), context, {
      ...base,
      script: { judgmentId: 'judgment-modified', artifact,
        modification: { kind: 'caption', changes: [{ telopId: 99, after: '本文' }] } },
    })).toThrow(/TARGET_UNKNOWN/);
    expect(() => validateEditorChanges(state(), context, {
      ...base,
      script: { judgmentId: 'judgment-modified', artifact,
        modification: { kind: 'structure', cutOrder: [{ originalStart: 0, originalEnd: 30 }] } },
    })).toThrow(/KIND_MISMATCH/);
    expect(() => validateEditorChanges(state(), context, {
      ...base,
      script: { judgmentId: 'judgment-modified', artifact,
        modification: { kind: 'caption', changes: [{ telopId: 1, after: 'はい' }] } },
    })).toThrow(/NO_SCRIPT_MODIFICATION/);
  });
});
