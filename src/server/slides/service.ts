import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { SequenceError } from '../../core/sequence/errors';
import type { SequenceAsset } from '../../core/sequence/model';
import { sequenceContentBytes } from '../../core/sequence/validate';
import { emptySlideDocument, type SlideDocument } from '../../core/slides/model';
import { slidePageToSequence } from '../../core/slides/pageView';
import { SlideSession, type SlideEditRequest } from '../../core/slides/session';
import type { SaveDesignRequest, SavedDesign } from '../design/documentStore';
import { SlidesStore } from './store';

export type SlidesEvent = { type: 'change' } | { type: 'preview'; pageId: string; contentHash: string; error?: string } | { type: 'export'; executionId: string; phase: string };
export interface SlidesSessionState {
  sessionId: string; document: SlideDocument; savedRevision: number; savedContentHash: string; canUndo: boolean; canRedo: boolean; dirty: boolean;
  /** ページごとの描画内容の指紋。縮小画像と書き出しの照合に使う。 */
  pageHashes: Record<string, string>;
  externalChange?: { savedRevision: number; contentHash: string };
}
export type SlidesFileStatus = { status: 'saved'; savedRevision: number; contentHash: string } | { status: 'missing' | 'broken'; backupAvailable: boolean; preservedFiles: string[] };
export interface SlidesSaveRequest { sessionId: string; expectedRevision: number; expectedSavedRevision: number; executionId: string }
export class SlidesConflictError extends SequenceError {
  constructor(message: string, readonly evacuatedFile?: string) { super('REVISION_CONFLICT', message); this.name = 'SlidesConflictError'; }
}
export class SlidesBrokenError extends Error {
  constructor(readonly preservedFile: string) {
    super(`スライドの保存ファイルが壊れていたため ${preservedFile} として保全しました。控えから戻すか、新しく始めるかを選んでください`);
    this.name = 'SlidesBrokenError';
  }
}
interface OpenSlides { session: SlideSession; saved: SavedDesign<SlideDocument>; saves: Map<string, { input: SlidesSaveRequest; snapshot: SaveDesignRequest<SlideDocument> }> }
export function slidesPageHash(document: SlideDocument, pageId: string): string {
  return createHash('sha256').update(sequenceContentBytes(slidePageToSequence(document, pageId))).digest('hex');
}
function changed(message: string): never { throw new SequenceError('REVISION_CONFLICT', message); }

