import { useEffect, useRef } from 'react';
import { Icon } from '../Icon';
import { useFocusTrap } from '../useFocusTrap';
import type { ThemePreference } from '../../core/theme';
import type { EditorPrefs } from '../layout/editorPrefs';
import { NativeSegmented } from './NativeSegmented';
import { NativeSwitch } from './NativeSwitch';
import {isEscape} from './keyboard';

export interface NativeSettingsProps {
  prefs: EditorPrefs; onPrefs(next: EditorPrefs): void; themePreference: ThemePreference; onTheme(pref: ThemePreference): void; onOpenShortcuts(): void; onOpenHelp(): void; onClose(): void;
  /** null＝review モード（レイアウト切替を無効表示）。 */
  panelLayout: 'tall-dock' | 'standard' | null; onPanelLayout(next: 'tall-dock' | 'standard'): void;
}

/** 設定（UI 添削 F18 A 案）: 歯車から開く。値はこの Mac の localStorage に保存される（テーマと同じ方式）。焦点管理は NativeShortcutsDialog と同じ。 */
export function NativeSettings({ prefs, onPrefs, themePreference, onTheme, onOpenShortcuts, onOpenHelp, onClose, panelLayout, onPanelLayout }: NativeSettingsProps) {
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
  const set = (patch: Partial<EditorPrefs>) => onPrefs({ ...prefs, ...patch });
  return <div className="native-dialog-backdrop native-settings-backdrop" onClick={onClose}>
    <div ref={root} className="native-dialog native-settings" role="dialog" aria-modal="true" aria-label="設定" onClick={event => event.stopPropagation()}>
      <div className="native-dialog-head"><strong>設定</strong><span className="native-settings-note">この Mac に保存されます</span><button ref={closeButton} className="btn-ghost native-header-icon" aria-label="閉じる" onClick={onClose}><Icon name="x" /></button></div>
      <section><h3>表示</h3>
        <div className="native-setting-row"><span>テーマ</span><NativeSegmented label="テーマ" items={[{ value: 'system', label: 'システム' }, { value: 'light', label: 'ライト' }, { value: 'dark', label: 'ダーク' }] as const} value={themePreference} onChange={onTheme} /></div>
        <div className="native-setting-row"><span>密度</span><NativeSegmented label="密度" items={[{ value: 'compact', label: 'コンパクト' }, { value: 'standard', label: '標準' }] as const} value={prefs.density} onChange={density => set({ density })} /></div>
        <div className="native-setting-row"><NativeSwitch label="アニメーションを減らす" checked={prefs.reduceMotion} onChange={reduceMotion => set({ reduceMotion })} /></div>
        <div className="native-setting-row"><span>右パネル</span><NativeSegmented role="group" label="右パネル" disabled={panelLayout===null}
          items={[{ value: 'standard', label: 'ふつう' }, { value: 'tall-dock', label: '縦長' }] as const}
          value={panelLayout ?? 'standard'} onChange={value => onPanelLayout(value)} /></div>
        <div className="native-setting-row"><span>タイムライン</span><NativeSegmented role="group" label="タイムライン" disabled={panelLayout===null}
          items={[{ value: 'tall-dock', label: 'ふつう' }, { value: 'standard', label: '全幅' }] as const}
          value={panelLayout ?? 'standard'} onChange={value => onPanelLayout(value)} /></div>
        <div className="native-setting-row"><NativeSwitch label="セーフエリアを表示" checked={prefs.safeArea} onChange={safeArea => set({ safeArea })} /></div>
      </section>
      <section><h3>再生</h3>
        <div className="native-setting-row"><span>J / L 連打の最高速度</span><NativeSegmented label="J / L 連打の最高速度" items={[{ value: '4', label: '4×' }, { value: '8', label: '8×' }] as const} value={String(prefs.shuttleMax) as '4' | '8'} onChange={value => set({ shuttleMax: value === '4' ? 4 : 8 })} /></div>
        <div className="native-setting-row"><NativeSwitch label="スナップを最初から ON" checked={prefs.snapDefault} onChange={snapDefault => set({ snapDefault })} /></div>
      </section>
      <section><h3>操作音</h3>
        <div className="native-setting-row"><NativeSwitch label="操作音" checked={prefs.sound.enabled} onChange={enabled => set({ sound: { ...prefs.sound, enabled } })} /></div>
        <div className="native-setting-row"><span>音の種類</span><NativeSegmented label="音の種類" disabled={!prefs.sound.enabled} items={[{ value: 'soft', label: '控えめ' }, { value: 'standard', label: '標準' }] as const} value={prefs.sound.kind} onChange={kind => set({ sound: { ...prefs.sound, kind } })} /></div>
      </section>
      <section><h3>ショートカット</h3>
        <div className="native-setting-row"><span>一覧を見る</span><button className="btn-secondary" aria-keyshortcuts="?" onClick={() => { onClose(); onOpenShortcuts(); }}><kbd className="native-key" aria-hidden="true">?</kbd>すべてのキー</button></div>
      </section>
      <section><h3>ヘルプ</h3>
        <div className="native-setting-row"><span>編集の手順を調べる</span>
          <button className="btn-secondary" onClick={() => { onClose(); onOpenHelp(); }}>使い方を見る</button></div>
      </section>
    </div>
  </div>;
}
