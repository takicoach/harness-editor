import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThumbnailCommand, ThumbnailHistoryCommand } from '../../../core/thumbnail/commands';
import type { ThumbnailDocument } from '../../../core/thumbnail/model';

/** 送るコマンド。文書から作る形なら、送る直前の最新の文書で作る（前の操作の結果を見てから決めたい値のため）。 */
export type ThumbnailCommandInput = ThumbnailCommand | ThumbnailHistoryCommand | ((document: ThumbnailDocument) => ThumbnailCommand | ThumbnailHistoryCommand);
import { useEventChannel } from '../../eventBus';
import { ThumbnailApiError, thumbnailRequest, uploadThumbnailImage, type ThumbnailFileStatus, type ThumbnailSessionState } from './thumbnailApi';

interface SaveBody { sessionId: string; expectedRevision: number; expectedSavedRevision: number; executionId: string }
export type ThumbnailPhase = 'idle' | 'loading' | 'broken' | 'ready' | 'error';
export interface ThumbnailBrokenInfo { preservedFiles: string[]; backupAvailable: boolean }

/** サムネの読み込み・保存・取り込み・通知・再送の一式。動画の useNativeSession とは別のセッション。
 *  読む・無ければ作る（/create）のは、利用者がサムネに切り替えた（open）うえで動画の文書が読み込み済み（videoReady）の時だけ。
 *  移行待ち・読み込み失敗の案件でサムネのファイルを作らない。 */
