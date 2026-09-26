import { createHash } from 'node:crypto';
import { editorChangeSetSchema, validateEditorTextTargets, type EditorTextTarget } from '../shared/editorCommands';
import { publicEditorOperation, type EditorOperation } from '../shared/editorOperations';
import { editorSessionHeartbeatSchema } from '../shared/editorSessions';
import { editorBoardHumanReview, editorBoardOperation, editorProjectBoardPageSchema, selectEditorBoardOperation } from '../shared/editorBoard';
import { EditorOperationStore, editorOperationHash } from './editorOperationStore';
import { EditorSessionRegistry } from './editorSessionRegistry';
import type { EditorAgentContext, EditorPreferencePage } from './editorAgentContext';
import type {NativeEditorAgentAdapter,NativeEditorReadOptions} from './nativeEditorAgentAdapter';

/** A thin bridge between the existing local UI and durable typed-edit receipts. No model or file editor. */
export class EditorAgentService {
  readonly sessions: EditorSessionRegistry;
  constructor(readonly operations: EditorOperationStore, private readonly requireProject: (id: string) => void,
    private readonly now = Date.now, ttlMs = 15000,
    private readonly readSaved?: (projectId: string) => { elements: EditorTextTarget[]; fingerprint: string },
    private readonly context?: EditorAgentContext,private readonly native?:NativeEditorAgentAdapter) {
    this.sessions = new EditorSessionRegistry((id) => operations.disconnect(id), now, ttlMs);
  }
  projects(offset?: number, limit?: number) {
    if (!this.context) throw new Error('CONTEXT_UNAVAILABLE: 案件一覧を利用できません');
    return this.context.projects(offset, limit, this.sessions.list());
  }
  /** Home board projection. It intentionally excludes edit bodies, revisions, run IDs, and ownership credentials. */
  board(offset = 0, limit = 20) {
    const projects = this.projects(offset, limit);
    const operations = this.operations.list();
    const reviewedOperations = this.context ? this.context.review(operations) : operations.map(publicEditorOperation);
    return editorProjectBoardPageSchema.parse({ schemaVersion: 1, total: projects.total, nextOffset: projects.nextOffset,
      items: projects.items.map((project) => {
        const projectOperations = operations.filter((operation) => operation.request.projectId === project.id);
        const selected = selectEditorBoardOperation(projectOperations);
        return { projectId: project.id,
          editor: { connected: project.sessions.length > 0, ready: project.sessions.some((session) => session.status === 'ready'),
            dirty: project.sessions.some((session) => session.status === 'ready' && session.dirty),
            failed: project.sessions.some((session) => session.status === 'error') },
          operation: selected ? editorBoardOperation(selected) : null,
          humanReview: editorBoardHumanReview(reviewedOperations.filter((operation) => operation.request.projectId === project.id)) };
      }) });
  }
  preferences(projectId: string, options?: EditorPreferencePage) {
    this.requireProject(projectId);
    if (!this.context) throw new Error('CONTEXT_UNAVAILABLE: 編集方針を利用できません');
    return this.context.readPreferences(projectId, options);
  }
  private expose(operation: EditorOperation) {
    return this.context ? this.context.review([operation])[0]! : publicEditorOperation(operation);
  }
  heartbeat(input: unknown) {
    const request = editorSessionHeartbeatSchema.parse(input);
    if (request.snapshot.projectId) this.requireProject(request.snapshot.projectId);
    const session = this.sessions.heartbeat(request);
    // A repeated heartbeat can redeliver the same claim; the browser deduplicates by operationId.
    // Expired/restarted claims stay fenced as unknown and never enter this delivery list.
    const deliveries = this.operations.list().filter((op) => op.serverInstance === this.operations.serverInstance
      && op.claim?.sessionId === request.sessionId && ['running', 'applied'].includes(op.phase));
    const unresolved=!!request.snapshot.projectId && this.operations.list(request.snapshot.projectId).some(operation=>operation.phase==='unknown' && !operation.reconciliation);
    return { session, deliveries, unresolved };
  }
  read(sessionId: string, offset = 0, limit = 100) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('INVALID_PAGE: 取得件数は1〜100件で指定してください');
    }
    const snapshot = this.sessions.snapshot(sessionId);
    if (snapshot.status !== 'ready') return { ...snapshot, sessionId };
    return { ...snapshot, sessionId, elements: snapshot.elements.slice(offset, offset + limit),
      total: snapshot.elements.length, nextOffset: offset + limit < snapshot.elements.length ? offset + limit : null };
  }
  readNative(sessionId:string,options:NativeEditorReadOptions){
    const snapshot=this.sessions.snapshot(sessionId);
    if(snapshot.status!=='ready')throw new Error('EDITOR_NOT_READY: 案件の読み込み完了を待ってください');
    this.requireProject(snapshot.projectId);
    if(!this.native)throw new Error('CONTEXT_UNAVAILABLE: タイムラインの読み取りに接続していません');
    return this.native.read(snapshot,options);
  }
  validate(sessionId: string, input: unknown) {
    const snapshot = this.sessions.snapshot(sessionId);
    if (snapshot.status !== 'ready') throw new Error('EDITOR_NOT_READY: 案件の読み込み完了を待ってください');
    this.requireProject(snapshot.projectId);
    if (snapshot.humanBusy) throw new Error('HUMAN_BUSY: 人がダイアログを操作中です');
    if (snapshot.dirty) throw new Error('UNSAVED_CHANGES: 人の未保存編集があります');
    if (snapshot.saving) throw new Error('SAVE_IN_PROGRESS: 保存完了を待ってください');
    const parsed = editorChangeSetSchema.parse(input);
    let request,nativeEvidence;
    if(parsed.sequence){
      if(!this.native)throw new Error('CONTEXT_UNAVAILABLE: タイムライン編集に接続していません');
      nativeEvidence=this.native.validate(snapshot,parsed);request=parsed;
    }else if (parsed.script) {
      if (parsed.projectId !== snapshot.projectId) throw new Error('PROJECT_MISMATCH: 対象の案件が異なります');
      if (parsed.baseRevision !== snapshot.revision) throw new Error('REVISION_CONFLICT: 編集状態が変わりました');
      if (!this.context) throw new Error('SCRIPT_REVIEW_REQUIRED: 台本の採用記録を利用できません');
      this.context.validateScriptDecision(parsed);
      if(snapshot.documentFormat==='sequence-v2') {
        const saved=this.context.inspectSavedScriptEdit(parsed.projectId,parsed.script.artifact,parsed.script.modification);
        if(saved.documentFormat!=='sequence-v2'||saved.savedState!=='input'||snapshot.scriptEditingHash!==saved.presenceHash)
          throw new Error('STALE_SCRIPT_EDIT: 保存内容と確認した台本案が一致しません');
      }else if(parsed.script.artifact.input.native)throw new Error('NATIVE_SCRIPT_REQUIRED: 独自編集の画面で台本案を確認してください');
      request = parsed;
    } else request = validateEditorTextTargets(snapshot, snapshot.elements, parsed);
    return { valid: true as const, sessionId, revision: snapshot.revision, request,...(nativeEvidence?{nativeEvidence}: {}) };
  }
  enqueue(sessionId: string, input: unknown) {
    const request = editorChangeSetSchema.parse(input);
    this.sessions.expire();
    this.requireProject(request.projectId);
    const existing = this.operations.list().find((op) => op.request.operationId === request.operationId);
    if (existing?.phase === 'queued' && existing.request.script && request.script) {
      // queued has no claim and therefore never reached a browser. Revalidate
      // against the current browser, then retain the exact script intent while
      // replacing only its stale transport revision.
      this.validate(sessionId, request);
      const queued = this.operations.rebindQueuedScript(existing.runId, request);
      return this.expose(this.operations.claim(queued.runId, sessionId));
    }
    if (existing) {
      // Store validates exact-body idempotency even after the browser has edited, closed, or restarted.
      const receipt = this.operations.enqueue(request);
      if (receipt.phase !== 'queued') return this.expose(receipt);
    }
    const validated=this.validate(sessionId, request);
    const queued = this.operations.enqueue(request,validated.nativeEvidence);
    return this.expose(this.operations.claim(queued.runId, sessionId));
  }
  acknowledge(sessionId: string, sessionKey: string, runId: string, token: string, result: unknown) {
    this.sessions.authenticate(sessionId, sessionKey);
    return this.expose(this.operations.acknowledge(runId, sessionId, token, result));
  }
  disconnect(sessionId: string, sessionKey: string) { this.sessions.close(sessionId, sessionKey); }
  get(runId: string) { this.sessions.expire(); return this.expose(this.operations.get(runId)); }
  list(projectId?: string) {
    this.sessions.expire();
    if (projectId) this.requireProject(projectId);
    const operations = this.operations.list(projectId);
    return this.context ? this.context.review(operations) : operations.map(publicEditorOperation);
  }
  cancel(runId: string) { this.sessions.expire(); return this.expose(this.operations.cancel(runId)); }
  prepareReconciliation(sessionId: string, runId: string) {
    const snapshot = this.sessions.snapshot(sessionId);
    const operation = this.operations.get(runId);
    if (snapshot.status !== 'ready' || snapshot.projectId !== operation.request.projectId) throw new Error('PROJECT_MISMATCH: 対象の案件を開いてください');
    if (snapshot.dirty || snapshot.saving) throw new Error('UNSAVED_CHANGES: 先に保存するか、変更を取り消してください');
    if (operation.phase !== 'unknown') throw new Error('REVIEW_NOT_REQUIRED: 結果不明の実行ではありません');
    if (!this.readSaved) throw new Error('REVIEW_UNAVAILABLE: 保存内容の確認を利用できません');
    const saved = this.readSaved(snapshot.projectId);
    const canonical = (elements: EditorTextTarget[]) => elements.map((element) => ({ id: element.id, text: element.text,
      sourceFrameRange: { start: element.sourceFrameRange.start, end: element.sourceFrameRange.end },
      ...(element.reference ? {reference:element.reference,referenceRequired:element.referenceRequired}: {}) }));
    if (JSON.stringify(canonical(snapshot.elements)) !== JSON.stringify(canonical(saved.elements))) {
      throw new Error('SAVED_STATE_MISMATCH: 画面と保存内容が異なります。案件を読み直してください');
    }
    const script = operation.request.script
      ? this.context?.inspectSavedScriptEdit(snapshot.projectId, operation.request.script.artifact, operation.request.script.modification)
      : undefined;
    const sequence=operation.request.sequence?(()=>{
      if(!this.native||!operation.nativeEvidence)throw new Error('REVIEW_UNAVAILABLE: 編集前後の保存記録がありません');
      return this.native.reconcile(snapshot,operation.nativeEvidence);
    })():undefined;
    if (operation.request.script && !script) {
      throw new Error('REVIEW_UNAVAILABLE: 台本編集の保存内容を確認できません');
    }
    if (script && snapshot.scriptEditingHash !== script.presenceHash) {
      throw new Error(snapshot.scriptEditingHash
        ? 'SAVED_STATE_MISMATCH: 画面と保存済みの台本・字幕・構成が異なります。案件を読み直してください'
        : 'REVIEW_UNAVAILABLE: この編集画面は台本・構成の保存照合に対応していません。案件を読み直してください');
    }
    const snapshotHash = createHash('sha256').update(JSON.stringify({ operation, sessionId,
      revision: snapshot.revision, saved: { ...saved, elements: canonical(saved.elements) }, script,sequence })).digest('hex');
    return { runId, sessionId, revision: snapshot.revision, snapshotHash, operationHash: editorOperationHash(operation), operation: this.expose(operation),
      targets: operation.request.changes.map((change) => ({ ...change,
        current: saved.elements.find((element) => element.id === change.elementId) ?? null })),
      ...(script ? { script } : {}),...(sequence?{sequence}:{}) };
  }
  reconcile(sessionId: string, sessionKey: string, runId: string, reviewId: string, snapshotHash: string, source: 'human' | 'synthetic') {
    this.sessions.authenticate(sessionId, sessionKey);
    const existing = this.operations.get(runId).reconciliation;
    if (existing?.reviewId === reviewId && existing.sessionId === sessionId && existing.snapshotHash === snapshotHash) {
      return this.expose(this.operations.get(runId));
    }
    const preview = this.prepareReconciliation(sessionId, runId);
    if (preview.snapshotHash !== snapshotHash) throw new Error('REVIEW_STALE: 内容が変わりました。確認を更新してください');
    const script = preview.script ? (() => { const { current: _current, modified: _modified, ...compact } = preview.script; return compact; })() : undefined;
    return this.expose(this.operations.reconcile(runId, { reviewId, sessionId, revision: preview.revision,
      snapshotHash, operationHash: preview.operationHash, reviewedAt: this.now(), source,
      ...(script ? { script } : {}),...(preview.sequence?{sequence:preview.sequence}:{}) }));
  }
  /** Browser-only claim refresh before each effect. Public agent responses never contain the claim token. */
  delivery(sessionId: string, sessionKey: string, runId: string): EditorOperation {
    this.sessions.authenticate(sessionId, sessionKey);
    const operation = this.operations.get(runId);
    if (operation.claim?.sessionId !== sessionId) throw new Error('CLAIM_MISMATCH: 実行担当が異なります');
    return operation;
  }
}
