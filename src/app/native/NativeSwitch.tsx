interface Props { checked: boolean; onChange(next: boolean): void; label: string; disabled?: boolean; className?: string; tutorialTarget?: string }

/** 設定系の ON/OFF（UI 添削 F5）。実体は checkbox なのでラベル・キーボード・E2E の扱いは従来どおり。 */
export function NativeSwitch({ checked, onChange, label, disabled = false, className = '', tutorialTarget }: Props) {
  return <label className={`native-switch ${className}`.trim()} data-checked={checked} data-tutorial={tutorialTarget}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => { /* jsdom の fireEvent.click は disabled を素通りするための保険。実ブラウザでは disabled な checkbox は change を発火しない。 */ if (!disabled) onChange(event.target.checked); }} />
    <span className="native-switch-track" aria-hidden="true"><span className="native-switch-knob" /></span>
    <span className="native-switch-label">{label}</span>
  </label>;
}
