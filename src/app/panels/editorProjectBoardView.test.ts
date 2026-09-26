import { describe, expect, it } from 'vitest';
import { editorProjectBoardView } from './editorProjectBoardView';

describe('案件カードのAI作業表示', () => {
  it.each([
    ['queued', '実行中'], ['running', '実行中'], ['applied', '保存確認中'], ['saved', '保存済み'],
    ['cancelled', '停止'], ['failed', '失敗'], ['unknown', '結果確認待ち'],
  ] as const)('%sを%sと表示する', (phase, label) => {
    expect(editorProjectBoardView({ projectId: 'video', editor: { connected: false, ready: false, dirty: false, failed: false },
      operation: { phase, updatedAt: 1, applied: phase === 'applied' || phase === 'saved', saved: phase === 'saved', reconciled: false },
      humanReview: null }).operationLabel).toBe(label);
  });

  it('適用後に停止したAI作業の保存未確認と、現在の編集画面dirtyを別表示する', () => {
    const view = editorProjectBoardView({ projectId: 'video', editor: { connected: true, ready: true, dirty: true, failed: false },
      operation: { phase: 'cancelled', updatedAt: 1, applied: true, saved: false, reconciled: false }, humanReview: 'pending' });
    expect(view.operationDetail).toBe('このAI作業の保存は未確認');
    expect(view.editorLabel).toBe('編集画面に接続中・未保存の変更あり');
  });

  it('人が確認して再開済みのunknownを確認待ちと表示しない', () => {
    expect(editorProjectBoardView({ projectId: 'video', editor: { connected: false, ready: false, dirty: false, failed: false },
      operation: { phase: 'unknown', updatedAt: 1, applied: false, saved: false, reconciled: true }, humanReview: null }).operationLabel)
      .toBe('結果確認済み');
  });

  it('読込失敗だけの画面とreadyが併存する一部失敗を区別する', () => {
    expect(editorProjectBoardView({ projectId: 'video',
      editor: { connected: true, ready: false, dirty: false, failed: true }, operation: null, humanReview: null }).editorLabel)
      .toBe('編集画面の読み込みに失敗');
    expect(editorProjectBoardView({ projectId: 'video',
      editor: { connected: true, ready: true, dirty: true, failed: true }, operation: null, humanReview: null }).editorLabel)
      .toBe('一部の編集画面は読み込み失敗・未保存の変更あり');
  });

  it.each([
    [null, '対象なし', false],
    ['pending', '未確認', true],
    ['partial', '一部確認', true],
    ['reviewed', '確認済み', false],
    ['unavailable', '取得できません', false],
  ] as const)('人確認%sを採用とは別の表示へ写す', (humanReview, label, needsHumanReview) => {
    const view = editorProjectBoardView({ projectId: 'video',
      editor: { connected: false, ready: false, dirty: false, failed: false }, operation: null, humanReview });
    expect(view.humanReviewLabel).toBe(label);
    expect(view.needsHumanReview).toBe(needsHumanReview);
  });
});
