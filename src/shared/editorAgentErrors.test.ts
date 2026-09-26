import { describe, expect, it } from 'vitest';
import { publicEditorAgentError } from './editorAgentErrors';

describe('公開AI編集エラー分類', () => {
  it('実行中・未保存・結果不明を同じ要求の再送可にはしない', () => {
    expect(publicEditorAgentError(new Error('PROJECT_BUSY: 実行中です'))).toMatchObject({
      code: 'PROJECT_BUSY', retryable: false, recovery: { action: 'wait_then_revalidate' },
    });
    expect(publicEditorAgentError(new Error('UNSAVED_CHANGES: 未保存です'))).toMatchObject({
      code: 'UNSAVED_CHANGES', retryable: false, recovery: { action: 'wait_then_revalidate' },
    });
    expect(publicEditorAgentError(new Error('SAVE_RESULT_UNKNOWN: 応答を確認できません'))).toMatchObject({
      code: 'SAVE_RESULT_UNKNOWN', retryable: false, recovery: { action: 'reconcile_result' },
    });
  });

  it('allowlist外の大文字prefixも内部情報を公開しない', () => {
    const detail = publicEditorAgentError(new Error('PRIVATE_DISK_FAILURE: /Users/x/key token=secret'));
    expect(detail).toMatchObject({ error: 'AI編集の処理に失敗しました', code: 'INTERNAL_EDITOR_ERROR',
      retryable: false, recovery: { action: 'contact_operator' } });
    expect(JSON.stringify(detail)).not.toMatch(/PRIVATE_DISK|Users|secret/);
  });
});
