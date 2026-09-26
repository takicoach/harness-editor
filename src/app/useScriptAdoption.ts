import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScriptEditArtifact } from '../core/scriptEditArtifact';
import { validateScriptEditArtifact } from '../core/scriptEditArtifact';
import { scriptJudgmentSchema, type ScriptJudgmentExample } from '../learning/scriptDecisions';
import { ApiError, fetchJson } from './fetchJson';
import { editorAgentPost } from './useEditorAgentConnection';
import type { ScriptEditModification } from '../core/scriptEditModification';
import { preferenceCommandBase, usePreferenceWorkspace } from './usePreferenceWorkspace';
import { isScriptAdoptionDecision, latestScriptJudgment, readScriptApplicationReceipt, scriptApplicationRequest, type ScriptApplicationReceipt } from './edit/scriptAdoption';

export type ScriptDecisionInput = Pick<ScriptJudgmentExample, 'decision' | 'reasonCode' | 'note' | 'learningConsent' | 'modification'>;
export interface ScriptAdoptionBridge {
  sessionId:string;
  read():{projectId:string;revision:string;dirty:boolean;saving:boolean;humanBusy:boolean}|null;
  review?(artifact:ScriptEditArtifact,modification?:ScriptEditModification):Promise<ScriptEditArtifact>;
}

/** Judgment intent lives in the existing preference journal; execution lives in editor operations. */
export function useScriptAdoption(artifact: ScriptEditArtifact, bridge: ScriptAdoptionBridge, isCurrent: () => boolean) {
  const workspace = usePreferenceWorkspace();
  const judgment = workspace.state ? latestScriptJudgment(workspace.state.decisions, artifact) : null;
  const [receipt, setReceipt] = useState<{ id: string; value: ScriptApplicationReceipt | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const active = useRef(false), mounted = useRef(true);
  const live = useRef({ bridge, isCurrent, judgment }); live.current = { bridge, isCurrent, judgment };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const lookup = useCallback(async (event: ScriptJudgmentExample) => {
    if (!event.application) return null;
    const request = scriptApplicationRequest(event);
    const query = new URLSearchParams({ projectId: event.projectId, operationId: request.operationId });
    try { return readScriptApplicationReceipt(await fetchJson(`/api/editor/operation?${query}`), event); }
    catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
  }, []);

  useEffect(() => {
    if (!judgment || !isScriptAdoptionDecision(judgment.decision) || !judgment.application) return;
    let alive = true, polling = false;
    async function refresh() {
      if (polling || !alive) return;
      polling = true;
      try { const value = await lookup(judgment!); if (alive) setReceipt({ id: judgment!.id, value }); }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)); }
      finally { polling = false; }
    }
    void refresh(); const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [judgment?.id, lookup]);

  function requireCurrent() {
    const current = live.current.bridge.read();
    if (!mounted.current || !live.current.isCurrent() || !current || current.projectId !== artifact.input.alignment.packet.projectId
      || current.dirty || current.saving || current.humanBusy) throw new Error('編集内容が変わったか、別の操作が進行中です。現在の変更案を確認してください');
    return current;
  }

  async function enqueue(event: ScriptJudgmentExample) {
    const existing = await lookup(event);
    if (existing && existing.phase !== 'queued') { if (mounted.current) setReceipt({ id: event.id, value: existing }); return; }
    const current = requireCurrent();
    let value: ScriptApplicationReceipt;
    try {
      const result = await editorAgentPost('operations', { sessionId: live.current.bridge.sessionId, request: scriptApplicationRequest(event, current.revision) });
      value = readScriptApplicationReceipt(result, event);
    } catch (e) {
      // The original delivery may have arrived between lookup and retry. Its
      // stable operation ID wins; never create another ID for the same intent.
      const arrived = await lookup(event);
      if (!arrived) throw e;
      value = arrived;
    }
    if (mounted.current) setReceipt({ id: event.id, value });
  }

  async function action(run: () => Promise<void>) {
    if (active.current) return;
    active.current = true; setWorking(true); setError(null);
    try { await run(); }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { active.current = false; if (mounted.current) setWorking(false); }
  }

  async function decide(input: ScriptDecisionInput) {
    await action(async () => {
      if (!workspace.state || workspace.pending) throw new Error('判断記録の読み込み・保存を確認してください');
      const current = requireCurrent();
      const prior = live.current.judgment;
      if (isScriptAdoptionDecision(prior?.decision)) throw new Error('この変更案の採用判断は記録済みです。編集結果を確認してください');
      const query = new URLSearchParams({ id: current.projectId, mode: artifact.proposal.kind });
      const checked = validateScriptEditArtifact(live.current.bridge.review?await live.current.bridge.review(artifact,input.modification):await fetchJson(`/api/script-edit-review?${query}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(artifact),
      }));
      if (JSON.stringify(checked) !== JSON.stringify(artifact)) throw new Error('変更案の内容が一致しません');
      const latest = requireCurrent();
      if (latest.revision !== current.revision) throw new Error('編集状態が変わりました。変更案を再確認してください');
      const base = preferenceCommandBase();
      const event = scriptJudgmentSchema.parse({ schemaVersion: 1, type: 'script_judgment', id: crypto.randomUUID(),
        operationId: base.operationId, createdAt: base.at, actor: base.actor,
        projectId: current.projectId, projectRevision: artifact.input.alignment.packet.editRevision,
        artifact, ...input, scope: { kind: 'project', id: current.projectId }, provenance: { kind: workspace.recordingProvenance },
        ...(isScriptAdoptionDecision(input.decision) ? { application: { sessionId: bridge.sessionId, baseRevision: current.revision } } : {}),
        ...(prior ? { supersedes: prior.id } : {}) });
      const saved = await workspace.execute({ ...base, kind: 'decision', event });
      const stored = scriptJudgmentSchema.parse(saved.decisions.events.find(e => e.id === event.id));
      if (stored.decision !== event.decision || JSON.stringify(stored.artifact) !== JSON.stringify(event.artifact)
        || JSON.stringify(stored.modification) !== JSON.stringify(event.modification)) throw new Error('判断の保存内容を確認できません');
      if (isScriptAdoptionDecision(stored.decision)) await enqueue(stored);
    });
  }

  return { workspace, judgment, operation: receipt?.id === judgment?.id ? receipt?.value ?? null : null,
    working, error, decide,
    withdrawConsent: () => action(async () => {
      if (!judgment || workspace.pending) throw new Error('撤回する判断と保存状態を確認してください');
      const base = preferenceCommandBase();
      await workspace.execute({ ...base, kind: 'decision', event: { schemaVersion: 1, type: 'withdrawal', id: crypto.randomUUID(),
        operationId: base.operationId, createdAt: base.at, actor: base.actor, targetId: judgment.id,
        reason: '台本変更案の画面で学習への同意を撤回' } });
    }),
    retryRecording: () => action(async () => { await workspace.retry(); }),
    retryApplication: () => action(async () => { if (judgment && isScriptAdoptionDecision(judgment.decision)) await enqueue(judgment); }),
  };
}
