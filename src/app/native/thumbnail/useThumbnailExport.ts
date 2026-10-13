import { useCallback, useEffect, useRef, useState } from 'react';
import { thumbnailDuplicatePageNames, type ThumbnailDocument } from '../../../core/thumbnail/model';
import { thumbnailRequest, type ThumbnailExportStatus } from './thumbnailApi';
import type { ThumbnailSessionHook } from './useThumbnailSession';

const DONE: ReadonlySet<ThumbnailExportStatus['phase']> = new Set(['complete', 'failed', 'cancelled']);
const BATCH_POLL_MS = 400;
export const thumbnailMegabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/** まとめて書き出した結果。overLimit は 2MB を超えた案（JPEG での書き出し直しを勧める）。 */
export interface ThumbnailExportAllResult { names: string[]; overLimit: Array<{ pageId: string; pageName: string }>; failed: Array<{ pageName: string; error: string }>; message: string }
type ExportTarget = { pageId: string; format: 'png' | 'jpeg' };
/** まとめて書き出した結果を、知らせの文と JPEG を勧める案にまとめる。stopped は途中で止めた理由（知らせの末尾に足す）。 */
export function summarizeExportAll(results: readonly ThumbnailExportStatus[], stopped?: string): ThumbnailExportAllResult {
  const complete = results.filter(item => item.phase === 'complete' && item.fileName);
  const names = complete.map(item => item.fileName!.split('/').pop()!);
  const overLimit = complete.filter(item => item.overLimit).map(item => ({ pageId: item.pageId, pageName: item.pageName }));
  const failed = results.filter(item => item.phase === 'failed').map(item => ({ pageName: item.pageName, error: item.error ?? '書き出せませんでした' }));
  const cancelled = results.some(item => item.phase === 'cancelled');
  if (!names.length && !failed.length && cancelled) return { names, overLimit, failed, message: '書き出しを取り消しました' };
  const parts = [names.length ? `${names.length} 枚を書き出しました: ${names.join('、')}` : 'サムネを書き出せませんでした'];
  if (failed.length) parts.push(`書き出せなかった案: ${failed.map(item => `${item.pageName}（${item.error}）`).join('、')}`);
  if (cancelled) parts.push('残りの書き出しは取り消しました');
  if (stopped) parts.push(stopped);
  return { names, overLimit, failed, message: parts.join('。') };
}

