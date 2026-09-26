import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { type Theme, type ThemePreference, THEME_STORAGE_KEY, resolveInitialTheme, toggleTheme } from '../../core/theme';

function readStored(): string | null {
  try { return localStorage.getItem(THEME_STORAGE_KEY); } catch { return null; }
}
function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)').matches : true;
}

/**
 * UI テーマ。documentElement の data-theme へペイント前に反映する（index.html の初期化スクリプトと同期）。
 * preference が 'system' のときは保存値を消し、OS の変更にも追従する。toggle は明示テーマとして保存する。
 */
export function useTheme(): { theme: Theme; preference: ThemePreference; toggle: () => void; setPreference: (pref: ThemePreference) => void } {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => { const s = readStored(); return s === 'dark' || s === 'light' ? s : 'system'; });
  const [theme, setTheme] = useState<Theme>(() => resolveInitialTheme(readStored(), systemPrefersDark()));

  useLayoutEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);

  useEffect(() => {
    if (preference !== 'system' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = (event: { matches: boolean }) => setTheme(event.matches ? 'dark' : 'light');
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, [preference]);

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
    try { if (pref === 'system') localStorage.removeItem(THEME_STORAGE_KEY); else localStorage.setItem(THEME_STORAGE_KEY, pref); } catch { /* 永続できなくても切替は有効 */ }
    setTheme(pref === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : pref);
  }, []);

  const toggle = useCallback(() => { setPreference(toggleTheme(theme)); }, [theme, setPreference]);

  return { theme, preference, toggle, setPreference };
}
