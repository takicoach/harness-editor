import { useSyncExternalStore } from 'react';

/**
 * documentElement の `data-theme` 属性を購読し、現在のテーマ文字列（'dark' | 'light'）を返す。
 *
 * 用途: canvas 等「CSS 変数だけでは色を追従できない描画」を、テーマ切替時に再描画させるトリガ。
 * 返り値を effect の依存配列に入れると、`data-theme` が変わるたびに effect が再実行され、
 * getComputedStyle で読み直したテーマ別の色で描き直せる。
 *
 * useTheme（App の React state）とは独立に DOM 属性の実値を購読するため、
 * ツリーのどこからでも prop 配線なしで使える。
 */
function subscribe(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}

function getSnapshot(): string {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') ?? 'dark';
}

export function useThemeValue(): string {
  // サーバースナップショットはダーク既定（このアプリはクライアント専用だが SSR 安全側に倒す）。
  return useSyncExternalStore(subscribe, getSnapshot, () => 'dark');
}
