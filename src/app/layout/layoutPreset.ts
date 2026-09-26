import type { EditState } from '../edit/editState';
import { selectionIsSubtitle, type DockTab } from '../dockTab';

export type LayoutPreset = 'standard' | 'tall-dock' | 'subtitle' | 'waveform';
export type WorkspaceMode = 'review' | 'edit' | 'finish';
export type TimelineView = 'overview' | 'cut' | 'detail';
export type PanelLayout = 'standard' | 'tall-dock';
export type EditingMode = Exclude<WorkspaceMode, 'review'>;

/** 利用者の表示設定。案件の編集JSONや旧4プリセットを上書きしない。 */
export function loadPanelLayout(mode: EditingMode): PanelLayout {
  try {
    const value = localStorage.getItem(`sme-panel-layout-${mode}`);
    if (value === 'standard' || value === 'tall-dock') return value;
  } catch { /* Storage may be unavailable. */ }
  return workspaceModeLayout(mode) === 'tall-dock' ? 'tall-dock' : 'standard';
}

export function savePanelLayout(mode: EditingMode, value: PanelLayout): void {
  try { localStorage.setItem(`sme-panel-layout-${mode}`, value); } catch { /* Keep the current view usable. */ }
}

const PRESETS: readonly LayoutPreset[] = ['standard', 'tall-dock', 'subtitle', 'waveform'];
const KEY = 'sme-layout';
const WORKSPACE_MODE_KEY = 'sme-workspace-mode';

export interface WorkspaceModeDefaults {
  dock: DockTab;
  timeline: TimelineView;
}

/** 主モードが最初に見せる作業領域。編集状態そのものには触れない。 */
export function workspaceModeDefaults(mode: WorkspaceMode): WorkspaceModeDefaults {
  if (mode === 'review') return { dock: 'transcript', timeline: 'overview' };
  if (mode === 'edit') return { dock: 'settings', timeline: 'cut' };
  return { dock: 'settings', timeline: 'detail' };
}

/** 編集は全幅タイムライン、仕上げは長い設定欄を優先する。 */
export function workspaceModeLayout(mode: WorkspaceMode): LayoutPreset {
  return mode === 'finish' ? 'tall-dock' : mode === 'edit' ? 'waveform' : 'standard';
}

/** 初回は確認。保存値が壊れていても確認へ安全に戻す。 */
export function loadWorkspaceMode(): WorkspaceMode {
  try {
    const stored = localStorage.getItem(WORKSPACE_MODE_KEY);
    return stored === 'edit' || stored === 'finish' ? stored : 'review';
  } catch {
    return 'review';
  }
}

export function saveWorkspaceMode(mode: WorkspaceMode): void {
  try {
    localStorage.setItem(WORKSPACE_MODE_KEY, mode);
  } catch {
    /* 失敗は無視 */
  }
}

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
