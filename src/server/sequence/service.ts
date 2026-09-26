import {observeExternalEdits} from './externalEdits';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { SequenceSession, type EditRequest } from '../../core/sequence/session';
import { SequenceError } from '../../core/sequence/errors';
import type { SequenceDocument } from '../../core/sequence/model';
import { SequenceStore, type SavedSequence, type SaveSequenceRequest } from './store';
import { editorChangeSetSchema } from '../../shared/editorCommands';
import { sequenceEditorCommand,sequenceEditorRevision } from '../../core/sequence/editorCommands';
import { assertNativeScriptEditCurrent } from './scriptEdits';

interface SessionSaveRequest { sessionId: string; expectedRevision: number; expectedSavedRevision: number; executionId: string }
interface OpenSession { historyError?:string; session: SequenceSession; saved: SavedSequence; saves: Map<string, { input: SessionSaveRequest; snapshot: SaveSequenceRequest }>;
  agentRequests:Map<string,{input:string;edit:EditRequest}> }
export interface SequenceSessionState {
  sessionId: string;
  document: SequenceDocument;
  savedRevision: number;
  savedContentHash: string;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  historyError?: string;
  externalChange?: { savedRevision: number; contentHash: string; summary: string };
}

/** One editing authority per project. Human and AI requests use the same revision/undo history. */
export class SequenceService {
  private sessions = new Map<string, OpenSession>();
  private state(open: OpenSession): SequenceSessionState {
    return { sessionId: open.session.id, document: open.session.document, savedRevision: open.saved.savedRevision,
      savedContentHash: open.saved.contentHash, canUndo: open.session.canUndo, canRedo: open.session.canRedo,
      dirty: open.session.document.revision !== open.saved.savedRevision, ...(open.historyError?{historyError:open.historyError}:{}) };
  }
  open(directory: string, preserveExternal = false): SequenceSessionState {
    const key = realpathSync(directory), saved = new SequenceStore(key).load();
    if (!saved) throw new SequenceError('MISSING_TARGET', '新形式の編集データがありません。案件を移行してください');
    const historyError = this.observe(key, saved);
    let current = this.sessions.get(key);
    if (current && (current.saved.savedRevision !== saved.savedRevision || current.saved.contentHash !== saved.contentHash)) {
      if (current.session.document.revision !== current.saved.savedRevision) throw new SequenceError('REVISION_CONFLICT', '保存済みの内容が別の画面または外部で変更されています。未保存の編集を確認してください');
      if (preserveExternal) return this.inspect(key, current.session.id);
      throw new SequenceError('REVISION_CONFLICT', '保存済みの内容が外部で変更されています。編集画面で再読み込みしてください');
    }
    if (!current) {
      current = { session: new SequenceSession(randomUUID(), saved.document), saved, saves: new Map(), agentRequests:new Map() };
      this.sessions.set(key, current);
    }
    current.historyError = historyError;
    return this.state(current);
  }
  private observe(directory:string,saved:SavedSequence,own=false):string|undefined {
    try { observeExternalEdits(directory,saved,own); return undefined; }
    catch(error) { return `外部編集の履歴を記録できません: ${error instanceof Error?error.message:String(error)}`; }
  }
  assertExternalWritable(directory: string): void {
    const current = this.sessions.get(realpathSync(directory));
    if (current && this.state(current).dirty) throw new SequenceError('REVISION_CONFLICT', '未保存の編集があります。外部編集は保存していません');
  }
  /** Polling must preserve the editing authority and its undo stack until explicit reload. */
  inspect(directory: string, sessionId: string): SequenceSessionState {
    const key = realpathSync(directory), current = this.sessions.get(key);
    if (!current || current.session.id !== sessionId)
      throw new SequenceError('REVISION_CONFLICT', '編集セッションが変わりました。保存済みの内容を読み直してください');
    const saved = new SequenceStore(key).load();
    if (!saved) throw new SequenceError('MISSING_TARGET', '保存済みの編集データが見つかりません');
    current.historyError = this.observe(key, saved);
    const state = this.state(current);
    if (saved.savedRevision !== current.saved.savedRevision || saved.contentHash !== current.saved.contentHash) {
      state.externalChange = { savedRevision: saved.savedRevision, contentHash: saved.contentHash,
        summary: `保存版 ${current.saved.savedRevision} → ${saved.savedRevision}、クリップ ${current.saved.document.clips.length} → ${saved.document.clips.length} 件` };
    }
    return state;
  }
  reload(directory: string, sessionId: string, expectedRevision: number, savedRevision: number, contentHash: string): SequenceSessionState {
    const saved = new SequenceStore(directory).load();
    if (!saved || saved.savedRevision !== savedRevision || saved.contentHash !== contentHash)
      throw new SequenceError('REVISION_CONFLICT', '確認中に外部の保存内容が変わりました。変更内容を再確認してください');
    return this.discard(directory, sessionId, expectedRevision);
  }
  private current(directory: string, sessionId: string): OpenSession {
    const key = realpathSync(directory), open = this.sessions.get(key);
    if (!open || open.session.id !== sessionId) throw new SequenceError('REVISION_CONFLICT', '編集セッションが変わりました。保存済みの内容を読み直してください');
    const saved = new SequenceStore(key).load();
    if (!saved || saved.savedRevision !== open.saved.savedRevision || saved.contentHash !== open.saved.contentHash)
      throw new SequenceError('REVISION_CONFLICT', '保存済みの内容が別の画面または外部で変更されています');
    return open;
  }
  execute(directory: string, request: EditRequest): SequenceSessionState & { executionId: string; appliedRevision: number; changed: boolean; replayed: boolean } {
    const open = this.current(directory, request.sessionId);
    const receipt = open.session.execute(request);
    return { ...this.state(open), executionId: receipt.executionId, appliedRevision: receipt.appliedRevision, changed: receipt.changed, replayed: receipt.replayed };
  }
  applyEditor(directory:string,projectId:string,sessionId:string,input:unknown) {
    const request=editorChangeSetSchema.parse(input), open=this.current(directory,sessionId), serialized=JSON.stringify(request);
    if(request.projectId!==projectId) throw new Error('PROJECT_MISMATCH: 対象の案件が異なります');
    const previous=open.agentRequests.get(request.operationId);
    if(previous) {
      if(previous.input!==serialized) throw new Error('OPERATION_CONFLICT: 同じ操作IDの内容が変わっています');
      return this.execute(directory,previous.edit);
    }
    if(this.state(open).dirty) throw new Error('UNSAVED_CHANGES: 人の未保存編集があります');
    const document=open.session.document;
    if(request.baseRevision!==sequenceEditorRevision(sessionId,document.revision))throw new Error('REVISION_CONFLICT: 編集状態が変わりました');
    const command=request.script
      ?assertNativeScriptEditCurrent(directory,projectId,request.script.artifact,document,request.script.modification).command
      :sequenceEditorCommand(document,projectId,sessionId,request);
    const edit:EditRequest={sessionId,expectedRevision:document.revision,executionId:`agent:${createHash('sha256').update(request.operationId).digest('hex')}`,command};
    const result=this.execute(directory,edit);
    open.agentRequests.set(request.operationId,{input:serialized,edit});
    return result;
  }
  save(directory: string, request: SessionSaveRequest): SequenceSessionState & { replayed: boolean } {
    const open = this.current(directory, request.sessionId), document = open.session.document;
    const previous = open.saves.get(request.executionId);
    if (previous) {
      if (previous.input.expectedRevision !== request.expectedRevision || previous.input.expectedSavedRevision !== request.expectedSavedRevision)
        throw new SequenceError('REVISION_CONFLICT', '同じ保存IDに異なる要求があります');
      const saved = new SequenceStore(directory).save(previous.snapshot);
      open.saved = saved;
      return { ...this.state(open), replayed: saved.replayed };
    }
    if (request.expectedRevision !== document.revision) throw new SequenceError('REVISION_CONFLICT', '保存しようとした編集版が変更されています');
    const snapshot = { expectedSavedRevision: request.expectedSavedRevision, executionId: request.executionId, document };
    const saved = new SequenceStore(directory).save(snapshot);
    open.saves.set(request.executionId, { input: { ...request }, snapshot });
    while (open.saves.size > 64) open.saves.delete(open.saves.keys().next().value!);
    open.saved = saved;
    open.historyError = this.observe(directory, saved, true);
    return { ...this.state(open), replayed: saved.replayed };
  }
  /** Explicit discard only; reopening normally must never throw away unsaved work. */
  discard(directory: string, sessionId: string, expectedRevision: number): SequenceSessionState {
    const key = realpathSync(directory), current = this.sessions.get(key);
    if (!current || current.session.id !== sessionId || current.session.document.revision !== expectedRevision)
      throw new SequenceError('REVISION_CONFLICT', '破棄しようとした編集版が変更されています');
    this.sessions.delete(key);
    return this.open(key);
  }
}

/** Shared by browser commands and the AI read/preview adapter. */
export const sequenceService=new SequenceService();
