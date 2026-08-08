import { useCallback, useLayoutEffect, useState } from 'react';
import { type Theme, THEME_STORAGE_KEY, resolveInitialTheme, toggleTheme } from '../../core/theme';

/** 保存値（localStorage）と OS 設定から初期テーマを読む。private mode 等の例外は dark フォールバック。 */
function readInitialTheme(): Theme {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // private mode 等で localStorage 不可。
  }
  const prefersDark =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true;
  return resolveInitialTheme(stored, prefersDark);
}

/**
 * UI テーマの state を持ち、documentElement の data-theme へペイント前に反映する
 * （index.html の初期化スクリプトと同期。既存の data-folder/data-claude と同じ仕組み）。
 * toggle で dark⇔light を反転し localStorage へ永続する。
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((cur) => {
      const next = toggleTheme(cur);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // 永続できなくても切替自体は有効にする。
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
