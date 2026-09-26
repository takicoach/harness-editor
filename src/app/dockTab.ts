import type { EditState } from './edit/editState';
import { isDecorationTelop } from '../core/decorationTelop';

/** 右ドックのタブ。settings は選択駆動、transcript/ai はユーザー選択の休息タブ。 */
export type DockTab = 'transcript' | 'script' | 'settings' | 'ai';

/** 選択中クリップが「設定」を出す対象か（装飾 telop / se / image / videoInsert / bgm / title）。 */
export function selectionWantsSettings(state: EditState): boolean {
  const sel = state.selection;
  if (sel === null) return false;
  if (sel.kind === 'telop') {
    const telop = state.telops.find((t) => t.id === sel.id);
    return telop ? isDecorationTelop(telop) : false;
  }
  return true;
}

/** 選択中が字幕（じまく＝manual でない telop）か。一覧でのテキスト編集対象。 */
export function selectionIsSubtitle(state: EditState): boolean {
  const sel = state.selection;
  if (sel === null || sel.kind !== 'telop') return false;
  const telop = state.telops.find((t) => t.id === sel.id);
  return telop ? !isDecorationTelop(telop) : false;
}

/**
 * 選択が変わったとき、どのタブへ自動で飛ぶか（純関数・副作用なし）。
 * - 設定対象クリップ（装飾 telop / se / image / videoInsert / bgm / title）→ 'settings'
 * - 字幕（じまく）→ 'transcript'（一覧でテキスト編集）
 * - 未選択 → null（タブを変えない＝ユーザーが選んだタブを維持）
 *
 * これにより「クリップ選択→設定が出る」を保ちつつ、その後ユーザーが自由にタブを
 * 切り替えられる（タブクリックは選択を変えないので、設定タブには選択中クリップが
 * 全幅で出続ける）。
 */
export function tabForSelection(state: EditState): DockTab | null {
  if (selectionWantsSettings(state)) return 'settings';
  if (selectionIsSubtitle(state)) return 'transcript';
  return null;
}
