/** 左サイドバー（プロジェクト/素材）の開閉状態の永続化。既定は開。 */
const KEY = 'sme-folder-open';

/** 保存した選択を優先。未設定・読めない場合だけ画面幅に応じた既定を使う。 */
export function loadFolderOpen(defaultOpen = true): boolean {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'closed' ? false : stored === 'open' ? true : defaultOpen;
  } catch {
    return defaultOpen;
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
