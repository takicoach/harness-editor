import type { EditState } from '../edit/editState';
import { selectionIsSubtitle, type DockTab } from '../dockTab';

export type LayoutPreset = 'standard' | 'tall-dock' | 'subtitle' | 'waveform';

const PRESETS: readonly LayoutPreset[] = ['standard', 'tall-dock', 'subtitle', 'waveform'];
const KEY = 'sme-layout';

/**
 * 字幕編集モードかつ字幕（じまく）選択中のとき、文字起こしの隣に設定側パネル（subpanel）を出す。
 * テキストベース編集（文字起こし一覧）と設定を横並びで同時に見られるようにする。
 *
 * ただし右ドックが「設定」タブのときは出さない。subpanel と設定タブは同じ SettingsTab を
 * 描くため、両方出すと**同じフォームが 2 つ**並び、`ins-telop-manual` などの id が文書内で
 * 重複する（`label[for]` は先頭の要素だけを指し、もう一方はラベルから操作できない）。
 * 実測: G-4 ビジュアル検品（subtitle プリセット・設定タブ）で重複 id 7 件。
 */
export function showsSubtitlePanel(state: EditState, layout: LayoutPreset, activeTab: DockTab): boolean {
  return layout === 'subtitle' && activeTab !== 'settings' && selectionIsSubtitle(state);
}

/** localStorage からレイアウトを読む。未設定・不正値は standard。 */
export function loadLayout(): LayoutPreset {
  try {
    const v = localStorage.getItem(KEY);
    return PRESETS.includes(v as LayoutPreset) ? (v as LayoutPreset) : 'standard';
  } catch {
    return 'standard';
  }
}

/** レイアウトを localStorage に保存（失敗は無視）。 */
export function saveLayout(v: LayoutPreset): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* 失敗は無視 */
  }
}
