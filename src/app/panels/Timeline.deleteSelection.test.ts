/**
 * @vitest-environment jsdom
 *
 * Delete の対象と、効かないときの説明（サイクル 1 レビューの残件）。
 * - タイトルは removeTitle を持っているのに Delete の分岐が無く、無反応だった。
 * - 字幕は「消えない」だけで理由が出ず、壊れているように見えた。
 */
import { describe, expect, it } from 'vitest';
import { createEditState, type EditState, type Selection } from '../edit/editState';
import type { EditorProject } from '../../core/types';
import { deleteBlockedReason, removeOpForSelection } from './Timeline';

function baseProject(): EditorProject {
  return {
    videoConfig: {
      format: 'short',
      fps: 30,
      durationFrames: 900,
      videoFile: 'main.mp4',
      resolution: { width: 1080, height: 1920 },
      orientation: 'portrait',
      titleStyle: { top: 100, left: 60, fontSize: 60 },
    },
    telops: [
      { id: 1, originalStart: 0, originalEnd: 90, text: 'じまく' },
      { id: 2, originalStart: 100, originalEnd: 200, text: 'かざり', template: 5, manual: true },
    ],
    cutRegions: [],
    se: [],
    images: [],
    titles: [],
    transcript: [],
    telopDataSource: '',
    cutDataSource: '',
    seDataSource: null,
    insertImageDataSource: null,
  } as unknown as EditorProject;
}

function stateWithTitle(): EditState {
  const s = createEditState(baseProject());
  return {
    ...s,
    titles: [{ id: 7, originalStart: 0, originalEnd: 60, text: 'タイトル' }] as EditState['titles'],
    selection: { kind: 'title', id: 7 },
  };
}

describe('removeOpForSelection', () => {
  it('タイトルを選んだ Delete で消える', () => {
    const state = stateWithTitle();
    const op = removeOpForSelection(state.selection, state);
    expect(op).not.toBeNull();
    expect(op!(state).titles).toEqual([]);
  });

  it('字幕は従来どおり消えない（区間カットという契約を変えない）', () => {
    const state = createEditState(baseProject());
    const selection = { kind: 'telop', id: 1 } as const;
    expect(removeOpForSelection(selection, { ...state, selection })).toBeNull();
  });
});

describe('deleteBlockedReason', () => {
  it('字幕には代わりの操作先を示す', () => {
    const state = createEditState(baseProject());
    const reason = deleteBlockedReason({ kind: 'telop', id: 1 }, state);
    expect(reason).toContain('文字起こし');
  });

  it('飾りテロップには何も言わない（普通に消えるため）', () => {
    const state = createEditState(baseProject());
    expect(deleteBlockedReason({ kind: 'telop', id: 2 }, state)).toBeNull();
  });

  it('種類ごとに代わりの操作先を言い、無関係な案内をしない（サイクル 2 Minor）', () => {
    const state = createEditState(baseProject());

    const main = deleteBlockedReason({ kind: 'mainVideo' }, state);
    expect(main).toContain('設定パネル');
    // 「範囲を選んでカット」はメイン動画・つなぎ目では解決にならない案内。
    expect(main).not.toContain('範囲');

    const join = deleteBlockedReason({ kind: 'join', at: 'head' }, state);
    expect(join).toContain('つなぎ目');
    expect(join).toContain('設定パネル');
    expect(join).not.toContain('範囲');

    // 区間だけは「範囲を選ぶ」が正しい案内。
    const segSelection: Selection = { kind: 'cutSegment', id: 1 };
    const seg = deleteBlockedReason(segSelection, state);
    expect(seg).toContain('範囲');
  });

  it('無選択は何も言わない', () => {
    const state = createEditState(baseProject());
    expect(deleteBlockedReason(null, state)).toBeNull();
  });
});
