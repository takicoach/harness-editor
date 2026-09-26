import { applySequenceCommand, type SequenceCommand } from './commands';
import { SequenceError } from './errors';
import type { SequenceDocument } from './model';
import { parseSequence, serializeSequence } from './validate';

export interface EditRequest {
  sessionId: string;
  expectedRevision: number;
  /** Stable across transport retries. A new edit must use a new ID. */
  executionId: string;
  command: SequenceCommand | { type: 'undo' } | { type: 'redo' };
}
export interface EditReceipt {
  executionId: string;
  appliedRevision: number;
  changed: boolean;
  replayed: boolean;
  document: SequenceDocument;
}

/** A session owns immutable snapshots. Saving is independent of the undo cursor. */
export class SequenceSession {
  private current: SequenceDocument;
  private undoStack: SequenceDocument[] = [];
  private redoStack: SequenceDocument[] = [];
  private executions = new Map<string, { request: string; revision: number; changed: boolean }>();

  constructor(readonly id: string, document: SequenceDocument, private readonly historyLimit = 100) {
    if (!id || !Number.isSafeInteger(historyLimit) || historyLimit < 1) throw new Error('Invalid sequence session');
    this.current = parseSequence(serializeSequence(document));
  }
  get document(): SequenceDocument { return structuredClone(this.current); }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  execute(request: EditRequest): EditReceipt {
    if (request.sessionId !== this.id || !request.executionId) {
      throw new SequenceError('REVISION_CONFLICT', '別の編集セッションへの操作です');
    }
    const key = stableRequest(request);
    const previous = this.executions.get(request.executionId);
    if (previous) {
      if (previous.request !== key) throw new SequenceError('REVISION_CONFLICT', '同じ実行IDに異なる編集内容があります');
      return { executionId: request.executionId, appliedRevision: previous.revision, changed: previous.changed, replayed: true, document: this.document };
    }
    if (request.expectedRevision !== this.current.revision) {
      throw new SequenceError('REVISION_CONFLICT', '編集内容が更新されています。現在の内容を確認してください');
    }
    let next: SequenceDocument;
    if (request.command.type === 'undo' || request.command.type === 'redo') {
      const source = request.command.type === 'undo' ? this.undoStack : this.redoStack;
      const destination = request.command.type === 'undo' ? this.redoStack : this.undoStack;
      const snapshot = source.at(-1);
      if (snapshot) {
        next = parseSequence(serializeSequence({ ...snapshot, revision: this.current.revision + 1 }));
        source.pop(); destination.push(this.current);
      } else next = this.current;
    } else {
      next = applySequenceCommand(this.current, request.command);
      if (next !== this.current) {
        this.undoStack.push(this.current);
        if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
        this.redoStack = [];
      }
    }
    const changed = next !== this.current;
    this.current = next;
    this.executions.set(request.executionId, { request: key, revision: next.revision, changed });
    return { executionId: request.executionId, appliedRevision: next.revision, changed, replayed: false, document: this.document };
  }
}

function stableRequest(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableRequest).join(',') + ']';
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).filter(key => object[key] !== undefined).sort()
    .map(key => JSON.stringify(key) + ':' + stableRequest(object[key])).join(',') + '}';
}
