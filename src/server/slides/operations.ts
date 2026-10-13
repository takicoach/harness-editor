import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SlideIssue } from '../../core/slides/contract';

export type SlidesRoute = 'mcp' | 'paste';
export type SlidesTool = 'apply-outline' | 'apply-pages' | 'cancel';
export interface SlidesPageOutcome { key: string | null; index: number; result: 'applied' | 'proposal' | 'rejected' | 'failed'; attempts: number; issues: SlideIssue[]; notes: string[] }
export interface SlidesOperationResult {
  operationId: string; tool: SlidesTool; route: SlidesRoute; status: 'applied' | 'partial' | 'rejected'; replayed: boolean; runId: string | null;
  revision: number; savedRevision: number; issues: SlideIssue[]; pages: SlidesPageOutcome[]; at: string;
}
interface StoredOperation { operationId: string; requestHash: string; result: SlidesOperationResult }
interface StoredLog { format: 'harness-slides-operations'; version: 1; operations: StoredOperation[]; attempts: Record<string, number> }
const LIMIT = 200;
const empty = (): StoredLog => ({ format: 'harness-slides-operations', version: 1, operations: [], attempts: {} });

/** AI の操作の記録（操作 ID による重複防止・結果照会・ページごとの修復回数）。<スライド>/.harness/slides.operations.v1.json。文書の保存とは別。 */
export class SlidesOperationLog {
  readonly file: string;
  constructor(projectDirectory: string) { this.file = join(realpathSync(projectDirectory), '.harness', 'slides.operations.v1.json'); }
  private read(): StoredLog {
    if (!existsSync(this.file)) return empty();
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredLog> | null;
      if (!value || value.format !== 'harness-slides-operations' || value.version !== 1 || !Array.isArray(value.operations)
        || !value.attempts || typeof value.attempts !== 'object' || Array.isArray(value.attempts)) throw new Error('形式が不正です');
      return { format: 'harness-slides-operations', version: 1, operations: value.operations, attempts: value.attempts };
    } catch {
      // 壊れた記録は消さずに残し、新しく始める（文書は無傷）。
      renameSync(this.file, `${this.file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      return empty();
    }
  }
  private write(log: StoredLog): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(log) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, this.file); } catch (error) { try { unlinkSync(temporary); } catch { /* 無視 */ } throw error; }
  }
  find(operationId: string): StoredOperation | undefined { return this.read().operations.find(item => item.operationId === operationId); }
  attempts(runId: string, key: string): number { return this.read().attempts[`${runId}:${key}`] ?? 0; }
  record(entry: StoredOperation, attempts: Record<string, number>): void {
    const log = this.read();
    log.operations = [...log.operations.filter(item => item.operationId !== entry.operationId), entry].slice(-LIMIT);
    log.attempts = { ...log.attempts, ...attempts };
    this.write(log);
  }
  /** 新しい順。 */
  list(filter: { runId?: string }, offset: number, limit: number): { items: SlidesOperationResult[]; nextOffset: number | null } {
    const items = this.read().operations.map(item => item.result).filter(result => !filter.runId || result.runId === filter.runId).reverse();
    return { items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null };
  }
}
