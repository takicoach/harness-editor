// src/app/native/NativeHeader.tsx
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../Icon';
import { TaskProgress } from '../components/TaskProgress';
import { NativeSegmented } from './NativeSegmented';
import { NativeSwitch } from './NativeSwitch';
import { headerCompact } from './headerLayout';
import {NativeSaveProgress} from './NativeSaveProgress';

export type NativeMode = 'review' | 'edit' | 'finish';
export type NativeSaveState = 'saved' | 'dirty' | 'busy' | 'none';
export interface NativeHeaderProps {
  title: string; saveState: NativeSaveState;
  mode: NativeMode; onMode(mode: NativeMode): void;
  canUndo: boolean; canRedo: boolean; busy: boolean; onUndo(): void; onRedo(): void;
  onHome(): void; onActivity(): void;
  onSettings(): void; settingsOpen: boolean;
  onNotifications?(): void; notificationsOpen?: boolean; unreadNotifications?: number;
  /** 「？」使い方（ヘルプ）。渡したときだけ、通知・エラー履歴の右隣（設定の左）に出す。 */
  onHelp?(): void;
  autoSave: boolean; onAutoSave(value: boolean): void;
  onSave(): void; saveDisabled: boolean; saveProgress?:number|null;
  exportControl: ReactNode;
}
const MODES = [{ value: 'review', label: '確認' }, { value: 'edit', label: '編集' }, { value: 'finish', label: '仕上げ' }] as const;
const SAVE_LABEL: Record<NativeSaveState, string> = { saved: '保存済み', dirty: '未保存の変更', busy: '', none: '' };

/** トップバー（UI 添削 F10 A 案）: 左＝場所、中央＝モード、右＝行動。主ボタン（書き出し）は右端に 1 つだけ。 */
export function NativeHeader({ title, saveState, mode, onMode, canUndo, canRedo, busy, onUndo, onRedo, onHome, onActivity, onSettings, settingsOpen, onNotifications, notificationsOpen, unreadNotifications=0, onHelp, autoSave, onAutoSave, onSave, saveDisabled, saveProgress=null, exportControl }: NativeHeaderProps) {
  const element = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const host = element.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => setCompact(headerCompact(entries[0]?.contentRect.width ?? host.clientWidth)));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  return <header ref={element} className="native-header" data-compact={compact ? 'true' : undefined}>
    <div className="native-header-left">
      <button className="btn-ghost native-header-icon" data-native-script-flush aria-label="ホームに戻る" onClick={onHome}><Icon name="home" /></button>
      <span className="native-brand">Harness <span>Editor</span></span>
      <strong className="native-project-title">{title}</strong>
      <span className={`native-save-state native-save-${saveState}`}>{saveState === 'busy' ? saveProgress===null?<TaskProgress label="処理中…" compact />:null : saveState === 'none' ? null : <><i className="native-save-dot" aria-hidden="true" />{SAVE_LABEL[saveState]}</>}</span>
    </div>
    <nav className="native-header-center" aria-label="ワークスペース" data-tutorial="modes"><NativeSegmented role="group" label="モード" items={MODES} value={mode} onChange={onMode} /></nav>
    <div className="native-header-actions">
      <div className="native-btn-group">
        <button className="btn-ghost native-header-icon" data-native-script-flush title="元に戻す（⌘/Ctrl Z）" aria-label="元に戻す" disabled={!canUndo || busy} onClick={onUndo}><Icon name="undo" /></button>
        <button className="btn-ghost native-header-icon" data-native-script-flush title="やり直す（⇧⌘/Ctrl Z）" aria-label="やり直す" disabled={!canRedo || busy} onClick={onRedo}><Icon name="redo" /></button>
      </div>
      <button className="btn-secondary native-ai-work" data-tutorial="ai-work" aria-label="AIの作業" title="AIの作業" onClick={onActivity}><Icon name="sparkles" /><span className="native-ai-work-label">AIの作業</span></button>
      {onNotifications && <button className="btn-ghost native-header-icon native-notification-button" aria-label="通知・エラー履歴" aria-expanded={notificationsOpen} title={`通知・エラー履歴${unreadNotifications?`（未読 ${unreadNotifications} 件）`:''}`} onClick={onNotifications}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><circle cx="12" cy="17" r=".7" fill="currentColor"/></svg>
        {unreadNotifications>0&&<span className="native-notification-count">{unreadNotifications>99?'99+':unreadNotifications}</span>}
      </button>}
      {onHelp && <button className="btn-ghost native-header-icon" data-tutorial="help" aria-label="使い方（ヘルプ）" title="使い方（ヘルプ）" onClick={onHelp}><Icon name="question" /></button>}
      <button className="btn-ghost native-header-icon" aria-label="設定" aria-expanded={settingsOpen} title="設定" onClick={onSettings}><Icon name="gear" /></button>
      <NativeSwitch className="native-auto-save" label="自動保存" tutorialTarget="save" checked={autoSave} onChange={onAutoSave} />
      {saveProgress!==null?<NativeSaveProgress percent={saveProgress}/>:<button className="btn-tonal native-save-button" data-tutorial="save" data-native-script-flush disabled={saveDisabled} onClick={onSave}><Icon name="save" />保存</button>}
      {exportControl}
    </div>
  </header>;
}
