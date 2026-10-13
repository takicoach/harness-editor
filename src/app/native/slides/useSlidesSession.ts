import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlideCommand, SlideHistoryCommand } from '../../../core/slides/commands';
import { useEventChannel } from '../../eventBus';
import { SlidesApiError, slidesRequest, uploadSlidesImage, type SlidesFileStatus, type SlidesSessionState } from './slidesApi';

interface SaveBody { sessionId: string; expectedRevision: number; expectedSavedRevision: number; executionId: string }
export type SlidesPhase = 'loading' | 'broken' | 'ready' | 'error';
export interface SlidesBrokenInfo { preservedFiles: string[]; backupAvailable: boolean }

/** スライドの読み込み・コマンド・保存（結果が分からない保存は同じ ID で照合）・画像の取り込み・通知の一式。動画・サムネのセッションとは別。 */
export function useSlidesSession(projectId: string) {
  const [state, setState] = useState<SlidesSessionState | null>(null), latest = useRef<SlidesSessionState | null>(null);
  const [phase, setPhase] = useState<SlidesPhase>('loading'), [broken, setBroken] = useState<SlidesBrokenInfo | null>(null);
  const [busy, setBusy] = useState(false), busyRef = useRef(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [previewTick, setPreviewTick] = useState(0), [exportTick, setExportTick] = useState(0);
  const missedChange = useRef(false), queue = useRef<Promise<unknown>>(Promise.resolve()), epoch = useRef(0), pending = useRef(0);
  const pendingSave = useRef<SaveBody | null>(null), saveInFlight = useRef<Promise<boolean> | null>(null);
  const accept = useCallback((next: SlidesSessionState) => {
    const current = latest.current;
    if (current && current.sessionId === next.sessionId && (current.document.revision > next.document.revision || current.savedRevision > next.savedRevision)) return;
    latest.current = next; setState(next); setPhase('ready'); setBroken(null);
  }, []);
  const showBroken = useCallback(async (generation: number) => {
    const status = await slidesRequest<SlidesFileStatus>(projectId, '');
    if (generation !== epoch.current || status.status === 'saved') return;
    setBroken({ preservedFiles: status.preservedFiles, backupAvailable: status.backupAvailable }); setPhase('broken');
  }, [projectId]);
  const load = useCallback(async (generation: number) => {
    setPhase('loading');
    try {
      const status = await slidesRequest<SlidesFileStatus>(projectId, '');
      if (generation !== epoch.current) return;
      if (status.status !== 'saved') { setBroken({ preservedFiles: status.preservedFiles, backupAvailable: status.backupAvailable }); setPhase('broken'); return; }
      const next = await slidesRequest<SlidesSessionState>(projectId, '/session', {});
      if (generation === epoch.current) accept(next);
    } catch (cause) {
      if (generation !== epoch.current) return;
      if (cause instanceof SlidesApiError && cause.code === 'SLIDES_BROKEN') { await showBroken(generation); return; }
      setError(cause instanceof Error ? cause.message : String(cause)); setPhase('error');
    }
  }, [projectId, accept, showBroken]);
  useEffect(() => {
    const generation = ++epoch.current;
    pending.current = 0; queue.current = Promise.resolve(); pendingSave.current = null; saveInFlight.current = null;
    latest.current = null; setState(null); setBroken(null); setBusy(false); busyRef.current = false; setError(null); setNotice(null);
    void load(generation);
  }, [projectId, load]);
  const refresh = useRef<() => void>(() => {});
  const run = useCallback((work: () => Promise<SlidesSessionState | null>): Promise<boolean> => {
    const generation = epoch.current;
    pending.current++; busyRef.current = true; setBusy(true); setError(null);
    const task = queue.current.then(async () => {
      if (generation !== epoch.current) return false;
      try { const next = await work(); if (generation === epoch.current && next) accept(next); return true; }
      catch (cause) {
        if (generation !== epoch.current) return false;
        if (cause instanceof SlidesApiError && cause.evacuatedFile) {
          setNotice(`保存済みのスライドが別の場所で変わっていたため、未保存の内容を .harness/${cause.evacuatedFile} に退避して読み直しました`);
          latest.current = null; pendingSave.current = null; void load(generation);
        } else if (cause instanceof SlidesApiError && cause.code === 'SLIDES_BROKEN') {
          latest.current = null; setState(null); void showBroken(generation);
        } else {
          setError(cause instanceof Error ? cause.message : String(cause));
          // 版が古いままだと次の編集も 409 になる。最新の状態を取り直して追い付く。
          if (cause instanceof SlidesApiError && cause.status === 409 && cause.code === 'REVISION_CONFLICT') missedChange.current = true;
        }
        return false;
      }
    });
    queue.current = task;
    void task.finally(() => {
      if (generation !== epoch.current) return;
      pending.current--;
      if (!pending.current) { busyRef.current = false; setBusy(false); if (missedChange.current) { missedChange.current = false; refresh.current(); } }
    });
    return task;
  }, [accept, load, showBroken]);
  /** 文書は送る直前の最新の版を使う。応答が届かなかった時だけ同じ実行 ID で 1 回再送する。 */
  const execute = useCallback((command: SlideCommand | SlideHistoryCommand) => run(async () => {
    const current = latest.current;
    if (!current) throw new Error('スライドの編集データがありません');
    const body = { sessionId: current.sessionId, expectedRevision: current.document.revision, executionId: crypto.randomUUID(), command };
    try { return await slidesRequest<SlidesSessionState>(projectId, '/command', body); }
    catch (cause) { if (cause instanceof SlidesApiError) throw cause; return slidesRequest<SlidesSessionState>(projectId, '/command', body); }
  }), [projectId, run]);
  const save = useCallback((): Promise<boolean> => {
    if (saveInFlight.current) return saveInFlight.current;
    const generation = epoch.current;
    const task = run(async () => {
      const send = async (body: SaveBody) => {
        pendingSave.current = body;
        try {
          const result = await slidesRequest<SlidesSessionState>(projectId, '/save', body);
          if (generation === epoch.current) pendingSave.current = null;
          return result;
        } catch (cause) {
          if (generation === epoch.current && cause instanceof SlidesApiError && cause.status >= 400 && cause.status < 500) pendingSave.current = null;
          throw cause;
        }
      };
      let current = latest.current;
      if (!current) return null;
      // 結果が分からなかった保存は、同じ保存 ID で先に照合する（二重保存にしない）。
      if (pendingSave.current) { current = await send(pendingSave.current); if (generation !== epoch.current) return current; accept(current); }
      if (!current.dirty) return current;
      return send({ sessionId: current.sessionId, expectedRevision: current.document.revision, expectedSavedRevision: current.savedRevision, executionId: crypto.randomUUID() });
    });
    saveInFlight.current = task;
    void task.then(() => { if (saveInFlight.current === task) saveInFlight.current = null; });
    return task;
  }, [projectId, run, accept]);
  const recover = useCallback((choice: 'backup' | 'new') => run(() => slidesRequest<SlidesSessionState>(projectId, '/recover', { choice, executionId: crypto.randomUUID() })), [projectId, run]);
  const registerAssets = useCallback((assetIds: string[]) => run(async () => {
    const current = latest.current;
    if (!current) throw new Error('スライドの編集データがありません');
    return slidesRequest<SlidesSessionState>(projectId, '/register', { sessionId: current.sessionId, expectedRevision: current.document.revision, executionId: crypto.randomUUID(), assetIds });
  }), [projectId, run]);
  const uploadImage = useCallback(async (file: File): Promise<string | null> => {
    let assetId: string | null = null;
    const ok = await run(async () => {
      const asset = await uploadSlidesImage(projectId, file), current = latest.current;
      if (!current) throw new Error('スライドの編集データがありません');
      const next = await slidesRequest<SlidesSessionState>(projectId, '/register', { sessionId: current.sessionId, expectedRevision: current.document.revision,
        executionId: crypto.randomUUID(), assetIds: [asset.id] });
      assetId = asset.id;
      return next;
    });
    return ok ? assetId : null;
  }, [projectId, run]);
  // AI の適用・別の画面の書き込みは通知で知る（セッションは同じなので、版が進んだ状態を受け取るだけ）。未保存の編集中に外のファイルが変わったときは読み直さない。
  refresh.current = () => {
    const current = latest.current, generation = epoch.current;
    if (!current) return;
    if (busyRef.current) { missedChange.current = true; return; }
    void slidesRequest<SlidesSessionState>(projectId, '/session/status', { sessionId: current.sessionId }).then(async next => {
      if (generation !== epoch.current || busyRef.current || latest.current !== current) return;
      if (next.externalChange && !next.dirty) next = await slidesRequest<SlidesSessionState>(projectId, '/session/reload', { sessionId: next.sessionId, expectedRevision: next.document.revision });
      if (generation === epoch.current && !busyRef.current) accept(next);
    }).catch(() => { if (generation === epoch.current) void load(generation); });
  };
  useEventChannel('slides', raw => {
    if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
    const type = (raw as { type: unknown }).type;
    if (type === 'preview') setPreviewTick(value => value + 1);
    else if (type === 'export') setExportTick(value => value + 1);
    else if (type === 'change') refresh.current();
  }, projectId);
  // 通知の取りこぼし（接続が切れていた間の変更）に備え、一定間隔と画面に戻った時にも状態を確かめる。
  useEffect(() => {
    const check = () => { if (!document.hidden) refresh.current(); };
    const timer = setInterval(check, 15_000);
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    return () => { clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (latest.current?.dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  return { state, phase, broken, busy, error, notice, previewTick, exportTick, execute, save, recover, uploadImage, registerAssets,
    readCurrent: () => latest.current, clearError: () => setError(null), clearNotice: () => setNotice(null) };
}
export type SlidesSessionHook = ReturnType<typeof useSlidesSession>;
