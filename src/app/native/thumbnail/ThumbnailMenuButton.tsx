import { useEffect, useRef, useState } from 'react';

export interface ThumbnailMenuItem { label: string; run(): void; disabled?: boolean }
/** 押すと項目の一覧を開くボタン。外をクリック・Esc で閉じる（Esc はキャンバスの選択解除まで届かせない）。 */
export function ThumbnailMenuButton({ label, disabled, items }: { label: string; disabled?: boolean; items: readonly ThumbnailMenuItem[] }) {
  const [open, setOpen] = useState(false), root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    window.addEventListener('pointerdown', close, true); window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', escape, true); };
  }, [open]);
  return <div className="native-thumbnail-menu" ref={root}>
    <button type="button" className="btn-ghost" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>{label}</button>
    {open && <div className="native-thumbnail-menu-list" role="menu" aria-label={label}>
      {items.map(item => <button key={item.label} type="button" role="menuitem" className="btn-ghost" disabled={item.disabled}
        onClick={() => { setOpen(false); item.run(); }}>{item.label}</button>)}
    </div>}
  </div>;
}