/** サムネの書き出しの状態。サムネ画面の外（ワークスペース）で持つので、書き出し中に動画のモードへ戻っても見張りを続け、終わったら知らせる。 */
export function useThumbnailExport({ projectId, session, flush, onToast }: {
  projectId: string; session: ThumbnailSessionHook; flush(): Promise<boolean>; onToast(message: string): void;
}) {
  const [status, setStatus] = useState<ThumbnailExportStatus | null>(null), [error, setError] = useState<string | null>(null), [offer, setOffer] = useState(false);
  const active = useRef<string | null>(null), reported = useRef<string | null>(null), latestSession = useRef(session);
  // まとめての書き出し: 進み具合・結果。各案の完了は個別に知らせず、最後に 1 回まとめて知らせる。
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null), [batchResult, setBatchResult] = useState<ThumbnailExportAllResult | null>(null);
  const batchIds = useRef(new Set<string>()), batchRunning = useRef(false), stopBatch = useRef(false), generation = useRef(0);
  // 開始の要求（/export）の応答を待っている書き出し。応答前はサーバーがまだ知らないので、取消は応答の直後に送る。
  const starting = useRef<string | null>(null);
  latestSession.current = session;
  const running = (!!status && !DONE.has(status.phase)) || batch !== null;
  useEffect(() => {
    generation.current += 1; active.current = null; reported.current = null; stopBatch.current = true;
    setStatus(null); setError(null); setOffer(false); setBatch(null); setBatchResult(null);
    // 案件が変わる・画面を閉じる（NativeApp は案件ごとに key で作り直す）: まとめての書き出しの残りを止め、走っている 1 件も取り消す。
    return () => {
      generation.current += 1; stopBatch.current = true;
      const executionId = active.current;
      if (batchRunning.current && executionId && starting.current !== executionId)
        void thumbnailRequest(projectId, '/export/cancel', { executionId }).catch(() => undefined);
    };
  }, [projectId]);
  const poll = useCallback(async (executionId: string) => {
    const next = await thumbnailRequest<ThumbnailExportStatus>(projectId, '/export/status', undefined, { executionId });
    if (active.current === executionId) setStatus(next);
  }, [projectId]);
  // 完了の通知（export）で確かめ、通知が届かない時のために 1 秒ごとにも確かめる。
  useEffect(() => { if (active.current) void poll(active.current).catch(() => undefined); }, [session.exportTick, poll]);
  useEffect(() => {
    if (!running || !status) return;
    const timer = window.setInterval(() => { void poll(status.executionId).catch(() => undefined); }, 1000);
    return () => window.clearInterval(timer);
  }, [running, status, poll]);
  useEffect(() => {
    if (!status || !DONE.has(status.phase) || reported.current === status.executionId || batchIds.current.has(status.executionId)) return;
    reported.current = status.executionId;
    if (status.phase === 'complete') { onToast(`${status.fileName} に書き出しました（${thumbnailMegabytes(status.bytes ?? 0)}）`); setOffer(!!status.overLimit); }
    else if (status.phase === 'failed') {
      const message = status.error ?? 'サムネを書き出せませんでした';
      // 動画の画面にいる間に失敗しても気づけるよう、完了と同じく知らせも出す。
      setError(message); onToast(`サムネの書き出しに失敗しました: ${message}`);
    }
  }, [status, onToast]);
  const start = useCallback(async (format: 'png' | 'jpeg', pageId: string | null) => {
    if (batchRunning.current) return;
    setError(null); setOffer(false); setBatchResult(null);
    if (!pageId || !await flush()) return;
    const current = latestSession.current.readCurrent();
    if (!current) return;
    try {
      const executionId = crypto.randomUUID();
      active.current = executionId;
      setStatus(await thumbnailRequest<ThumbnailExportStatus>(projectId, '/export', { sessionId: current.sessionId, expectedRevision: current.document.revision, executionId, pageId, format }));
    } catch (cause) { active.current = null; setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [projectId, flush]);
  /** 案を 1 本ずつ順に書き出す（同時 1 本の枠を守る）。targets は確定（flush）の後の文書から決める。 */
  const runAll = useCallback(async (targetsOf: (document: ThumbnailDocument) => ExportTarget[]) => {
    if (batchRunning.current || (status && !DONE.has(status.phase))) return;
    setError(null); setOffer(false); setBatchResult(null);
    if (!await flush()) return;
    const first = latestSession.current.readCurrent(), targets = first ? targetsOf(first.document) : [];
    if (!targets.length) return;
    // 同じファイル名になる案（重複を持つ古い文書）は、書き出すと上書きし合うので始める前に止める。
    const clash = thumbnailDuplicatePageNames(first!.document.pages.filter(page => targets.some(target => target.pageId === page.id)));
    if (clash.length) {
      const message = `${clash.join('・')} は書き出すと同じファイル名になります。名前を変えてから書き出してください`;
      setError(message); onToast(message);
      return;
    }
    const owner = generation.current, results: ThumbnailExportStatus[] = [];
    let stopped: string | undefined;
    batchRunning.current = true; stopBatch.current = false; setBatch({ done: 0, total: targets.length });
    try {
      for (const target of targets) {
        const current = latestSession.current.readCurrent();
        if (!current || stopBatch.current || owner !== generation.current) break;
        // 途中で案が削除された: 並びが変わったので残りは書き出さずに止める（削除された案を送って失敗させない）。
        if (!current.document.pages.some(page => page.id === target.pageId)) { stopped = '途中で案が削除されたので、残りの書き出しは止めました'; break; }
        const executionId = crypto.randomUUID();
        active.current = executionId; batchIds.current.add(executionId); starting.current = executionId;
        let next: ThumbnailExportStatus;
        try {
          next = await thumbnailRequest<ThumbnailExportStatus>(projectId, '/export',
            { sessionId: current.sessionId, expectedRevision: current.document.revision, executionId, pageId: target.pageId, format: target.format });
        } finally { starting.current = null; }
        // 応答を待つ間に取り消された・画面を閉じた: ここで取消を送る（応答前はサーバーがこの書き出しを知らない）。
        if (owner !== generation.current || stopBatch.current) {
          await thumbnailRequest(projectId, '/export/cancel', { executionId }).catch(() => undefined);
          if (owner !== generation.current) return;
        }
        setStatus(next);
        while (!DONE.has(next.phase)) {
          await new Promise(resolve => window.setTimeout(resolve, BATCH_POLL_MS));
          if (owner !== generation.current) return;
          next = await thumbnailRequest<ThumbnailExportStatus>(projectId, '/export/status', undefined, { executionId });
          if (active.current === executionId) setStatus(next);
        }
        results.push(next);
        setBatch({ done: results.length, total: targets.length });
        if (next.phase === 'cancelled') break;
      }
    } catch (cause) {
      if (owner === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      batchRunning.current = false;
      if (owner === generation.current) setBatch(null);
    }
    if (owner !== generation.current || (!results.length && !stopped)) return;
    const summary = summarizeExportAll(results, stopped);
    setBatchResult(summary); onToast(summary.message);
  }, [projectId, flush, onToast, status]);
  const startAll = useCallback(() => runAll(document => document.pages.map(page => ({ pageId: page.id, format: 'png' as const }))), [runAll]);
  /** 2MB を超えた案だけを JPEG で書き出し直す（消えた案は飛ばす）。 */
  const redoOverLimitAsJpeg = useCallback(() => {
    const pages = batchResult?.overLimit.map(item => item.pageId) ?? [];
    return runAll(document => document.pages.filter(page => pages.includes(page.id)).map(page => ({ pageId: page.id, format: 'jpeg' as const })));
  }, [runAll, batchResult]);
  const cancel = useCallback(() => {
    stopBatch.current = true;
    const executionId = active.current;
    // 開始の応答がまだなら、まとめての書き出しが応答の直後に送る。
    if (!executionId || starting.current === executionId) return;
    void thumbnailRequest(projectId, '/export/cancel', { executionId }).then(() => poll(executionId)).catch(() => undefined);
  }, [projectId, poll]);
  return { status, error, offer, running, batch, batchResult, start, startAll, redoOverLimitAsJpeg, cancel,
    dismissOffer: () => setOffer(false), dismissBatchResult: () => setBatchResult(null) };
}
export type ThumbnailExportHook = ReturnType<typeof useThumbnailExport>;
