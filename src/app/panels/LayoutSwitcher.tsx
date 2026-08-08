import type { LayoutPreset } from '../layout/layoutPreset';

interface LayoutSwitcherProps {
  value: LayoutPreset;
  onChange: (v: LayoutPreset) => void;
}

const PRESETS: Array<{ key: LayoutPreset; label: string; title: string }> = [
  { key: 'standard', label: '標準', title: 'プレビュー主役・タイムライン全幅' },
  { key: 'tall-dock', label: '全高', title: '右パネルを全高に・タイムラインはプレビュー幅' },
  { key: 'subtitle', label: '字幕', title: '字幕編集向け・下部に2段組設定' },
  { key: 'waveform', label: '波形', title: 'カット編集向け・プレビューとタイムラインの2段組でタイムラインを大きく' },
];

/** ツールバーのレイアウト切替（3 プリセットのセグメント）。 */
export function LayoutSwitcher({ value, onChange }: LayoutSwitcherProps) {
  return (
    <div className="layout-switcher" role="group" aria-label="レイアウト切替">
      {PRESETS.map((p) => (
        <button
          key={p.key}
          type="button"
          className={'layout-seg' + (value === p.key ? ' active' : '')}
          data-preset={p.key}
          title={p.title}
          aria-pressed={value === p.key}
          onClick={() => onChange(p.key)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
