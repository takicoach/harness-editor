import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, putJsonPost } from '../../fetchJson';
import { useAiPresence } from '../../useAiPresence';
import { isFinalThumbnailAiStatus, type ThumbnailAiButtonInput, type ThumbnailAiLatest } from '../../../shared/thumbnailAi';

/** 動いている依頼を見ている間の照会の間隔。 */
export const THUMBNAIL_AI_POLL_MS = 2000;
/** 動いていない間（依頼が無い・完了／失敗のあと・動きが止まった依頼）の照会の間隔。端末から直接頼まれた依頼を拾うために、欄が出ている間は止めない。 */
export const THUMBNAIL_AI_IDLE_POLL_MS = 5000;
/** 最終の更新からこれだけ経った未確定の依頼は、動いていないとみなして間隔を戻す（AI が確定せずに止めた直接の依頼で 2 秒の照会を続けない）。 */
export const THUMBNAIL_AI_STALE_MS = 10 * 60_000;
/** 欄の下の状態。欄が出ている間は照会を続け（端末から直接の依頼は受け箱が無く、画面からは始まりが分からない）、動いている依頼は 2 秒、それ以外は 5 秒ごとにする。 */
export function useThumbnailAi(projectId: string) {
  const presence = useAiPresence(true), [latest, setLatest] = useState<ThumbnailAiLatest | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), alive = useRef(true), version = useRef(0);
  const refresh = useCallback(async () => {
    // 照会の返事を待つ間にボタンの依頼が返ってきたら、古い返事で上書きしない。
    const mark = version.current;
    try { const next = await fetchJson<ThumbnailAiLatest>(`/api/ai/thumbnail-requests?id=${encodeURIComponent(projectId)}`); if (alive.current && version.current === mark) setLatest(next); } catch { /* 次の照会で取り直す */ }
  }, [projectId]);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [refresh]);
  const updatedAt = latest?.request ? Date.parse(latest.request.updatedAt) : Number.NaN;
  const moving = !!latest?.status && !isFinalThumbnailAiStatus(latest.status) && Date.now() - updatedAt < THUMBNAIL_AI_STALE_MS;
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), moving ? THUMBNAIL_AI_POLL_MS : THUMBNAIL_AI_IDLE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [moving, refresh]);
  const send = useCallback(async (input: Omit<ThumbnailAiButtonInput, 'requestId' | 'requestCreatedAt' | 'projectId'>) => {
    setBusy(true); setError(null);
    try { const next = await putJsonPost<ThumbnailAiLatest>('/api/ai/thumbnail-requests', { ...input, projectId, requestId: crypto.randomUUID(), requestCreatedAt: Date.now() }); version.current += 1; setLatest(next); return true; }
    catch (cause) { setError(`AI の入力欄に貼れませんでした（${cause instanceof Error ? cause.message : String(cause)}）`); return false; }
    finally { setBusy(false); }
  }, [projectId]);
  return { latest, connected: presence?.connected === true, busy, error, send };
}
export type ThumbnailAi = ReturnType<typeof useThumbnailAi>;
