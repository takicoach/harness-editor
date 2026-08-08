/** 自動保存トグルの localStorage 永続。既定 ON（未設定・不正値のときも ON）。 */

const KEY = 'sme-auto-save-enabled';

/** localStorage から自動保存トグルを読む。未設定・不正値は既定 ON。 */
export function loadAutoSaveEnabled(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === null) return true;
    return v === '1';
  } catch {
    return true;
  }
}

/** 自動保存トグルを localStorage に保存（失敗は無視）。 */
export function saveAutoSaveEnabled(v: boolean): void {
  try {
    localStorage.setItem(KEY, v ? '1' : '0');
  } catch {
    /* 失敗は無視 */
  }
}

/**
 * ユーザーが自動保存トグルを明示的に選択済みか（localStorage に値がある）。
 * true ならサーバ既定値（e2e の autoSaveDefaultEnabled=false 等）で上書きしてはいけない
 * （ユーザーの明示選択が常に優先）。
 */
export function hasExplicitAutoSavePref(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}