/** スライド案件ごとに 1 つの編集の権威。動画の SequenceService・サムネの ThumbnailService とは保存・Undo・通知が別。 */
export class SlidesService {
  private sessions = new Map<string, OpenSlides>();
  private listeners = new Map<string, Set<(event: SlidesEvent) => void>>();
  subscribe(directory: string, listener: (event: SlidesEvent) => void): () => void {
    const key = realpathSync(directory), listeners = this.listeners.get(key) ?? new Set<(event: SlidesEvent) => void>();
    listeners.add(listener); this.listeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key); };
  }
  notify(directory: string, event: SlidesEvent): void {
    for (const listener of this.listeners.get(realpathSync(directory)) ?? []) listener(event);
  }
  status(directory: string): SlidesFileStatus {
    const store = new SlidesStore(directory), load = store.load();
    if (load.kind === 'ok') return { status: 'saved', savedRevision: load.saved.savedRevision, contentHash: load.saved.contentHash };
    const preservedFiles = store.brokenFiles();
    return { status: preservedFiles.length ? 'broken' : 'missing', backupAvailable: store.hasBackup(), preservedFiles };
  }
  recover(directory: string, choice: 'backup' | 'new', executionId: string): SlidesSessionState {
    const key = realpathSync(directory), store = new SlidesStore(key);
    if (store.load().kind === 'ok') return this.open(key);
    if (choice === 'backup') store.recoverFromBackup(executionId);
    else store.save({ expectedSavedRevision: null, executionId, document: emptySlideDocument(`slides-${randomUUID()}`) });
    this.sessions.delete(key); this.notify(key, { type: 'change' });
    return this.open(key);
  }
  open(directory: string): SlidesSessionState {
    const key = realpathSync(directory), load = new SlidesStore(key).load();
    if (load.kind === 'missing') throw new SequenceError('MISSING_TARGET', 'スライドの編集データがありません');
    if (load.kind === 'broken') throw new SlidesBrokenError(load.preservedFile);
    let current = this.sessions.get(key);
    if (current && (current.saved.savedRevision !== load.saved.savedRevision || current.saved.contentHash !== load.saved.contentHash)) {
      // 未保存の編集は捨てない。外部の変更は inspect で知らせる。
      if (current.session.document.revision !== current.saved.savedRevision) return this.inspect(key, current.session.id);
      current = undefined;
    }
    if (!current) {
      current = { session: new SlideSession(randomUUID(), load.saved.document), saved: load.saved, saves: new Map() };
      this.sessions.set(key, current);
    }
    return this.state(current);
  }
  inspect(directory: string, sessionId: string): SlidesSessionState {
    const key = realpathSync(directory), current = this.current(key, sessionId), state = this.state(current), load = new SlidesStore(key).load();
    if (load.kind === 'ok' && (load.saved.savedRevision !== current.saved.savedRevision || load.saved.contentHash !== current.saved.contentHash))
      state.externalChange = { savedRevision: load.saved.savedRevision, contentHash: load.saved.contentHash };
    return state;
  }
  reload(directory: string, sessionId: string, expectedRevision: number): SlidesSessionState {
    const key = realpathSync(directory), current = this.current(key, sessionId);
    if (current.session.document.revision !== expectedRevision) changed('読み直そうとした編集版が変わっています');
    this.sessions.delete(key);
    const next = this.open(key);
    this.notify(key, { type: 'change' });
    return next;
  }
  discard(directory: string, sessionId: string, expectedRevision: number): SlidesSessionState { return this.reload(directory, sessionId, expectedRevision); }
  execute(directory: string, request: SlideEditRequest): SlidesSessionState & { executionId: string; appliedRevision: number; changed: boolean; replayed: boolean } {
    const key = realpathSync(directory), open = this.current(key, request.sessionId), receipt = open.session.execute(request);
    if (receipt.changed) this.notify(key, { type: 'change' });
    return { ...this.state(open), executionId: receipt.executionId, appliedRevision: receipt.appliedRevision, changed: receipt.changed, replayed: receipt.replayed };
  }
  save(directory: string, request: SlidesSaveRequest): SlidesSessionState & { replayed: boolean } {
    const key = realpathSync(directory), open = this.current(key, request.sessionId), store = new SlidesStore(key);
    const previous = open.saves.get(request.executionId);
    if (previous) {
      if (previous.input.expectedRevision !== request.expectedRevision || previous.input.expectedSavedRevision !== request.expectedSavedRevision) changed('同じ保存IDに異なる要求があります');
      const saved = store.save(previous.snapshot);
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
      if (!dirty) changed('保存済みのスライドが別の場所で変わりました。読み直してください');
      throw new SlidesConflictError(`保存済みのスライドが別の場所で変わっていました。未保存の内容を .harness/${evacuated} に退避しました。読み直します`, evacuated);
    }
    const snapshot: SaveDesignRequest<SlideDocument> = { expectedSavedRevision: request.expectedSavedRevision, executionId: request.executionId, document };
    const saved = store.save(snapshot);
    open.saves.set(request.executionId, { input: { ...request }, snapshot });
    while (open.saves.size > 64) open.saves.delete(open.saves.keys().next().value!);
    open.saved = saved; this.notify(key, { type: 'change' });
    return { ...this.state(open), replayed: saved.replayed };
  }
  /** AI の要求（生成の受け口だけが呼ぶ）。1 回の Undo で適用し、すぐ保存する（画面が開いていなくても失わない）。 */
  agentApply(directory: string, request: SlideEditRequest): SlidesSessionState & { appliedRevision: number; changed: boolean; replayed: boolean } {
    const applied = this.execute(directory, request);
    if (!applied.dirty) return applied;
    const saved = this.save(directory, { sessionId: request.sessionId, expectedRevision: applied.document.revision, expectedSavedRevision: applied.savedRevision,
      executionId: `${request.executionId}:save` });
    return { ...saved, appliedRevision: applied.appliedRevision, changed: applied.changed, replayed: applied.replayed };
  }
  findAsset(directory: string, assetId: string): SequenceAsset | undefined {
    const key = realpathSync(directory), fromSession = this.sessions.get(key)?.session.document.assets.find(asset => asset.id === assetId);
    if (fromSession) return fromSession;
    const load = new SlidesStore(key).load();
    return load.kind === 'ok' ? load.saved.document.assets.find(asset => asset.id === assetId) : undefined;
  }
  private current(key: string, sessionId: string): OpenSlides {
    const open = this.sessions.get(key);
    if (!open || open.session.id !== sessionId) return changed('スライドの編集セッションが変わりました。読み直してください');
    return open;
  }
  private state(open: OpenSlides): SlidesSessionState {
    const document = open.session.document;
    return { sessionId: open.session.id, document, savedRevision: open.saved.savedRevision, savedContentHash: open.saved.contentHash,
      canUndo: open.session.canUndo, canRedo: open.session.canRedo, dirty: document.revision !== open.saved.savedRevision,
      pageHashes: Object.fromEntries(document.pages.map(page => [page.id, slidesPageHash(document, page.id)])) };
  }
}
/** ブラウザの操作・AI の受け口・書き出し・縮小画像が共有する。 */
export const slidesService = new SlidesService();
