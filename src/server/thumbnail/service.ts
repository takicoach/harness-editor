import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { SequenceError } from '../../core/sequence/errors';
import type { SequenceAsset } from '../../core/sequence/model';
import { sequenceContentBytes } from '../../core/sequence/validate';
import { emptyThumbnailDocument, thumbnailCanvasFor, type ThumbnailDocument } from '../../core/thumbnail/model';
import { pageToSequence } from '../../core/thumbnail/pageToSequence';
import { ThumbnailSession, type ThumbnailEditRequest } from '../../core/thumbnail/session';
import { SequenceStore } from '../sequence/store';
import { ThumbnailStore, type SaveThumbnailRequest, type SavedThumbnail } from './store';

export type ThumbnailEvent = { type: 'change' } | { type: 'preview'; pageId: string; contentHash: string } | { type: 'export'; executionId: string; phase: string };
export interface ThumbnailSessionState {
  sessionId: string; document: ThumbnailDocument; savedRevision: number; savedContentHash: string; canUndo: boolean; canRedo: boolean; dirty: boolean;
  /** 案ごとの描画内容の指紋。縮小画像と書き出しの照合に使う。 */
  pageHashes: Record<string, string>;
  externalChange?: { savedRevision: number; contentHash: string };
}
export type ThumbnailFileStatus = { status: 'saved'; savedRevision: number; contentHash: string } | { status: 'missing' | 'broken'; backupAvailable: boolean; preservedFiles: string[] };
export interface ThumbnailSaveRequest { sessionId: string; expectedRevision: number; expectedSavedRevision: number; executionId: string }
export class ThumbnailConflictError extends SequenceError {
  constructor(message: string, readonly evacuatedFile?: string) { super('REVISION_CONFLICT', message); this.name = 'ThumbnailConflictError'; }
}
export class ThumbnailBrokenError extends Error {
  constructor(readonly preservedFile: string) {
    super(`サムネの保存ファイルが壊れていたため ${preservedFile} として保全しました。控えから戻すか、新しく始めるかを選んでください`);
    this.name = 'ThumbnailBrokenError';
  }
}
interface OpenThumbnail { session: ThumbnailSession; saved: SavedThumbnail; saves: Map<string, { input: ThumbnailSaveRequest; snapshot: SaveThumbnailRequest }> }
export function thumbnailPageHash(document: ThumbnailDocument, pageId: string): string {
  return createHash('sha256').update(sequenceContentBytes(pageToSequence(document, pageId))).digest('hex');
}
function changed(message: string): never { throw new SequenceError('REVISION_CONFLICT', message); }

