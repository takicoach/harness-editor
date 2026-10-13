import { useEffect, useState } from 'react';
import { thumbnailPreviewUrl, thumbnailRequest } from './thumbnailApi';
import type { ThumbnailSessionHook } from './useThumbnailSession';

export interface ThumbnailPreviewImages { url(pageId: string): string | null }
/** 操作が止まってから（800ms）依頼する。サーバーが撮り終えると通知（previewTick）が来るので、もう一度聞いて受け取る。
 *  受け取るのは今の指紋の画像だけ。新しい画像ができるまでは、直前にできた画像を出しておく。 */
export function useThumbnailPreviews(projectId: string, session: ThumbnailSessionHook): ThumbnailPreviewImages {
  const [ready, setReady] = useState<Record<string, string>>({});
  const hashes = session.state?.pageHashes, sessionId = session.state?.sessionId, key = hashes ? JSON.stringify(hashes) : '';
  useEffect(() => {
    if (!hashes || !sessionId) return;
    let alive = true;
    const timer = setTimeout(() => {
      for (const [pageId, hash] of Object.entries(hashes)) {
        if (ready[pageId] === hash) continue;
        void thumbnailRequest<{ ready: boolean; contentHash: string }>(projectId, '/preview', { sessionId, pageId }).then(result => {
          if (alive && result.ready && result.contentHash === hash) setReady(current => current[pageId] === hash ? current : { ...current, [pageId]: hash });
        }).catch(() => undefined);
      }
    }, 800);
    return () => { alive = false; clearTimeout(timer); };
  }, [projectId, sessionId, key, session.previewTick]);
  return { url: pageId => { const hash = ready[pageId]; return hash ? thumbnailPreviewUrl(projectId, pageId, hash) : null; } };
}