export function useThumbnailSession(projectId: string, open: boolean, videoReady: boolean) {
  const active = open && videoReady;
  const [state, setState] = useState<ThumbnailSessionState | null>(null), latest = useRef<ThumbnailSessionState | null>(null);
  const [phase, setPhase] = useState<ThumbnailPhase>('idle'), [broken, setBroken] = useState<ThumbnailBrokenInfo | null>(null);
  const [busy, setBusy] = useState(false), busyRef = useRef(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [saveProgress, setSaveProgress] = useState<number | null>(null), [previewTick, setPreviewTick] = useState(0), [exportTick, setExportTick] = useState(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve()), epoch = useRef(0), pending = useRef(0), started = useRef(false);
  const pendingSave = useRef<SaveBody | null>(null), saveInFlight = useRef<Promise<boolean> | null>(null), refreshing = useRef(false), refreshAgain = useRef(false);
  const accept = useCallback((next: ThumbnailSessionState) => {
    const current = latest.current;
    if (current && current.sessionId === next.sessionId && (current.document.revision > next.document.revision || current.savedRevision > next.savedRevision)) return;
    if (current && current.sessionId === next.sessionId && current.document.revision === next.document.revision && current.savedRevision === next.savedRevision
      && current.savedContentHash === next.savedContentHash && current.canUndo === next.canUndo && current.canRedo === next.canRedo
      && JSON.stringify(current.externalChange) === JSON.stringify(next.externalChange)) return;
    latest.current = next; setState(next); setPhase('ready'); setBroken(null);
  }, []);
  useEffect(() => {
    epoch.current++; started.current = false; pending.current = 0; queue.current = Promise.resolve(); pendingSave.current = null; saveInFlight.current = null;
    latest.current = null; setState(null); setPhase('idle'); setBroken(null); setBusy(false); busyRef.current = false; setError(null); setNotice(null); setSaveProgress(null);
    refreshing.current = false; refreshAgain.current = false;
  }, [projectId]);
  const showBroken = useCallback(async (generation: number) => {
    const status = await thumbnailRequest<ThumbnailFileStatus>(projectId, '');
    if (generation !== epoch.current || status.status === 'saved') return;
    setBroken({ preservedFiles: status.preservedFiles, backupAvailable: status.backupAvailable }); setPhase('broken');
  }, [projectId]);
  const load = useCallback(async (generation: number) => {
    setPhase('loading');
    try {
      const status = await thumbnailRequest<ThumbnailFileStatus>(projectId, '');
      if (generation !== epoch.current) return;
      if (status.status === 'broken') { setBroken({ preservedFiles: status.preservedFiles, backupAvailable: status.backupAvailable }); setPhase('broken'); return; }
      const next = status.status === 'missing'
        ? await thumbnailRequest<ThumbnailSessionState>(projectId, '/create', { executionId: crypto.randomUUID() })
        : await thumbnailRequest<ThumbnailSessionState>(projectId, '/session', {});
      if (generation === epoch.current) accept(next);
    } catch (cause) {
      if (generation !== epoch.current) return;
      if (cause instanceof ThumbnailApiError && cause.code === 'THUMBNAIL_BROKEN') { await showBroken(generation); return; }
      setError(cause instanceof Error ? cause.message : String(cause)); setPhase('error');
    }
  }, [projectId, accept, showBroken]);
  useEffect(() => { if (!active || started.current) return; started.current = true; void load(epoch.current); }, [active, load]);
  const run = useCallback((work: () => Promise<ThumbnailSessionState | null>): Promise<boolean> => {
    const generation = epoch.current;
    pending.current++; busyRef.current = true; setBusy(true); setError(null);
    const task = queue.current.then(async () => {
      if (generation !== epoch.current) return false;
      try { const next = await work(); if (generation === epoch.current && next) accept(next); return true; }
      catch (cause) {
        if (generation !== epoch.current) return false;
        if (cause instanceof ThumbnailApiError && cause.evacuatedFile) {
          setNotice(`保存済みのサムネが別の場所で変わっていたため、未保存の内容を .harness/${cause.evacuatedFile} に退避して読み直しました`);
          latest.current = null; pendingSave.current = null; void load(generation);
        } else if (cause instanceof ThumbnailApiError && cause.code === 'THUMBNAIL_BROKEN') {
          latest.current = null; setState(null); void showBroken(generation);
        } else setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
    });
    queue.current = task;
    void task.finally(() => { if (generation !== epoch.current) return; pending.current--; if (!pending.current) { busyRef.current = false; setBusy(false); } });
    return task;
  }, [accept, load, showBroken]);
  /** 文書は送る直前の最新の版を使う（続けて押した操作が 409 にならない）。応答が届かなかった時だけ同じ実行 ID で 1 回再送する。
   * コマンドを文書から作る形で渡すと、その最新の文書で作る（続けて押した「案を追加」が、前の結果を見ずに同じ名前を送って断られていた）。 */
  const execute = useCallback((input: ThumbnailCommandInput) => run(async () => {
    const current = latest.current;
    if (!current) throw new Error('サムネの編集データがありません');
    const command = typeof input === 'function' ? input(current.document) : input;
    const body = { sessionId: current.sessionId, expectedRevision: current.document.revision, executionId: crypto.randomUUID(), command };
    try { return await thumbnailRequest<ThumbnailSessionState>(projectId, '/command', body); }
    catch (cause) { if (cause instanceof ThumbnailApiError) throw cause; return thumbnailRequest<ThumbnailSessionState>(projectId, '/command', body); }
  }), [projectId, run]);
  const save = useCallback((): Promise<boolean> => {
    if (saveInFlight.current) return saveInFlight.current;
    const generation = epoch.current;
    setSaveProgress(10);
    const task = run(async () => {
      const send = async (body: SaveBody) => {
        pendingSave.current = body;
        try {
          const result = await thumbnailRequest<ThumbnailSessionState>(projectId, '/save', body);
          if (generation === epoch.current) pendingSave.current = null;
          return result;
        } catch (cause) {
          if (generation === epoch.current && cause instanceof ThumbnailApiError && cause.status >= 400 && cause.status < 500) pendingSave.current = null;
          throw cause;
        }
      };
      let current = latest.current;
      if (!current) return null;
      // 結果が分からなかった保存は、同じ実行 ID で先に照合する（二重保存にしない）。
      if (pendingSave.current) { current = await send(pendingSave.current); if (generation !== epoch.current) return current; accept(current); }
      if (!current.dirty) return current;
      return send({ sessionId: current.sessionId, expectedRevision: current.document.revision, expectedSavedRevision: current.savedRevision, executionId: crypto.randomUUID() });
    });
    saveInFlight.current = task;
    void task.then(() => { if (saveInFlight.current === task) saveInFlight.current = null; if (generation === epoch.current) setSaveProgress(null); });
    return task;
  }, [projectId, run, accept]);
  const recover = useCallback((choice: 'backup' | 'new') => run(() => thumbnailRequest<ThumbnailSessionState>(projectId, '/recover', { choice, executionId: crypto.randomUUID() })), [projectId, run]);
  const registerAssets = useCallback((assetIds: string[]) => run(async () => {
    const current = latest.current;
    if (!current) throw new Error('サムネの編集データがありません');
    return thumbnailRequest<ThumbnailSessionState>(projectId, '/register', { sessionId: current.sessionId, expectedRevision: current.document.revision, executionId: crypto.randomUUID(), assetIds });
  }), [projectId, run]);
  const uploadImage = useCallback(async (file: File): Promise<string | null> => {
    let assetId: string | null = null;
    const ok = await run(async () => {
      const asset = await uploadThumbnailImage(projectId, file), current = latest.current;
      if (!current) throw new Error('サムネの編集データがありません');
      const next = await thumbnailRequest<ThumbnailSessionState>(projectId, '/register', { sessionId: current.sessionId, expectedRevision: current.document.revision,
        executionId: crypto.randomUUID(), assetIds: [asset.id] });
      assetId = asset.id;
      return next;
    });
    return ok ? assetId : null;
  }, [projectId, run]);
  // 別の画面や AI 以外の書き込みは通知で知る。未保存の編集があるときは読み直さない。
  // 取得の最中にさらに通知が届いたら、その取得を捨てずに 1 回だけ取り直す（通知が続けて届いても、最後の版まで追い付く）。
  const refresh = useRef<() => void>(() => {});
  refresh.current = () => {
    const current = latest.current, generation = epoch.current;
    if (!current || busyRef.current) return;
    if (refreshing.current) { refreshAgain.current = true; return; }
    refreshing.current = true;
    void thumbnailRequest<ThumbnailSessionState>(projectId, '/session/status', { sessionId: current.sessionId }).then(async next => {
      if (generation !== epoch.current || busyRef.current || latest.current !== current) return;
      if (next.externalChange && !next.dirty) next = await thumbnailRequest<ThumbnailSessionState>(projectId, '/session/reload', { sessionId: next.sessionId, expectedRevision: next.document.revision });
      if (generation === epoch.current && !busyRef.current) accept(next);
    }).catch(() => undefined).finally(() => {
      if (generation !== epoch.current) return;
      refreshing.current = false;
      if (refreshAgain.current) { refreshAgain.current = false; refresh.current(); }
    });
  };
  useEventChannel('thumbnail', raw => {
    if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
    const type = (raw as { type: unknown }).type;
    if (type === 'preview') setPreviewTick(value => value + 1);
    else if (type === 'export') setExportTick(value => value + 1);
    else if (type === 'change') refresh.current();
  }, projectId);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (latest.current?.dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  return { state, phase, broken, busy, error, notice, saveProgress, previewTick, exportTick, execute, save, recover, uploadImage, registerAssets,
    readCurrent: () => latest.current, clearError: () => setError(null), clearNotice: () => setNotice(null) };
}
export type ThumbnailSessionHook = ReturnType<typeof useThumbnailSession>;
