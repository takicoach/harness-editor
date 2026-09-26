/** UI テーマ。'dark' が既定（:root のデザイントークン）、'light' は [data-theme="light"] で上書き。 */
export type Theme = 'dark' | 'light';

/** 設定パネルの選択。'system' は保存値を持たず OS に追従する。 */
export type ThemePreference = 'system' | Theme;

/** localStorage キー。index.html の初期化スクリプトと共有するためリテラルも合わせること。 */
export const THEME_STORAGE_KEY = 'sme-theme';

/**
 * 初期テーマを決める純関数。
 * 保存値が 'dark' | 'light' ならそれを優先（ユーザーの明示選択）。
 * 無効値・未保存なら OS の prefers-color-scheme（prefersDark）に追従する。
 */
export function resolveInitialTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === 'dark' || stored === 'light') return stored;
  return prefersDark ? 'dark' : 'light';
}

/** テーマを反転する。 */
export function toggleTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}
