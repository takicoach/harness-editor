import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlidesExportFormat } from '../../../server/slides/exports';
import { slidesRequest, type SlidesExportStatus } from './slidesApi';
import type { SlidesSessionHook } from './useSlidesSession';

const running = (status: SlidesExportStatus | null) => !!status && (status.phase === 'checking' || status.phase === 'rendering' || status.phase === 'composing');
/** 書き出しの実行と照会。状態はワークスペースが持つ（欄を閉じても書き出しは続き、開き直すと進み具合が見える）。 */
export function useSlidesExport(projectId: string, session: SlidesSessionHook) {
  const [status, setStatus] = useState<SlidesExportStatus | null>(null), [error, setError] = useState<string | null>(null);
  const execution = useRef<string | null>(null);
  const poll = useCallback(async () => {
    const executionId = execution.current;
    if (!executionId) return;
    try { const next = await slidesRequest<SlidesExportStatus>(projectId, '/export/status', undefined, { executionId }); if (execution.current === executionId) setStatus(next); }
    catch (cause) { if (execution.current === executionId) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [projectId]);
  useEffect(() => { void poll(); }, [session.exportTick, poll]);
  useEffect(() => {
    if (!running(status)) return;
    const timer = setInterval(() => void poll(), 1000);
    return () => clearInterval(timer);
  }, [status, poll]);
  const start = useCallback(async (format: SlidesExportFormat) => {
    const current = session.readCurrent();
    if (!current) return;
    const executionId = crypto.randomUUID();
    execution.current = executionId; setError(null); setStatus(null);
    try { setStatus(await slidesRequest<SlidesExportStatus>(projectId, '/export', { sessionId: current.sessionId, expectedRevision: current.document.revision, executionId, format })); }
    catch (cause) { if (execution.current === executionId) { execution.current = null; setError(cause instanceof Error ? cause.message : String(cause)); } }
  }, [projectId, session.readCurrent]);
  const cancel = useCallback(async () => {
    const executionId = execution.current;
    if (executionId) await slidesRequest(projectId, '/export/cancel', { executionId }).catch(() => undefined);
    await poll();
  }, [projectId, poll]);
  const reset = useCallback(() => { execution.current = null; setStatus(null); setError(null); }, []);
  return { status, error, running: running(status), start, cancel, reset };
}
export type SlidesExporter = ReturnType<typeof useSlidesExport>;
