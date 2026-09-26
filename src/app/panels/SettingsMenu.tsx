import { Icon } from '../Icon';
import { LayoutSwitcher } from './LayoutSwitcher';
import { useDropdown } from '../useDropdown';
import type { LayoutPreset } from '../layout/layoutPreset';
import type { WaveformPref } from '../layout/waveformPref';
import type { DuckingSettings } from '../../core/types';
import {DuckingControls} from './DuckingControls';

interface SettingsMenuProps {
  active: boolean;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  layout: LayoutPreset;
  onLayoutChange: (v: LayoutPreset) => void;
  ducking: DuckingSettings;
  onDuckingChange: (v: DuckingSettings) => void;
  /** 波形の高さ設定（standard/large）。未指定時は 'standard' 扱い。 */
  waveformPref?: WaveformPref;
  /** 波形の高さ設定の変更ハンドラ。未指定時は UI 非表示。 */
  onWaveformPrefChange?: (v: WaveformPref) => void;
  /** 自動保存トグル（既定 ON）。未指定時は UI 非表示。 */
  autoSaveEnabled?: boolean;
  /** 自動保存トグルの変更ハンドラ。未指定時は UI 非表示。 */
  onAutoSaveEnabledChange?: (v: boolean) => void;
  /** チュートリアル図鑑を開く。未指定時はメニュー項目を出さない。 */
  onShowTutorial?: () => void;
}

/** ヘッダーの ⚙ 設定メニュー。レイアウト / ダッキング / 波形の高さ / テーマを集約する。 */
export function SettingsMenu({
  active,
  theme,
  onToggleTheme,
  layout,
  onLayoutChange,
  ducking,
  onDuckingChange,
  waveformPref = 'standard',
  onWaveformPrefChange,
  autoSaveEnabled = true,
  onAutoSaveEnabledChange,
  onShowTutorial,
}: SettingsMenuProps) {
  const dd = useDropdown();
  return (
    <div className="dd tb-settings" ref={dd.rootRef}>
      <button
        type="button"
        ref={dd.triggerRef}
        className="tb-icon-btn tb-settings-btn"
        title="設定（レイアウト・ダッキング・テーマ）"
        aria-label="設定（レイアウト・ダッキング・テーマ）"
        data-testid="toolbar-settings"
        aria-haspopup="menu"
        aria-expanded={dd.open}
        onClick={() => dd.setOpen(!dd.open)}
      >
        <Icon name="gear" size={16} />
      </button>
      {dd.open && (
        <div className="dd-menu tb-settings-menu">
          <div className="dd-section">レイアウト</div>
          <LayoutSwitcher value={layout} onChange={onLayoutChange} />
          <div className="dd-section">ダッキング（喋り中に BGM を下げる）</div>
          <DuckingControls value={ducking} disabled={!active} onChange={patch=>onDuckingChange({...ducking,...patch})}/>
          {onWaveformPrefChange !== undefined && (
            <>
              <div className="dd-section">波形の高さ</div>
              <div className="tb-waveform-pref" role="group" aria-label="波形の高さ">
                {(['standard', 'large'] as WaveformPref[]).map((p) => (
                  <button
                    key={p}
                    className={'tb-waveform-pref-btn' + (waveformPref === p ? ' active' : '')}
                    aria-pressed={waveformPref === p}
                    onClick={() => onWaveformPrefChange(p)}
                  >
                    {p === 'standard' ? '標準' : '大きい'}
                  </button>
                ))}
              </div>
            </>
          )}
          {onAutoSaveEnabledChange !== undefined && (
            <>
              <div className="dd-section">自動保存</div>
              <button
                className={'tb-auto-save-toggle' + (autoSaveEnabled ? ' on' : '')}
                aria-pressed={autoSaveEnabled}
                title={
                  autoSaveEnabled
                    ? '自動保存 ON（編集が落ち着くと自動で保存します）'
                    : '自動保存 OFF（手動で保存してください）'
                }
                onClick={() => onAutoSaveEnabledChange(!autoSaveEnabled)}
              >
                <span>{autoSaveEnabled ? 'ON' : 'OFF'}</span>
              </button>
            </>
          )}
          <div className="dd-section">テーマ</div>
          <button className="dd-item" onClick={onToggleTheme}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
            {theme === 'dark' ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
          </button>
          {onShowTutorial !== undefined && (
            <>
              <div className="dd-section">ヘルプ</div>
              <button
                className="dd-item tb-tutorial-item"
                onClick={() => {
                  dd.setOpen(false);
                  onShowTutorial();
                }}
              >
                チュートリアル図鑑
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
