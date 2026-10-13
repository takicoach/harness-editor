import { useEffect, useRef } from 'react';
import { isModalOpen } from '../../isModalOpen';
import { deleteSelection, duplicateSelection, isEditable, moveSelection, reorderSelection } from './layerActions';
import type { ThumbnailEditor } from './useThumbnailEditor';

const ARROWS: Record<string, { x: number; y: number }> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
/** このフックが受けるキー（ドラッグ中は useCanvasGestures がこれを止める。Esc はドラッグの取り消しに使う）。 */
export function isCanvasKey(event: KeyboardEvent): boolean {
  const mod = event.metaKey || event.ctrlKey, letter = event.key.toLowerCase();
  if (mod) return letter === 'z' || letter === 'd' || event.key === '[' || event.key === ']';
  return event.key === 'Escape' || event.key === 'Delete' || event.key === 'Backspace' || event.key === 'Enter' || event.key in ARROWS;
}
/** 矢印＝1px（Shift で 10px）・Cmd+D＝複製・Delete＝削除・Cmd+[ ]＝重なり順・Cmd+Z／Cmd+Shift+Z・Esc。入力欄・ダイアログ・変換中は受けない。 */
export function useCanvasKeys(editor: ThumbnailEditor): void {
  const latest = useRef(editor);
  latest.current = editor;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null, current = latest.current;
      if (event.defaultPrevented || event.isComposing || isModalOpen() || target?.closest('input,textarea,select,[contenteditable=true],[role=dialog]')) return;
      const mod = event.metaKey || event.ctrlKey, letter = event.key.toLowerCase();
      if (mod && letter === 'z') { event.preventDefault(); void current.execute({ type: event.shiftKey ? 'redo' : 'undo' }); return; }
      if (event.key === 'Escape') { current.select([]); return; }
      if (!current.selected.length || current.disabled || current.editingText) return;
      // ボタン・リンクにフォーカスがあるときの Delete・Backspace・Enter はそのボタンのもの（レイヤーを消さない・編集を始めない）。
      // ただしレイヤー一覧の行（選択の入口）は除外しない（行で選んで Delete で消せるように）。
      const onControl = !!target?.closest('button,a') && !target?.closest('[data-layer-select]');
      if (event.key === 'Delete' || event.key === 'Backspace') { if (onControl) return; event.preventDefault(); void deleteSelection(current); return; }
      if (event.key === 'Enter' && !mod && current.selected.length === 1 && !onControl) {
        const layer = current.page.layers.find(item => item.id === current.selected[0]);
        if (layer?.content.kind === 'text' && isEditable(layer)) { event.preventDefault(); current.setEditingText(layer.id); }
        return;
      }
      if (mod && letter === 'd') { event.preventDefault(); void duplicateSelection(current); return; }
      if (mod && (event.key === '[' || event.key === ']')) { event.preventDefault(); void reorderSelection(current, event.key === ']' ? 1 : -1); return; }
      const arrow = ARROWS[event.key];
      if (!arrow || mod) return;
      event.preventDefault();
      // 押しっぱなしで古い位置から計算し直さないよう、前の操作が終わるまで次の 1 歩は受けない。
      if (current.session.busy) return;
      const step = event.shiftKey ? 10 : 1;
      // 押しっぱなし（リピート）ではロック中の知らせを出し直さない。
      void moveSelection(current, arrow.x * step, arrow.y * step, !event.repeat);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
