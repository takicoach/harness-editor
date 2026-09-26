import type { EditorProjectBoardItem } from '../../shared/editorBoard';

const LABELS: Record<NonNullable<EditorProjectBoardItem['operation']>['phase'], string> = {
  queued: '実行中', running: '実行中', applied: '保存確認中', saved: '保存済み',
  cancelled: '停止', failed: '失敗', unknown: '結果確認待ち',
};

export interface EditorProjectBoardView {
  operationLabel: string; operationDetail: string | null;
  operationTone: 'idle' | 'active' | 'saved' | 'warning' | 'error'; editorLabel: string;
  humanReviewLabel: string; humanReviewTone: 'idle' | 'saved' | 'warning' | 'error'; needsHumanReview: boolean;
}

export function editorProjectBoardView(item: EditorProjectBoardItem): EditorProjectBoardView {
  const operation = item.operation;
  const operationTone = operation === null ? 'idle'
    : operation.phase === 'saved' ? 'saved'
      : operation.phase === 'failed' ? 'error'
        : ['cancelled', 'unknown'].includes(operation.phase) ? 'warning' : 'active';
  return {
    operationLabel: operation === null ? 'まだありません' : operation.reconciled ? '結果確認済み' : LABELS[operation.phase],
    operationDetail: operation?.applied && !operation.saved && !operation.reconciled ? 'このAI作業の保存は未確認' : null,
    operationTone,
    humanReviewLabel: item.humanReview === null ? '対象なし'
      : item.humanReview === 'pending' ? '未確認'
        : item.humanReview === 'partial' ? '一部確認'
          : item.humanReview === 'reviewed' ? '確認済み' : '取得できません',
    humanReviewTone: item.humanReview === 'reviewed' ? 'saved'
      : item.humanReview === 'pending' || item.humanReview === 'partial' ? 'warning'
        : item.humanReview === 'unavailable' ? 'error' : 'idle',
    needsHumanReview: item.humanReview === 'pending' || item.humanReview === 'partial',
    editorLabel: item.editor.failed && item.editor.ready
      ? `一部の編集画面は読み込み失敗${item.editor.dirty ? '・未保存の変更あり' : ''}`
      : item.editor.failed ? '編集画面の読み込みに失敗'
        : item.editor.ready ? `編集画面に接続中${item.editor.dirty ? '・未保存の変更あり' : ''}`
          : item.editor.connected ? '編集画面を読み込み中' : '編集画面は未接続',
  };
}
