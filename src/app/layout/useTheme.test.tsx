/** @vitest-environment jsdom */
// src/app/layout/useTheme.test.tsx
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTheme } from './useTheme';
import { THEME_STORAGE_KEY } from '../../core/theme';

let prefersDark = false; const listeners = new Set<(e: { matches: boolean }) => void>();
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('dark') && prefersDark, addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn), removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn) }));
});
afterEach(() => { localStorage.clear(); listeners.clear(); prefersDark = false; vi.unstubAllGlobals(); document.documentElement.removeAttribute('data-theme'); });

it('保存値があれば明示テーマ、無ければ system として OS に追従する', () => {
  localStorage.setItem(THEME_STORAGE_KEY, 'light');
  const { result } = renderHook(() => useTheme());
  expect(result.current.preference).toBe('light'); expect(result.current.theme).toBe('light');
  act(() => result.current.setPreference('system'));
  expect(result.current.preference).toBe('system'); expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  expect(result.current.theme).toBe('light');
  act(() => { prefersDark = true; listeners.forEach(fn => fn({ matches: true })); });
  expect(result.current.theme).toBe('dark'); expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
});

it('toggle は明示テーマとして保存する（ホーム画面の既存ボタン用）', () => {
  const { result } = renderHook(() => useTheme());
  act(() => result.current.toggle());
  expect(result.current.preference).toBe(result.current.theme);
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(result.current.theme);
});
