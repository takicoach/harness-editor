/** 左サイドバー（プロジェクト/素材）の開閉状態の永続化。既定は開。 */
const KEY = 'sme-folder-open';

/** localStorage から開閉状態を読む。未設定・読めない場合は開（true）。 */
export function loadFolderOpen(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'closed';
  } catch {
    return true;
  }
}

/** 開閉状態を localStorage に保存（失敗は無視）。 */
export function saveFolderOpen(open: boolean): void {
  try {
    localStorage.setItem(KEY, open ? 'open' : 'closed');
  } catch {
    /* 失敗は無視 */
  }
}
