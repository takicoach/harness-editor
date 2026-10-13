import { TaskProgress } from '../../components/TaskProgress';
import { thumbnailExportFileUrl } from './thumbnailApi';
import { thumbnailMegabytes, type ThumbnailExportHook } from './useThumbnailExport';
import type { ThumbnailSessionHook } from './useThumbnailSession';

/** サムネのときのヘッダーの書き出し。今開いている案を PNG で書き出し、YouTube の上限（2MB）を超えたら JPEG を勧める。
 *  状態は useThumbnailExport（ワークスペース側）が持つ。この部品はサムネ画面の間だけ出る見た目。 */
export function ThumbnailExportControl({ projectId, session, exporter, pageId }: {
  projectId: string; session: ThumbnailSessionHook; exporter: ThumbnailExportHook; pageId: string | null;
}) {
  const { status, error, offer, running, batch, batchResult } = exporter;
  const progress = batch ? `すべての案を書き出しています…（${Math.min(batch.done + 1, batch.total)}/${batch.total}）`
    : status?.phase === 'checking' ? '書き出しの準備をしています…' : '書き出しています…';
  return <div className="native-thumbnail-export">
    {running ? <>
      <TaskProgress label={progress} compact />
      <button type="button" className="btn-ghost" onClick={exporter.cancel}>取り消す</button>
    </> : <button type="button" className="btn-primary" disabled={!session.state || !pageId || session.phase !== 'ready'} onClick={() => void exporter.start('png', pageId)}>PNG で書き出し</button>}
    {status?.phase === 'complete' && status.fileName && <a className="native-thumbnail-export-link" href={thumbnailExportFileUrl(projectId, status.executionId)}
      download={status.fileName.split('/').pop()}>{status.fileName.split('/').pop()}</a>}
    {offer && status?.bytes !== undefined && <div className="native-notice native-thumbnail-export-offer" role="alert">
      <span>YouTube のサムネは 2MB までです（今は {thumbnailMegabytes(status.bytes)}）。JPEG にすると小さくなります。</span>
      <button type="button" className="btn-secondary" onClick={() => void exporter.start('jpeg', pageId)}>JPEG で書き出す</button>
      <button type="button" className="btn-ghost" onClick={exporter.dismissOffer}>このままにする</button>
    </div>}
    {!running && batchResult && batchResult.overLimit.length > 0 && <div className="native-notice native-thumbnail-export-offer" role="alert">
      <span>{batchResult.overLimit.map(item => item.pageName).join('・')} は 2MB を超えました。YouTube のサムネは 2MB までです。JPEG にすると小さくなります。</span>
      <button type="button" className="btn-secondary" onClick={() => void exporter.redoOverLimitAsJpeg()}>JPEG で書き出し直す</button>
      <button type="button" className="btn-ghost" onClick={exporter.dismissBatchResult}>このままにする</button>
    </div>}
    {error && <span className="native-thumbnail-export-error" role="alert">{error}</span>}
  </div>;
}
