import { useEffect, useRef, useState } from 'react';
import type { EditorOperation, PublicEditorOperation } from '../shared/editorOperations';
import { scriptEditingPresenceHash, type EditorSessionSnapshot } from '../shared/editorSessions';
import { ApiError, extractErrorMessage, fetchJson } from './fetchJson';
import { validateScriptEditArtifact } from '../core/scriptEditArtifact';
import { executeEditorDelivery } from './edit/editorDelivery';
import type { useEditorCommandBridge } from './useEditorCommandBridge';
import type { EditorChangeSet } from '../shared/editorCommands';
import type { EditorOperationResult } from '../shared/editorOperations';
import type { EditorDeliveryGuard } from '../shared/editorDeliveryGuard';

export async function editorAgentPost<T>(route: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/editor/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const result: unknown = await response.json();
  if (!response.ok) throw new ApiError(response.status, extractErrorMessage(result));
  return result as T;
}
type Bridge = ReturnType<typeof useEditorCommandBridge>;
export interface AsyncEditorBridge {
  sessionId:string;
  presence(projectId:string|null,failed:boolean):EditorSessionSnapshot | Promise<EditorSessionSnapshot>;
  apply(request:EditorChangeSet,delivery?:EditorDeliveryGuard):Promise<EditorOperationResult>;
  save(request:EditorChangeSet,delivery?:EditorDeliveryGuard):Promise<EditorOperationResult>;
  hasApplied(request:unknown):boolean;
  validateScript?(request:EditorChangeSet):Promise<void>;
}

export function editorSessionPresence(editor: ReturnType<Bridge['read']>, projectId: string | null,
  projectFailed = false, scriptEditingHash?: string): EditorSessionSnapshot {
  return editor ? {
    status: 'ready', projectId: editor.projectId, revision: editor.revision,
    dirty: editor.dirty, saving: editor.saving, humanBusy: editor.humanBusy,
    ...(scriptEditingHash ? { scriptEditingHash } : {}),
    elements: editor.state.telops.map((telop) => ({ id: String(telop.id), text: telop.text,
      sourceFrameRange: { start: telop.originalStart, end: telop.originalEnd } })),
  } : projectId ? { status: projectFailed ? 'error' : 'loading', projectId } : { status: 'home', projectId: null };
}

