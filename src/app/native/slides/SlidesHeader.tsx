import { Icon } from '../../Icon';
import { useTheme } from '../../layout/useTheme';

export interface SlidesHeaderProps {
  name: string; dirty: boolean; busy: boolean; canUndo: boolean; canRedo: boolean;
  onHome(): void; onUndo(): void; onRedo(): void; onSave(): void;
  /** 渡したときだけボタンを出す（AI の作業・PDF・書き出し）。 */
  onAi?: () => void; aiOpen?: boolean; onPdf?: () => void; onExport?: () => void;
}
/** スライドのヘッダー。モードの代わりに「スライド」の題を出し、右に AI の作業・PDF・書き出し。 */
export function SlidesHeader(props: SlidesHeaderProps) {
  const theme = useTheme();
  return <header className="native-slides-header">
    <button type="button" className="btn-ghost native-header-icon" aria-label="ホームへ戻る" title="ホームへ戻る" onClick={props.onHome}><Icon name="home" /></button>
    <div className="native-slides-title"><strong>スライド</strong><span title={props.name}>{props.name}</span>
      {props.dirty && <span className="native-slides-dirty">未保存</span>}</div>
    <div className="native-slides-header-actions">
      <button type="button" className="btn-ghost native-header-icon" aria-label="元に戻す" title="元に戻す（⌘Z）" disabled={!props.canUndo || props.busy} onClick={props.onUndo}><Icon name="undo" /></button>
      <button type="button" className="btn-ghost native-header-icon" aria-label="やり直し" title="やり直し（⌘⇧Z）" disabled={!props.canRedo || props.busy} onClick={props.onRedo}><Icon name="redo" /></button>
      <button type="button" className="btn-ghost native-header-icon" aria-label="保存" title="保存" disabled={!props.dirty || props.busy} onClick={props.onSave}><Icon name="save" /></button>
      {props.onAi && <button type="button" className="native-toggle" aria-pressed={!!props.aiOpen} onClick={props.onAi}>AI の作業</button>}
      {props.onPdf && <button type="button" className="btn btn-secondary" onClick={props.onPdf}>PDF</button>}
      {props.onExport && <button type="button" className="btn btn-primary" onClick={props.onExport}>書き出し</button>}
      <button type="button" className="btn-ghost native-header-icon" aria-label="テーマ切替" title="テーマ切替" onClick={theme.toggle}><Icon name={theme.theme === 'dark' ? 'sun' : 'moon'} /></button>
    </div>
  </header>;
}
