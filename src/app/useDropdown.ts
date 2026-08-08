import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * ドロップダウン共通挙動（spec §エッジケース）:
 * 外側クリック・Esc で閉じる。Esc で閉じたらトリガーへフォーカスを戻す。
 * ⚙設定 / ＋追加 / ⚠警告 の 3 メニューが共用する。
 */
export function useDropdown(): {
  open: boolean;
  setOpen: (v: boolean) => void;
  rootRef: RefObject<HTMLDivElement>;
  triggerRef: RefObject<HTMLButtonElement>;
} {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent): void {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        // メニューが開いている間の Esc は「メニューを閉じる」専用にする。
        // capture＋stopImmediatePropagation で、window の他の Esc ハンドラ
        // （例: タイムラインの範囲選択解除）が同時に発火するのを防ぐ。
        e.stopImmediatePropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return { open, setOpen, rootRef, triggerRef };
}