/** Presence continues while an individual save is waiting. Delivery effects use the existing editor session. */
export function useEditorAgentConnection(bridge: Bridge | AsyncEditorBridge, projectId: string | null,
  onResult: (operation: PublicEditorOperation) => void, projectFailed = false) {
  const key = useRef(crypto.randomUUID());
  const sequence = useRef(0);
  const latest = useRef({ bridge, projectId, onResult, projectFailed });
  latest.current = { bridge, projectId, onResult, projectFailed };
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [needsReview,setNeedsReview]=useState(false);
  const [readySnapshot, setReadySnapshot] = useState<{ projectId: string; revision: string } | null>(null);
  const credentials = { sessionId: bridge.sessionId, sessionKey: key.current };

  useEffect(() => {
    let alive = true; let polling = false; let needsDisconnect = false;
    const pending = new Set<string>();
    const identity = { sessionId: bridge.sessionId, sessionKey: key.current };
    const reportUnknown = (message: string) => { needsDisconnect = true; if (alive) setError(message); };
    async function process(operation: EditorOperation) {
      if (pending.has(operation.runId) || !alive || needsDisconnect) return;
      pending.add(operation.runId);
      try {
        const result = await executeEditorDelivery(operation, {
          ...(operation.request.script ? { validate: async (request: typeof operation.request) => {
            if (latest.current.bridge.hasApplied(request)) return;
            if (!request.script) return;
            const bridge=latest.current.bridge;
            if('presence' in bridge) {
              if(!bridge.validateScript)throw new Error('NATIVE_SCRIPT_REVIEW_REQUIRED: 台本案の確認に対応した画面で開いてください');
              await bridge.validateScript(request);return;
            }
            const query = new URLSearchParams({ id: request.projectId, mode: request.script.artifact.proposal.kind });
            const artifact = validateScriptEditArtifact(await fetchJson(`/api/script-edit-review?${query}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.script.artifact),
            }));
            if (JSON.stringify(artifact) !== JSON.stringify(request.script.artifact)) throw new Error('SCRIPT_INPUT_CHANGED');
          } } : {}),
          read: () => editorAgentPost('delivery', { ...identity, runId: operation.runId }),
          acknowledge: (result) => editorAgentPost('ack', { ...identity, runId: operation.runId,
            token: operation.claim!.token, result }),
          apply: (request) => {
            if (!alive) throw new Error('EDITOR_UNAVAILABLE: 編集画面を閉じました');
            const bridge=latest.current.bridge;
            return 'presence' in bridge ? bridge.apply(request,{runId:operation.runId,token:operation.claim!.token}) : bridge.apply(request);
          },
          save: (request) => {
            if (!alive) throw new Error('EDITOR_UNAVAILABLE: 編集画面を閉じました');
            return latest.current.bridge.save(request, { runId: operation.runId, token: operation.claim!.token });
          },
        });
        if (result.kind === 'unknown') reportUnknown(result.message);
        else if (result.kind === 'finished' && alive) latest.current.onResult(result.operation);
      } catch { reportUnknown('AI編集の結果を確認できません。作業履歴から内容を確認してください'); }
      finally { pending.delete(operation.runId); }
    }
    async function poll() {
      if (polling || !alive) return;
      polling = true;
      try {
        if (needsDisconnect) {
          try { await editorAgentPost('disconnect', identity); }
          catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
          needsDisconnect = false;
        }
        const current = latest.current;
        const editor = 'presence' in current.bridge ? null : current.bridge.read();
        const scriptHash = editor ? await scriptEditingPresenceHash({ ...editor.state,
          scriptDocument: editor.state.scriptDocument ?? null,
          originalTotalFrames: editor.state.originalTotalFrames ?? null }) : undefined;
        const snapshot = 'presence' in current.bridge ? await current.bridge.presence(current.projectId,current.projectFailed)
          : editorSessionPresence(editor, current.projectId, current.projectFailed, scriptHash);
        const response = await editorAgentPost<{ deliveries: EditorOperation[]; unresolved?:boolean }>('heartbeat', {
          ...identity, sequence: ++sequence.current, snapshot,
        });
        if (!alive) return;
        setConnection('connected');
        setTransportError(null);
        setNeedsReview(response.unresolved===true);
        setReadySnapshot(snapshot.status === 'ready' && !response.unresolved && !snapshot.dirty && !snapshot.saving && !snapshot.humanBusy
          ? { projectId: snapshot.projectId, revision: snapshot.revision } : null);
        for (const operation of response.deliveries) void process(operation);
      } catch (e) {
        if (alive) {
          setConnection('offline');
          setReadySnapshot(null);
          // A failed heartbeat says nothing about whether an edit was applied.
          // Keep unknown delivery outcomes latched separately until reviewed.
          console.warn('AI接続の確認に失敗しました',e);
          setTransportError(e instanceof ApiError ? e.message : e instanceof Error && e.name === 'TimeoutError'
            ? 'AIとの接続を確認しています。自動で再接続します。'
            : '接続できません。自動で再接続します。');
        }
      } finally { polling = false; }
    }
    const onPageHide = () => {
      navigator.sendBeacon('/api/editor/disconnect', new Blob([JSON.stringify(identity)], { type: 'application/json' }));
    };
    window.addEventListener('pagehide', onPageHide);
    void poll(); const interval = window.setInterval(() => { void poll(); }, 2000);
    return () => {
      alive = false; window.clearInterval(interval); window.removeEventListener('pagehide', onPageHide);
      // React effect remounts are not browser disconnects. Real disappearance expires at the server.
    };
  }, [bridge.sessionId]);
  return { connection, error, transportError, credentials, readySnapshot, needsReview, clearError: () => setError(null) };
}
