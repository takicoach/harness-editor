import { useCallback, useEffect, useRef, useState } from 'react';
import { NativeApiError, nativeRequest, openNativeSequence, saveNativeSequence, uploadNativeAsset, type NativeCommand, type NativeSession } from './api';
import type {SequenceAsset} from '../../core/sequence/model';
import {useEventChannel} from '../eventBus';

export function useNativeSession(projectId: string, deferExternal = false) {
  const [state, setState] = useState<NativeSession | null>(null), latest = useRef<NativeSession | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve()), epoch = useRef(0);
  const pendingWork = useRef(0), pendingRefresh = useRef(false), refreshNow = useRef(() => {});
  const refreshError = useRef<string | null>(null);
  // Commands in this session (AI/API/another tab) keep arriving during a field draft: the inspector
  // rebases its draft onto the new revision. Only adopting an external save (a new session read
  // from disk) waits for the input to end, so a draft is never replaced by a reloaded session.
  const refreshBlocked = useRef(false); refreshBlocked.current = busy;
  const reloadDeferred = useRef(false); reloadDeferred.current = deferExternal;
  const pendingReload = useRef(false);
  const [reloadKey, setReloadKey] = useState(0);
  const saveInFlight = useRef<Promise<boolean> | null>(null);
  const [saveProgress,setSaveProgress]=useState<number|null>(null),saveCompleteTimer=useRef<ReturnType<typeof setTimeout>>();
  const pendingSave = useRef<{ sessionId:string;expectedRevision:number;expectedSavedRevision:number;executionId:string } | null>(null);
  const pendingLegacyCuts=useRef<{projectId:string;sessionId:string;expectedRevision:number;executionId:string;planId:string;planDigest:string}|null>(null);
  const accept = useCallback((value: NativeSession) => {
    const current = latest.current;
    if (current && current.sessionId === value.sessionId && (current.document.revision > value.document.revision || current.savedRevision > value.savedRevision)) return;
    if (current && current.sessionId === value.sessionId && current.document.revision === value.document.revision
      && current.savedRevision === value.savedRevision && current.savedContentHash === value.savedContentHash
      && current.historyError === value.historyError
      && JSON.stringify(current.externalChange) === JSON.stringify(value.externalChange)
      && current.canUndo === value.canUndo && current.canRedo === value.canRedo) return;
    // A session revision is immutable. Saving only changes acknowledgement metadata;
    // retain the graph identity so previews, cut maps and media caches stay mounted.
    const next=current&&current.sessionId===value.sessionId&&current.document.id===value.document.id&&current.document.revision===value.document.revision
      ?{...value,document:current.document}:value;
    latest.current = next; setState(next);
  }, []);
  useEffect(() => {
    const generation = ++epoch.current, controller = new AbortController();
    pendingRefresh.current = false; pendingReload.current = false; pendingWork.current = 0; refreshError.current = null; queue.current = Promise.resolve();
    clearTimeout(saveCompleteTimer.current);setSaveProgress(null);saveInFlight.current=null;pendingSave.current=null;
    latest.current = null; setState(null); setLoading(true); setBusy(false); setError(null);
    void openNativeSequence(projectId, controller.signal).then(value => { if (generation === epoch.current && value) accept(value); })
      .catch(error => { if (!controller.signal.aborted) setError(String(error.message ?? error)); })
      .finally(() => { if (generation === epoch.current) setLoading(false); });
    return () => { epoch.current++; controller.abort();clearTimeout(saveCompleteTimer.current); };
  }, [projectId, accept, reloadKey]);
  const run = useCallback((work: () => Promise<NativeSession>): Promise<boolean> => {
    const generation = epoch.current;
    pendingWork.current++;
    setBusy(true); setError(null);
    const task = queue.current.then(async () => {
      if (generation !== epoch.current) return false;
      try { const next = await work(); if (generation === epoch.current) accept(next); return true; }
      catch (error) {
        if (generation === epoch.current) {
          const names=error instanceof NativeApiError?error.targets.map(id=>latest.current?.document.clips.find(c=>c.id===id)?.name).filter((name):name is string=>!!name):[];
          setError(`${error instanceof Error?error.message:String(error)}${names.length?`（${[...new Set(names)].join('、')}）`:''}`);
        }
        return false;
      }
    });
    queue.current = task;
    void task.finally(() => {
      if (generation !== epoch.current) return;
      pendingWork.current--;
      if (queue.current === task) setBusy(false);
    });
    return task;
  }, [accept]);
  const execute = useCallback((command: NativeCommand) => {
    // Keep the revision that the user actually edited, even while another request is pending.
    const current = latest.current, executionId = crypto.randomUUID();
    return run(async () => {
      if (!current) throw new Error('編集データがありません');
      return nativeRequest<NativeSession>(projectId, '/command', { sessionId: current.sessionId, expectedRevision: current.document.revision, executionId, command });
    });
  }, [projectId, run]);
  const save = useCallback(() => {
    if (saveInFlight.current) return saveInFlight.current;
    const generation=epoch.current;
    clearTimeout(saveCompleteTimer.current);setSaveProgress(10);
    const progress=(percent:number)=>{if(generation===epoch.current)setSaveProgress(percent);};
    const task = run(async () => {
      const send = async (request: NonNullable<typeof pendingSave.current>) => {
        pendingSave.current = request;
        try { const result = await saveNativeSequence(projectId,request,progress); if(generation===epoch.current)pendingSave.current = null; return result; }
        catch(error) { if (generation===epoch.current&&error instanceof NativeApiError && error.status>=400&&error.status < 500) pendingSave.current = null; throw error; }
      };
      let current = latest.current; if (!current) throw new Error('編集データがありません');
      // Recover an unknown result with the identical execution ID before saving newer edits.
      if (pendingSave.current) { current = await send(pendingSave.current);if(generation!==epoch.current)return current; accept(current); if (!current.dirty) return current; }
      return send({ sessionId: current.sessionId, expectedRevision: current.document.revision,
        expectedSavedRevision: current.savedRevision, executionId: crypto.randomUUID() });
    });
    saveInFlight.current = task; void task.then(ok => {
      if (saveInFlight.current === task) saveInFlight.current = null;
      if(generation!==epoch.current)return;
      setSaveProgress(ok?100:null);
      if(ok)saveCompleteTimer.current=setTimeout(()=>setSaveProgress(null),900);
    });
    return task;
  }, [projectId, run, accept]);
  const migrate = useCallback(() => run(async () => {
    await nativeRequest(projectId, '/migrate', { executionId: crypto.randomUUID() });
    return nativeRequest<NativeSession>(projectId, '/session', {});
  }), [projectId, run]);
  const upload = useCallback((file: File,onProgress?:Parameters<typeof uploadNativeAsset>[2],onUploaded?:(assetId:string)=>void,role?:'music'|'effect') => run(async () => {
    const asset = await uploadNativeAsset(projectId, file,onProgress,role), current = latest.current;
    onUploaded?.(asset.id);
    if (!current) throw new Error('編集データがありません');
    return nativeRequest<NativeSession>(projectId, '/register', { sessionId: current.sessionId, expectedRevision: current.document.revision,
      executionId: crypto.randomUUID(), assetIds: [asset.id] });
  }), [projectId, run]);
  const reference=useCallback((path:string,expectedFingerprint?:string,onRegistered?:(assetId:string)=>void,role?:'music'|'effect')=>run(async()=>{
    const before=latest.current;if(!before)throw new Error('編集データがありません');
    const {asset}=await nativeRequest<{asset:SequenceAsset}>(projectId,'/reference',{path,...(expectedFingerprint?{expectedFingerprint}:{}),...(role?{role}:{})});
    const current=latest.current;
    if(!current||current.sessionId!==before.sessionId||current.document.id!==before.document.id)throw new Error('編集する案件が変わりました');
    const registered=await nativeRequest<NativeSession>(projectId,'/register',{sessionId:current.sessionId,expectedRevision:current.document.revision,executionId:crypto.randomUUID(),assetIds:[asset.id]});
    onRegistered?.(asset.id);return registered;
  }),[projectId,run]);
  const reconnect=useCallback((assetId:string,path:string)=>run(async()=>{
    const before=latest.current;if(!before)throw new Error('編集データがありません');
    await nativeRequest(projectId,'/reference/reconnect',{assetId,path});
    const current=latest.current;
    if(!current||current.sessionId!==before.sessionId||current.document.id!==before.document.id)throw new Error('編集する案件が変わりました');
    return current;
  }),[projectId,run]);
  const prepareTextStyles=useCallback(()=>run(async()=>{
    const current=latest.current;if(!current)throw new Error('編集データがありません');
    return nativeRequest<NativeSession>(projectId,'/text-styles',{sessionId:current.sessionId,expectedRevision:current.document.revision,executionId:crypto.randomUUID()});
  }),[projectId,run]);
  const importLegacyCutHistory=useCallback(()=>{
    const before=latest.current,generation=epoch.current;
    return run(async()=>{
      if(!before)throw new Error('編集データがありません');
      const owns=()=>generation===epoch.current&&latest.current?.sessionId===before.sessionId&&latest.current.document.id===before.document.id;
      let request=pendingLegacyCuts.current;
      if(request&&(request.projectId!==projectId||request.sessionId!==before.sessionId))request=null;
      if(!request){
        const plan=await nativeRequest<{planId:string;planDigest:string;documentId:string;revision:number}>(projectId,'/legacy-cuts/prepare',{sessionId:before.sessionId,expectedRevision:before.document.revision});
        if(!owns()||latest.current!.document.revision!==before.document.revision||plan.documentId!==before.document.id||plan.revision!==before.document.revision)throw new Error('編集内容が変わりました。旧カットをもう一度読み込んでください。');
        request={projectId,sessionId:before.sessionId,expectedRevision:before.document.revision,executionId:crypto.randomUUID(),planId:plan.planId,planDigest:plan.planDigest};
      }
      if(!owns())throw new Error('編集する案件が変わりました');
      pendingLegacyCuts.current=request;
      const {projectId:_,...body}=request;
      try{
        const next=await nativeRequest<NativeSession>(projectId,'/legacy-cuts/adopt',body);
        if(pendingLegacyCuts.current===request)pendingLegacyCuts.current=null;
        return next;
      }catch(cause){
        // An interrupted response may have committed. Retry that exact command.
        if(cause instanceof NativeApiError&&cause.status>=400&&cause.status<500&&pendingLegacyCuts.current===request)pendingLegacyCuts.current=null;
        throw cause;
      }
    });
  },[projectId,run]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (latest.current?.dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  // Notifications are the fast path; polling/focus recover missed events and reconnects.
  const changed = (raw: unknown) => {
    if (!raw || typeof raw !== 'object' || !('type' in raw) || !['change','open'].includes(String(raw.type))) return;
    pendingRefresh.current = true; refreshNow.current();
  };
  useEventChannel('sequence', changed, projectId);
  useEventChannel('watch', changed, projectId);
  useEffect(() => {
    if (!state) return;
    const controller = new AbortController(); let inFlight = false;
    const refresh = async () => {
      const current = latest.current;
      if (document.hidden || refreshBlocked.current || pendingWork.current || inFlight || !current) { pendingRefresh.current = true; return; }
      const generation = epoch.current; inFlight = true; pendingRefresh.current = false;
      const owns = () => !controller.signal.aborted && generation === epoch.current;
      const canApply = () => owns() && !refreshBlocked.current && !pendingWork.current && latest.current === current;
      try {
        let next = await nativeRequest<NativeSession>(projectId, '/session/status', {sessionId:current.sessionId}, controller.signal);
        if (!canApply()) { if (owns()) pendingRefresh.current = true; return; }
        if (next.externalChange && !next.dirty && !current.dirty && reloadDeferred.current) pendingReload.current = true;
        else if (next.externalChange && !next.dirty && !current.dirty) {
          pendingReload.current = false;
          const external = next.externalChange;
          next = await nativeRequest<NativeSession>(projectId, '/session/reload', {
            sessionId:next.sessionId, expectedRevision:next.document.revision,
            savedRevision:external.savedRevision, contentHash:external.contentHash, onlyIfClean:true,
          }, controller.signal);
        }
        if (canApply()) {
          accept(next);
          const previousError = refreshError.current; refreshError.current = null;
          if (previousError) setError(value => value === previousError ? null : value);
        }
        else if (owns()) pendingRefresh.current = true;
      } catch (error) {
        // A concurrent edit/save won the revision check. Read it on the next event/poll.
        if (owns() && !(error instanceof NativeApiError && error.status === 409)) {
          refreshError.current = error instanceof Error ? error.message : String(error); setError(refreshError.current);
        }
      } finally {
        inFlight = false;
        if (owns() && pendingRefresh.current && !document.hidden && !refreshBlocked.current && !pendingWork.current) void refresh();
      }
    };
    refreshNow.current = () => { void refresh(); };
    if (pendingRefresh.current || state.externalChange) void refresh();
    const timer = setInterval(() => { void refresh(); }, 1500);
    const resume = () => { void refresh(); };
    window.addEventListener('focus', resume); window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => { clearInterval(timer); controller.abort(); refreshNow.current = () => {}; window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume); };
  }, [projectId, state?.sessionId, accept]);
  useEffect(() => { if (!busy && !deferExternal && (pendingRefresh.current || pendingReload.current)) refreshNow.current(); }, [busy, deferExternal]);
  const reloadExternal = useCallback(() => {
    const current = latest.current, external = current?.externalChange;
    return run(async () => {
      if (!current || !external) throw new Error('外部変更の状態を再確認してください');
      return nativeRequest<NativeSession>(projectId, '/session/reload', {sessionId:current.sessionId,
        expectedRevision:current.document.revision, savedRevision:external.savedRevision, contentHash:external.contentHash});
    });
  }, [projectId, run]);
  return { state, loading, busy, saveProgress, error, reloadExternal, execute, save, migrate, upload, reference, reconnect, prepareTextStyles, importLegacyCutHistory, accept, readCurrent:()=>latest.current,
    retry: () => setReloadKey(value => value + 1), clearError: () => setError(null) };
}
