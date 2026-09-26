import { useEffect, useRef } from 'react';
import { Icon } from '../Icon';
import { useFocusTrap } from '../useFocusTrap';
import { SHORTCUTS } from './shortcuts';
import {isEscape} from './keyboard';

/**
 * `?` で開くショートカット一覧。aria-modal ＋ useFocusTrap（Tab の閉じ込め）＋ 初期フォーカス＋ 閉じたら元の要素へ復帰。
 * isModalOpen() がワークスペースのショートカットを止める。背景クリックと Esc で閉じる。
 */
export function NativeShortcutsDialog({ onClose, onOpenHelp }: { onClose(): void; onOpenHelp?(): void }) {
  // onOpenHelp is optional for backwards compatibility with standalone component rendering
  const root = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose); close.current = onClose; // 意図: 最新の onClose を保持（マウント時 1 回だけ effect を走らせるため）
  useFocusTrap(root);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const key = (event: KeyboardEvent) => { if (isEscape(event)) { event.stopPropagation(); close.current(); } };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); previous?.focus(); };
  }, []);
  const groups = [...new Set(SHORTCUTS.map(s => s.group))];
  return <div className="native-dialog-backdrop" onClick={onClose}>
    <div ref={root} className="native-dialog native-shortcuts" role="dialog" aria-modal="true" aria-label="ショートカット一覧" onClick={event => event.stopPropagation()}>
      <div className="native-dialog-head"><strong>ショートカット</strong><button ref={closeButton} className="btn-ghost native-header-icon" aria-label="閉じる" onClick={onClose}><Icon name="x" /></button></div>
      {groups.map(group => <section key={group}><h3>{group}</h3><dl>
        {SHORTCUTS.filter(s => s.group === group).map(s => <div key={s.label}><dt>{s.keys.map((k, i) => <kbd key={i} className="native-key">{k}</kbd>)}</dt><dd>{s.label}</dd></div>)}
      </dl></section>)}
      {onOpenHelp && <div className="native-shortcuts-help">
        <button className="btn-secondary" onClick={() => { onClose(); onOpenHelp(); }}>使い方を見る</button>
      </div>}
    </div>
  </div>;
}
