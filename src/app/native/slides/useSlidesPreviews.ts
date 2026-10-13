import { useCallback, useEffect, useRef, useState } from 'react';
import { slidesPreviewUrl, slidesRequest } from './slidesApi';
import type { SlidesSessionHook } from './useSlidesSession';

export interface SlidesPreviewImages {
  url(pageId: string): string | null;
  /** 撮れなかったページの理由（撮れた・まだ頼んでいないときは null）。 */
  failure(pageId: string): string | null;
  /** 失敗したページを撮り直してもらう（失敗の記憶を飛ばして頼む）。 */
  retry(): void;
}
interface PreviewReply { pageId: string; contentHash: string; ready: boolean; failed?: boolean; error?: string }
/** 自動で頼み直す間隔と回数（混雑・一時的な失敗からの回復用。尽きたら「撮り直す」の手動ボタンに任せる）。 */
const AUTO_RETRY_MS = 5000, AUTO_RETRY_MAX = 6;
/** 操作が止まってから（800ms）、指紋の変わったページの縮小画像をまとめて頼む。撮り終わると通知（previewTick）が来るので、もう一度聞いて受け取る。
 *  新しい画像ができるまでは、直前の画像を出しておく。失敗・混雑は記録して表示し、間をあけて頼み直す（retry 付き）。 */
export function useSlidesPreviews(projectId: string, session: SlidesSessionHook): SlidesPreviewImages {
  const [ready, setReady] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, { hash: string; error: string }>>({});
  const [retryTick, setRetryTick] = useState(0), retryNext = useRef(false), autoRetries = useRef(0);
  const hashes = session.state?.pageHashes, sessionId = session.state?.sessionId, key = hashes ? JSON.stringify(hashes) : '';
  useEffect(() => { autoRetries.current = 0; }, [key, projectId]);
  useEffect(() => {
    if (!hashes || !sessionId) return;
    let alive = true, retryTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      const missing = Object.entries(hashes).filter(([pageId, hash]) => ready[pageId] !== hash).map(([pageId]) => pageId);
      if (!missing.length) return;
      const retry = retryNext.current; retryNext.current = false;
      void slidesRequest<{ pages: PreviewReply[] }>(projectId, '/preview', { sessionId, pageIds: missing, ...(retry ? { retry: true } : {}) }).then(result => {
        if (!alive) return;
        const current = result.pages.filter(item => hashes[item.pageId] === item.contentHash);
        const done = current.filter(item => item.ready), bad = current.filter(item => !item.ready && item.failed);
        if (done.length) setReady(previous => ({ ...previous, ...Object.fromEntries(done.map(item => [item.pageId, item.contentHash])) }));
        setFailed(previous => {
          const next = { ...previous };
          for (const item of done) delete next[item.pageId];
          for (const item of bad) next[item.pageId] = { hash: item.contentHash, error: item.error ?? '縮小画像を作れませんでした' };
          return next;
        });
        // 失敗・混雑は通知が来ないので、間をあけて自分で頼み直す。
        if (bad.length && autoRetries.current < AUTO_RETRY_MAX) {
          autoRetries.current++;
          retryTimer = setTimeout(() => { retryNext.current = true; setRetryTick(value => value + 1); }, AUTO_RETRY_MS);
        }
      }).catch(() => undefined);
    }, 800);
    return () => { alive = false; clearTimeout(timer); if (retryTimer) clearTimeout(retryTimer); };
  }, [projectId, sessionId, key, session.previewTick, session.exportTick, retryTick]);
  const retry = useCallback(() => { retryNext.current = true; autoRetries.current = 0; setRetryTick(value => value + 1); }, []);
  return {
    url: pageId => { const hash = ready[pageId]; return hash ? slidesPreviewUrl(projectId, pageId, hash) : null; },
    failure: pageId => { const item = failed[pageId]; return item && hashes?.[pageId] === item.hash && ready[pageId] !== item.hash ? item.error : null; },
    retry,
  };
}
