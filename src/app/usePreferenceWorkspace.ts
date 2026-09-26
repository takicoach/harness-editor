import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreferenceCommand, PreferenceWorkspace } from '../learning/preferenceWorkspaceStore';
import { ApiError, fetchJson, putJsonPost } from './fetchJson';

type WorkspaceResponse = PreferenceWorkspace & { recordingProvenance?: 'human' | 'synthetic' };

export function preferenceCommandBase() {
  return { operationId: crypto.randomUUID(), at: new Date().toISOString(), actor: { kind: 'human' as const, id: 'local-user' } };
}

const PENDING_KEY = 'sme-preference-pending-command-v1';
// The preference dialog and inline script review share one pending record.
let preferenceCommandInFlight = false;
const workspaceListeners = new Set<(change: 'pending' | 'workspace') => void>();
const notifyWorkspace = (change: 'pending' | 'workspace') => { for (const listener of workspaceListeners) listener(change); };
function readPending(): { pending: PreferenceCommand | null; error: string | null } {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (raw === null) return { pending: null, error: null };
    const input: unknown = JSON.parse(raw);
    if (!input || typeof input !== 'object' || !('operationId' in input) || typeof input.operationId !== 'string') throw new Error('invalid record');
    return { pending: input as PreferenceCommand, error: '前の記録の保存が未確認です。同じ記録の保存を再確認してください。' };
  } catch {
    return { pending: null, error: 'この画面に退避した未確認の記録を読み込めませんでした。判断の記録を確認してから、必要な内容を再記録してください。' };
  }
}

/** Failed commands retain their operation ID for a safe retry, including an ambiguous network failure. */
export function usePreferenceWorkspace() {
  const [initial] = useState(readPending);
  const [state, setState] = useState<WorkspaceResponse | null>(null);
  const [error, setError] = useState<string | null>(initial.error);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PreferenceCommand | null>(initial.pending);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const pendingRef = useRef<PreferenceCommand | null>(initial.pending);
  const refresh = useCallback(async () => {
    const result = await fetchJson<WorkspaceResponse>('/api/preferences');
    if (mounted.current) setState(result);
    return result;
  }, []);
  useEffect(() => {
    mounted.current = true;
    const update = (change: 'pending' | 'workspace') => {
      const saved = readPending(); pendingRef.current = saved.pending;
      setPending(saved.pending);
      if (change === 'workspace') void refresh().catch((e: unknown) => { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); });
    };
    workspaceListeners.add(update);
    void refresh().catch((e: unknown) => { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); });
    return () => { mounted.current = false; workspaceListeners.delete(update); };
  }, [refresh]);
  const execute = useCallback(async (command: PreferenceCommand) => {
    if (inFlight.current || preferenceCommandInFlight) throw new Error('記録の保存が終わるまでお待ちください');
    const persisted = readPending();
    if (!persisted.pending && persisted.error) throw new Error(persisted.error);
    pendingRef.current = persisted.pending;
    if (pendingRef.current && pendingRef.current.operationId !== command.operationId) {
      setPending(pendingRef.current);
      throw new Error('前の記録の保存を再確認してください');
    }
    preferenceCommandInFlight = true;
    inFlight.current = true; pendingRef.current = command;
    setBusy(true); setError(null); setPending(command);
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify(command));
      notifyWorkspace('pending');
      const next = await putJsonPost<WorkspaceResponse>('/api/preferences/command', command);
      sessionStorage.removeItem(PENDING_KEY);
      pendingRef.current = null;
      if (mounted.current) { setState(next); setPending(null); }
      notifyWorkspace('workspace');
      return next;
    } catch (e) {
      // A definitive rejection did not commit. Let the user correct it instead of trapping them in retries.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408) {
        sessionStorage.removeItem(PENDING_KEY);
        pendingRef.current = null;
        if (mounted.current) setPending(null);
        notifyWorkspace('pending');
      }
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      preferenceCommandInFlight = false;
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  const retry = useCallback(async () => {
    const persisted = readPending();
    if (!persisted.pending) {
      if (persisted.error) throw new Error(persisted.error);
      pendingRef.current = null; setPending(null);
      return refresh();
    }
    return execute(persisted.pending);
  }, [execute, refresh]);
  return { state, error, busy, pending, refresh, execute, retry, recordingProvenance: state?.recordingProvenance ?? 'human' };
}
