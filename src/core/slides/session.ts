import { SequenceError } from '../sequence/errors';
import { applySlideCommand, type SlideCommand, type SlideHistoryCommand } from './commands';
import type { SlideDocument } from './model';
import { parseSlides, serializeSlides } from './validate';

export interface SlideEditRequest { sessionId: string; expectedRevision: number; executionId: string; command: SlideCommand | SlideHistoryCommand }
export interface SlideEditReceipt { executionId: string; appliedRevision: number; changed: boolean; replayed: boolean; document: SlideDocument }

function conflict(message: string): never { throw new SequenceError('REVISION_CONFLICT', message); }
function stableRequest(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableRequest).join(',') + ']';
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + stableRequest(object[key])).join(',') + '}';
}

/** スライドの編集の権威（ページをまたいで 1 本の Undo）。動画の SequenceSession・サムネの ThumbnailSession とは別物。 */
export class SlideSession {
  private current: SlideDocument;
  private undoStack: SlideDocument[] = [];
  private redoStack: SlideDocument[] = [];
  private executions = new Map<string, { request: string; revision: number; changed: boolean }>();

  constructor(readonly id: string, document: SlideDocument, private readonly historyLimit = 100) {
    if (!id || !Number.isSafeInteger(historyLimit) || historyLimit < 1) throw new Error('Invalid slides session');
    this.current = parseSlides(serializeSlides(document));
  }
  get document(): SlideDocument { return structuredClone(this.current); }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  hasExecution(executionId: string): boolean { return this.executions.has(executionId); }

  execute(request: SlideEditRequest): SlideEditReceipt {
    if (request.sessionId !== this.id || typeof request.executionId !== 'string' || !request.executionId) conflict('別の編集セッションへの操作です');
    const key = stableRequest(request), previous = this.executions.get(request.executionId);
    if (previous) {
      if (previous.request !== key) conflict('同じ実行IDに異なる編集内容があります');
      return { executionId: request.executionId, appliedRevision: previous.revision, changed: previous.changed, replayed: true, document: this.document };
    }
    if (request.expectedRevision !== this.current.revision) conflict('編集内容が更新されています。現在の内容を確認してください');
    // 次の文書を先に作って検証する。失敗したらスタックも実行記録も触らない。
    let next: SlideDocument, commit = () => {};
    if (request.command.type === 'undo' || request.command.type === 'redo') {
      const source = request.command.type === 'undo' ? this.undoStack : this.redoStack;
      const destination = request.command.type === 'undo' ? this.redoStack : this.undoStack;
      const snapshot = source.at(-1);
      if (snapshot) {
        next = parseSlides(serializeSlides({ ...snapshot, revision: this.current.revision + 1 }));
        const replaced = this.current;
        commit = () => { source.pop(); destination.push(replaced); };
      } else next = this.current;
    } else {
      next = applySlideCommand(this.current, request.command);
      if (next !== this.current) {
        const replaced = this.current;
        commit = () => { this.undoStack.push(replaced); if (this.undoStack.length > this.historyLimit) this.undoStack.shift(); this.redoStack = []; };
      }
    }
    commit();
    const changed = next !== this.current;
    this.current = next;
    this.executions.set(request.executionId, { request: key, revision: next.revision, changed });
    while (this.executions.size > 512) this.executions.delete(this.executions.keys().next().value!);
    return { executionId: request.executionId, appliedRevision: next.revision, changed, replayed: false, document: this.document };
  }
}
