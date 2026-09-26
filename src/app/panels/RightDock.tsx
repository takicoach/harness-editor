import type { ReactNode } from 'react';
import type { DockTab } from '../dockTab';
import type { WorkspaceMode } from '../layout/layoutPreset';
import { RightDockResizer } from '../layout/RightDockResizer';

interface RightDockProps {
  /** 画面の主作業。DOMを作り直さず、読み上げ名と視覚的な文脈を揃える。 */
  workspaceMode?: WorkspaceMode;
  /** アクティブタブ（userTab。選択変化で App 側 effect が寄せる）。 */
  activeTab: DockTab;
  /** タブクリック（App 側で userTab を更新。選択は維持）。 */
  onPickTab: (tab: DockTab) => void;
  /** ドックが開いているか（折りたたみ）。 */
  open: boolean;
  /** 折りたたみトグル。 */
  onToggleOpen: () => void;
  /** 文字起こし／じまく一覧（TranscriptPanel）。 */
  transcript: ReactNode;
  script?: ReactNode;
  /** クリップ設定（Inspector。未選択の空状態も Inspector が自前で表示）。 */
  settings: ReactNode;
  /** Claude 指示欄（embedded）。 */
  ai: ReactNode;
}

const TABS: Array<{ key: DockTab; label: string }> = [
  { key: 'transcript', label: '文字起こし' },
  { key: 'script', label: '台本' },
  { key: 'settings', label: '設定' },
  { key: 'ai', label: 'AI' },
];

/**
 * 右の 1 列。文字起こし／設定／AI をタブで出し分ける。
 * activeTab は App 側で選択駆動に決まる（tabForSelection＋userTab）。タブクリックは
 * onPickTab に委ね、選択は維持＝設定タブに選択中クリップが全幅で出続ける。
 */
export function RightDock({
  workspaceMode = 'review',
  activeTab,
  onPickTab,
  open,
  onToggleOpen,
  transcript,
  script,
  settings,
  ai,
}: RightDockProps) {
  const modeLabel = workspaceMode === 'review' ? '確認' : workspaceMode === 'edit' ? '編集' : '仕上げ';
  const tabs = TABS.filter((tab) => (workspaceMode !== 'review' || tab.key !== 'settings') && (script || tab.key !== 'script'));
  const visibleTab = workspaceMode === 'review' && activeTab === 'settings' ? 'transcript' : activeTab;
  if (!open) {
    return (
      <aside className="rightdock rightdock-collapsed" data-workspace-mode={workspaceMode}>
        <button className="rightdock-expand" onClick={onToggleOpen} title="パネルを開く" aria-label="パネルを開く">
          {'«'}
        </button>
      </aside>
    );
  }
  return (
    <aside
      className="rightdock"
      data-workspace-mode={workspaceMode}
      aria-label={`${modeLabel}モードの作業パネル`}
    >
      <RightDockResizer />
      <div className="rightdock-tabs">
        <span className="rightdock-mode-mark" aria-hidden="true">
          {modeLabel}
        </span>
        {tabs.map((t) => (
          <button
            key={t.key}
            className={'rightdock-tab' + (visibleTab === t.key ? ' active' : '')}
            data-tab={t.key}
            onClick={() => onPickTab(t.key)}
          >
            {t.key === 'settings' ? workspaceMode === 'edit' ? 'クリップ' : '調整' : t.label}
          </button>
        ))}
        <button className="rightdock-collapse" onClick={onToggleOpen} title="パネルを隠す" aria-label="パネルを隠す">
          {'»'}
        </button>
      </div>
      <div className="rightdock-body">
        {script && <div className="rightdock-script" hidden={visibleTab !== 'script'}>{script}</div>}
        {visibleTab === 'script' ? null : visibleTab === 'settings' ? settings : visibleTab === 'ai' ? ai : transcript}
      </div>
    </aside>
  );
}
