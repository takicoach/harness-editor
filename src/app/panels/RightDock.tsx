import type { ReactNode } from 'react';
import type { DockTab } from '../dockTab';

interface RightDockProps {
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
  /** クリップ設定（Inspector。未選択の空状態も Inspector が自前で表示）。 */
  settings: ReactNode;
  /** Claude 指示欄（embedded）。 */
  ai: ReactNode;
}

const TABS: Array<{ key: DockTab; label: string }> = [
  { key: 'transcript', label: '文字起こし' },
  { key: 'settings', label: '設定' },
  { key: 'ai', label: 'AI' },
];

/**
 * 右の 1 列。文字起こし／設定／AI をタブで出し分ける。
 * activeTab は App 側で選択駆動に決まる（tabForSelection＋userTab）。タブクリックは
 * onPickTab に委ね、選択は維持＝設定タブに選択中クリップが全幅で出続ける。
 */
export function RightDock({
  activeTab,
  onPickTab,
  open,
  onToggleOpen,
  transcript,
  settings,
  ai,
}: RightDockProps) {
  if (!open) {
    return (
      <aside className="rightdock rightdock-collapsed">
        <button className="rightdock-expand" onClick={onToggleOpen} title="パネルを開く" aria-label="パネルを開く">
          {'«'}
        </button>
      </aside>
    );
  }
  return (
    <aside className="rightdock">
      <div className="rightdock-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={'rightdock-tab' + (activeTab === t.key ? ' active' : '')}
            data-tab={t.key}
            onClick={() => onPickTab(t.key)}
          >
            {t.label}
          </button>
        ))}
        <button className="rightdock-collapse" onClick={onToggleOpen} title="パネルを隠す" aria-label="パネルを隠す">
          {'»'}
        </button>
      </div>
      <div className="rightdock-body">
        {activeTab === 'settings' ? settings : activeTab === 'ai' ? ai : transcript}
      </div>
    </aside>
  );
}
