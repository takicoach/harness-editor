import { useEffect, useRef } from 'react';

/**
 * ダイアログを Escape で閉じる（status-ia-12）。
 *
 * ヘルプ（HelpModal）とホームの作成モーダルだけが Escape に対応しており、
 * 書き出し・削除確認は同じ見た目なのに閉じられない、という不統一があった。
 * 閉じ方の規則をここへ 1 つ置き、各ダイアログはこれを呼ぶ。
 *
 * - IME 変換確定中（isComposing）の Escape は握らない（変換のキャンセルに譲る）。
 * - onClose は ref に保持し、毎レンダーで購読し直さない。
 */
export function useDialogEscape(onClose: () => void, enabled = true): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent): void {
      if (e.isComposing) return;
      if (e.key !== 'Escape') return;
      // 意図: この Escape は「このダイアログを閉じる」で使い切る。
      // 背後のタイムラインには「カット選択帯を解除する」Escape 購読があり（interaction-11）、
      // そちらへ流すと 1 回の Escape でダイアログが閉じると同時に選択帯まで消える。
      // window の同一相に複数の購読が並ぶ構成なので、bubbling を止めるのではなく
      // 「同じ target の他リスナへ渡さない」ことが目的（stopImmediatePropagation ではなく
      // stopPropagation で足りるのは、購読がすべて window 直付けで capture 相を使わないため）。
      e.stopPropagation();
      onCloseRef.current();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
