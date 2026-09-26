import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import type { LegacyPreviewCatalog, LegacyPreviewReferences } from '../../core/sequence/legacyPreview';
import { HttpError } from '../http';
import { assertLegacySequenceAuthority } from './authority';
import { prepareLegacyPreviewCatalog } from './migration';

/** These are project-relative names, never filesystem paths supplied to import. */
export function parseLegacyPreviewReferences(value: unknown): LegacyPreviewReferences {
  const invalid = () => new HttpError(400, 'プレビュー素材の指定が不正です');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(',') !== 'bgm,image,images,main,se,telop,videoInserts') throw invalid();
  const file = (name: unknown): string => {
    if (typeof name !== 'string' || name.length > 1024 || /[\\:\u0000]/.test(name)
      || name.split('/').some(part => !part || part === '.' || part === '..')) throw invalid();
    return name;
  };
  const items = (list: unknown): { id: number; file: string }[] => {
    if (!Array.isArray(list) || list.length > 10000) throw invalid();
    const ids = new Set<number>();
    return list.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'file,id'
        || !Number.isSafeInteger(item.id) || item.id < 0 || ids.has(item.id)) throw invalid();
      ids.add(item.id); return { id: item.id, file: file(item.file) };
    }).sort((a, b) => a.id - b.id);
  };
  if (typeof body.telop !== 'boolean' || typeof body.image !== 'boolean') throw invalid();
  const references = { main: file(body.main), telop: body.telop, image: body.image,
    images: items(body.images), videoInserts: items(body.videoInserts), bgm: items(body.bgm), se: items(body.se) };
  if (references.image !== (references.images.length > 0)) throw invalid();
  return references;
}

export interface LegacyPreviewContext { token: string; directory: string; catalog: LegacyPreviewCatalog; expiresAt: number; signal: AbortSignal }
interface OwnedContext extends LegacyPreviewContext { identity: string; controller: AbortController; timer?: ReturnType<typeof setTimeout> }
/** In-memory leases cannot become save authority or export jobs. Frozen managed
 * assets survive release; only this exact context's allowlist grants read access. */
export class LegacyPreviewContexts {
  private contexts = new Map<string, OwnedContext>();
  private preparing = 0;
  constructor(private readonly now = Date.now, private readonly ttlMs = 60 * 60 * 1000, private readonly capacity = 32) {}
  private identity(directory: string): string {
    try {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(404, '案件フォルダーが変更されています');
      return `${info.dev}:${info.ino}`;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new HttpError(404, '案件フォルダーが変更されています');
      throw error;
    }
  }
  private expire(): void { for (const context of this.contexts.values()) if (context.expiresAt <= this.now()) this.release(context.directory, context.token); }
  private touch(context: OwnedContext): void {
    context.expiresAt = this.now() + this.ttlMs;
    clearTimeout(context.timer);
    context.timer = setTimeout(() => this.release(context.directory, context.token), this.ttlMs);
    context.timer.unref();
  }
  async create(directory: string, references: LegacyPreviewReferences, signal?: AbortSignal): Promise<LegacyPreviewContext> {
    this.expire();
    if (this.contexts.size + this.preparing >= this.capacity) throw new HttpError(429, 'プレビューの準備が多すぎます。不要な編集画面を閉じてください');
    this.preparing++;
    try {
      const identity = this.identity(directory);
      const catalog = await prepareLegacyPreviewCatalog(directory, references, signal, undefined, true);
      signal?.throwIfAborted(); assertLegacySequenceAuthority(directory);
      if (this.identity(directory) !== identity) throw new HttpError(409, '素材の準備中に案件フォルダーが変更されました');
      const controller = new AbortController();
      const context: OwnedContext = { token: randomUUID(), directory, identity, catalog, expiresAt: 0, controller, signal: controller.signal };
      this.contexts.set(context.token, context); this.touch(context); return context;
    } finally { this.preparing--; }
  }
  get(directory: string, token: string): LegacyPreviewContext {
    this.expire();
    const context = this.contexts.get(token);
    if (!context || context.directory !== directory) throw new HttpError(404, 'プレビューの素材情報が失効しました。再読み込みしてください');
    try {
      if (this.identity(directory) !== context.identity) throw new HttpError(404, '案件フォルダーが変更されています');
      assertLegacySequenceAuthority(directory);
    } catch (error) { this.release(directory, token); throw error; }
    this.touch(context);
    return context;
  }
  release(directory: string, token: string): void {
    const context = this.contexts.get(token);
    if (context?.directory !== directory) return;
    this.contexts.delete(token); clearTimeout(context.timer);
    context.controller.abort(new HttpError(404, 'プレビューの素材情報が失効しました。再読み込みしてください'));
  }
}
export const legacyPreviewContexts = new LegacyPreviewContexts();
