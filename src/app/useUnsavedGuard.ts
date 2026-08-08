import { useEffect } from 'react';

/**
 * 未保存の変更（dirty）があるままタブを閉じる／リロードしようとした時に、
 * ブラウザ標準の確認ダイアログを出すフック。
 * dirty が false（保存済み・書き出し中の自動保存後 等）のときは警告しない。
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome 系は returnValue のセットが必須。
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
