import { useState } from 'react';
import type { SlidesExportFormat, SlidesExportPhase } from '../../../server/slides/exports';
import { Icon } from '../../Icon';
import { slidesExportFileUrl } from './slidesApi';
import type { SlidesExporter } from './useSlidesExport';

const FORMATS: ReadonlyArray<{ value: SlidesExportFormat; label: string; detail: string }> = [
  { value: 'pdf', label: '表示用 PDF', detail: '1 枚の紙に 1 ページ（話すメモは入れません）' },
  { value: 'pdf-notes', label: 'メモ付き PDF', detail: 'A4 縦にページの画像と話すメモ（手元の台本用）' },
  { value: 'png', label: 'PNG 一式', detail: 'ページごとの画像（1920×1080）' },
];
const PHASE_TEXT: Readonly<Record<SlidesExportPhase, string>> = {
  checking: '素材を確かめています', rendering: 'ページを描いています', composing: 'PDF にまとめています', complete: '書き出しました', failed: '書き出せませんでした', cancelled: '取り消しました',
};
/** 書き出しの欄。PDF は各ページを画像として収めるので、文字は編集・検索できないことをここで説明する。 */
export function SlidesExportDialog({ projectId, exporter, initial, pages, onFlush, onClose, onVideoImport }: {
  projectId: string; exporter: SlidesExporter; initial: SlidesExportFormat; pages: number; onFlush(): Promise<boolean>; onClose(): void; onVideoImport?: () => void;
}) {
  const [format, setFormat] = useState<SlidesExportFormat>(initial), status = exporter.status, running = exporter.running;
  const start = async () => { if (await onFlush()) await exporter.start(format); };
  return <div className="native-slides-dialog" role="dialog" aria-label="書き出し">
    <header className="native-slides-dialog-head"><strong>書き出し</strong>
      <button type="button" className="btn-ghost native-header-icon" aria-label="閉じる" title="閉じる（書き出しは続きます）" onClick={onClose}><Icon name="x" /></button></header>
    <fieldset className="native-slides-formats" disabled={running}><legend>形式</legend>
      {FORMATS.map(item => <label key={item.value} className="native-slides-format">
        <input type="radio" name="slides-export-format" value={item.value} checked={format === item.value} onChange={() => setFormat(item.value)} />
        <span><strong>{item.label}</strong><small>{item.detail}</small></span></label>)}
    </fieldset>
    {format !== 'png' && <p className="native-thumbnail-note">PDF には各ページを画像として収めます。PDF の中で文字を編集・検索することはできません。直すときはこの画面で直して、書き出し直してください。</p>}
    <p className="native-thumbnail-note">保存先はスライドのフォルダーの「書き出し」です。同じ名前のファイルは置き換えます。</p>
    <div className="native-slides-row">
      <button type="button" className="btn-primary" disabled={running || !pages} onClick={() => void start()}>書き出す</button>
      {running && <button type="button" className="btn-ghost" onClick={() => void exporter.cancel()}>取り消す</button>}
      {onVideoImport && <button type="button" className="btn-secondary" disabled={running} onClick={onVideoImport}>動画案件に取り込む…</button>}
    </div>
    {status && <p className="native-slides-export-status" data-phase={status.phase} role="status">{PHASE_TEXT[status.phase]}{status.phase === 'rendering' ? `（${status.done} / ${status.pages}）` : ''}{status.error ? `（${status.error}）` : ''}</p>}
    {status?.phase === 'complete' && status.files && <ul className="native-slides-export-files" aria-label="書き出したファイル">
      {status.files.map((file, index) => <li key={file}><a className="native-slides-link" href={slidesExportFileUrl(projectId, status.executionId, index)} target="_blank" rel="noreferrer">{file}</a></li>)}</ul>}
    {exporter.error && <p className="native-slides-dialog-error" role="alert">{exporter.error}</p>}
  </div>;
}
