import type { WorkspaceMode } from '../layout/layoutPreset';

interface WorkspaceModeSwitcherProps {
  value: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
}

const MODES: Array<{ key: WorkspaceMode; label: string; description: string }> = [
  { key: 'review', label: '確認', description: '文字起こしと全体を確認' },
  { key: 'edit', label: '編集', description: '映像を切る・並べる' },
  { key: 'finish', label: '仕上げ', description: '位置・色・音を調整' },
];

/** 編集状態を共有したまま、画面の情報優先度だけを切り替える主操作。 */
export function WorkspaceModeSwitcher({ value, onChange }: WorkspaceModeSwitcherProps) {
  return (
    <div className="workspace-mode-switcher" role="group" aria-label="作業モード">
      {MODES.map((mode) => (
        <button
          key={mode.key}
          type="button"
          className={'workspace-mode-button' + (value === mode.key ? ' active' : '')}
          aria-pressed={value === mode.key}
          title={mode.description}
          data-testid={`workspace-mode-${mode.key}`}
          onClick={() => onChange(mode.key)}
        >
          <span>{mode.label}</span>
          <small>{mode.description}</small>
        </button>
      ))}
    </div>
  );
}
