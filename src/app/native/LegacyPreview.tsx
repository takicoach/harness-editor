import { forwardRef, useState } from 'react';
import { NativePreview, type NativePreviewHandle, type NativePreviewProps } from './NativePreview';
import type { LegacyPreviewState } from './useLegacyPreview';

export interface LegacyPreviewProps extends Omit<NativePreviewProps, 'projectId' | 'document' | 'legacyContext'> {
  preview: LegacyPreviewState;
}

/** The legacy host supplies the live hook result and owns onFrame/initialFrame.
 * Only a ready lease can mount NativePreview. Recovery requires a user action. */
export const LegacyPreview = forwardRef<NativePreviewHandle, LegacyPreviewProps>(function LegacyPreview({ preview, onError, ...props }, ref) {
  const [expired, setExpired] = useState<string | null>(null);
  if (preview.status !== 'ready') return <section className="native-preview native-preview-message" aria-label="プレビューモニター">
    {preview.status === 'failed' ? <div className="native-preview-problem">
      <div role="alert">
        <strong>プレビューを準備できませんでした</strong>
        <p>編集内容は失われていません。素材や字幕の部品を確認してから、再読み込みしてください。</p>
      </div>
      <button onClick={preview.retry}>素材を再読み込み</button>
      <details><summary>エラーの詳細</summary><pre>{preview.error}</pre></details>
    </div> : <p role="status">プレビュー素材を準備中…</p>}
  </section>;
  return <>
    <NativePreview {...props} ref={ref} projectId={preview.projectId} document={preview.document} legacyContext={preview.legacyContext}
      onError={failure => { if (failure.kind === 'context-unavailable') setExpired(preview.legacyContext); onError?.(failure); }} />
    {expired === preview.legacyContext && <div role="status">プレビュー素材の接続が失われました。<button onClick={preview.retry}>素材を再読み込み</button></div>}
  </>;
});
