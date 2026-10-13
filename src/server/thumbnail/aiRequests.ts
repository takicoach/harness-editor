import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ThumbnailAiRequest } from '../../shared/thumbnailAi';

interface StoredLog { format: 'harness-thumbnail-ai-requests'; version: 1; requests: ThumbnailAiRequest[] }
const LIMIT = 100;
const empty = (): StoredLog => ({ format: 'harness-thumbnail-ai-requests', version: 1, requests: [] });

/** サムネの依頼の記録（<案件>/.harness/thumbnail-ai.requests.v1.json）。書き込みの範囲と確定の結果を持つ。文書の保存とは別。 */
export class ThumbnailAiRequestStore {
  readonly file: string;
  constructor(projectDirectory: string) { this.file = join(realpathSync(projectDirectory), '.harness', 'thumbnail-ai.requests.v1.json'); }
  private read(): StoredLog {
    if (!existsSync(this.file)) return empty();
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredLog> | null;
      if (!value || value.format !== 'harness-thumbnail-ai-requests' || value.version !== 1 || !Array.isArray(value.requests)) throw new Error('形式が不正です');
      return { format: 'harness-thumbnail-ai-requests', version: 1, requests: value.requests };
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
  all(): ThumbnailAiRequest[] { return this.read().requests; }
  get(requestId: string): ThumbnailAiRequest | undefined { return this.read().requests.find(item => item.requestId === requestId); }
  latest(): ThumbnailAiRequest | undefined { return this.read().requests.at(-1); }
  put(request: ThumbnailAiRequest): void {
    const log = this.read();
    log.requests = [...log.requests.filter(item => item.requestId !== request.requestId), request].slice(-LIMIT);
    this.write(log);
  }
  /** 読み直してから変える（描画を待つ間にほかの道具が書いた内容を消さないため）。 */
  update(requestId: string, change: (request: ThumbnailAiRequest) => ThumbnailAiRequest): ThumbnailAiRequest {
    const log = this.read(), index = log.requests.findIndex(item => item.requestId === requestId);
    if (index < 0) throw new Error('依頼の記録がありません');
    const next = change(structuredClone(log.requests[index]!));
    log.requests[index] = next;
    this.write(log);
    return next;
  }
}