/** 案件ごとに 1 つのサムネ編集の権威。動画の SequenceService とは保存・Undo・通知が別。 */
export class ThumbnailService {
  private sessions = new Map<string, OpenThumbnail>();
  private listeners = new Map<string, Set<(event: ThumbnailEvent) => void>>();
  subscribe(directory: string, listener: (event: ThumbnailEvent) => void): () => void {
    const key = realpathSync(directory), listeners = this.listeners.get(key) ?? new Set<(event: ThumbnailEvent) => void>();
    listeners.add(listener); this.listeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key); };
  }
  notify(directory: string, event: ThumbnailEvent): void {
    for (const listener of this.listeners.get(realpathSync(directory)) ?? []) listener(event);
  }
  status(directory: string): ThumbnailFileStatus {
    const store = new ThumbnailStore(directory), load = store.load();
    if (load.kind === 'ok') return { status: 'saved', savedRevision: load.saved.savedRevision, contentHash: load.saved.contentHash };
    const preservedFiles = store.brokenFiles();
    return { status: preservedFiles.length ? 'broken' : 'missing', backupAvailable: store.hasBackup(), preservedFiles };
  }
  create(directory: string, executionId: string): ThumbnailSessionState {
    const key = realpathSync(directory), store = new ThumbnailStore(key), load = store.load();
    if (load.kind === 'ok') return this.open(key);
    if (load.kind === 'broken') throw new ThumbnailBrokenError(load.preservedFile);
    const preserved = store.brokenFiles();
    if (preserved.length) throw new ThumbnailBrokenError(preserved.at(-1)!);
    this.createDocument(key, store, executionId);
    return this.open(key);
  }
  recover(directory: string, choice: 'backup' | 'new', executionId: string): ThumbnailSessionState {
    const key = realpathSync(directory), store = new ThumbnailStore(key);
    if (store.load().kind === 'ok') return this.open(key);
    if (choice === 'backup') store.recoverFromBackup(executionId); else this.createDocument(key, store, executionId);
    this.sessions.delete(key); this.notify(key, { type: 'change' });
    return this.open(key);
  }
  private createDocument(key: string, store: ThumbnailStore, executionId: string): void {
    const video = new SequenceStore(key).load();
    if (!video) throw new SequenceError('MISSING_TARGET', '先に動画の編集を始めてください（新形式の編集データがありません）');
    const document = emptyThumbnailDocument(`thumbnail-${randomUUID()}`, thumbnailCanvasFor(video.document.resolution), `page-${randomUUID()}`);
    store.save({ expectedSavedRevision: null, executionId, document });
    this.sessions.delete(key); this.notify(key, { type: 'change' });
  }
  open(directory: string): ThumbnailSessionState {
    const key = realpathSync(directory), load = new ThumbnailStore(key).load();
    if (load.kind === 'missing') throw new SequenceError('MISSING_TARGET', 'サムネの編集データがありません');
    if (load.kind === 'broken') throw new ThumbnailBrokenError(load.preservedFile);
    let current = this.sessions.get(key);
    if (current && (current.saved.savedRevision !== load.saved.savedRevision || current.saved.contentHash !== load.saved.contentHash)) {
      // 未保存の編集は捨てない。外部の変更は inspect で知らせる。
      if (current.session.document.revision !== current.saved.savedRevision) return this.inspect(key, current.session.id);
      current = undefined;
    }
    if (!current) {
      current = { session: new ThumbnailSession(randomUUID(), load.saved.document), saved: load.saved, saves: new Map() };
      this.sessions.set(key, current);
    }
    return this.state(current);
  }
  inspect(directory: string, sessionId: string): ThumbnailSessionState {
    const key = realpathSync(directory), current = this.current(key, sessionId), state = this.state(current), load = new ThumbnailStore(key).load();
    if (load.kind === 'ok' && (load.saved.savedRevision !== current.saved.savedRevision || load.saved.contentHash !== current.saved.contentHash))
      state.externalChange = { savedRevision: load.saved.savedRevision, contentHash: load.saved.contentHash };
    return state;
  }
  reload(directory: string, sessionId: string, expectedRevision: number): ThumbnailSessionState {
    const key = realpathSync(directory), current = this.current(key, sessionId);
    if (current.session.document.revision !== expectedRevision) changed('読み直そうとした編集版が変わっています');
    this.sessions.delete(key);
    const next = this.open(key);
    this.notify(key, { type: 'change' });
    return next;
  }
  discard(directory: string, sessionId: string, expectedRevision: number): ThumbnailSessionState { return this.reload(directory, sessionId, expectedRevision); }
  execute(directory: string, request: ThumbnailEditRequest): ThumbnailSessionState & { executionId: string; appliedRevision: number; changed: boolean; replayed: boolean } {
    const key = realpathSync(directory), open = this.current(key, request.sessionId), receipt = open.session.execute(request);
    if (receipt.changed) this.notify(key, { type: 'change' });
    return { ...this.state(open), executionId: receipt.executionId, appliedRevision: receipt.appliedRevision, changed: receipt.changed, replayed: receipt.replayed };
  }
  save(directory: string, request: ThumbnailSaveRequest): ThumbnailSessionState & { replayed: boolean } {
    const key = realpathSync(directory), open = this.current(key, request.sessionId), store = new ThumbnailStore(key);
    const previous = open.saves.get(request.executionId);
    if (previous) {
      if (previous.input.expectedRevision !== request.expectedRevision || previous.input.expectedSavedRevision !== request.expectedSavedRevision) changed('同じ保存IDに異なる要求があります');
      const saved = store.save(previous!.snapshot);
      open.saved = saved; this.notify(key, { type: 'change' });
      return { ...this.state(open), replayed: saved.replayed };
    }
    const document = open.session.document;
    if (request.expectedRevision !== document.revision) changed('保存しようとした編集版が変更されています');
    const disk = store.load();
    if (disk.kind !== 'ok' || disk.saved.savedRevision !== open.saved.savedRevision || disk.saved.contentHash !== open.saved.contentHash) {
      // 退避が成功してからセッションを捨てる。失敗したら編集内容をメモリに残す。
      const dirty = document.revision !== open.saved.savedRevision, evacuated = dirty ? store.evacuate(document) : '';
      this.sessions.delete(key); this.notify(key, { type: 'change' });
      if (!dirty) changed('保存済みのサムネが別の場所で変わりました。読み直してください');
      throw new ThumbnailConflictError(`保存済みのサムネが別の場所で変わっていました。未保存の内容を .harness/${evacuated} に退避しました。読み直します`, evacuated);
    }
    const snapshot: SaveThumbnailRequest = { expectedSavedRevision: request.expectedSavedRevision, executionId: request.executionId, document };
    const saved = store.save(snapshot);
    open.saves.set(request.executionId, { input: { ...request }, snapshot });
    while (open.saves.size > 64) open.saves.delete(open.saves.keys().next().value!);
    open.saved = saved; this.notify(key, { type: 'change' });
    return { ...this.state(open), replayed: saved.replayed };
  }
  findAsset(directory: string, assetId: string): SequenceAsset | undefined {
    const key = realpathSync(directory), fromSession = this.sessions.get(key)?.session.document.assets.find(asset => asset.id === assetId);
    if (fromSession) return fromSession;
    const load = new ThumbnailStore(key).load();
    return load.kind === 'ok' ? load.saved.document.assets.find(asset => asset.id === assetId) : undefined;
  }
  private current(key: string, sessionId: string): OpenThumbnail {
    const open = this.sessions.get(key);
    if (!open || open.session.id !== sessionId) return changed('サムネの編集セッションが変わりました。読み直してください');
    return open;
  }
  private state(open: OpenThumbnail): ThumbnailSessionState {
    const document = open.session.document;
    return { sessionId: open.session.id, document, savedRevision: open.saved.savedRevision, savedContentHash: open.saved.contentHash,
      canUndo: open.session.canUndo, canRedo: open.session.canRedo, dirty: document.revision !== open.saved.savedRevision,
      pageHashes: Object.fromEntries(document.pages.map(page => [page.id, thumbnailPageHash(document, page.id)])) };
  }
}
/** ブラウザの操作と書き出し・縮小画像が共有する。 */
export const thumbnailService = new ThumbnailService();
