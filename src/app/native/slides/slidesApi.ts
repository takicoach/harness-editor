import type { SequenceAsset } from '../../../core/sequence/model';
import type { SlidesExportStatus } from '../../../server/slides/exports';
import type { SlidesProjectSummary } from '../../../server/slides/projects';
import type { SlidesFileStatus, SlidesSessionState } from '../../../server/slides/service';
import { NativeApiError } from '../api';

export type { SlidesExportStatus, SlidesFileStatus, SlidesProjectSummary, SlidesSessionState };
export class SlidesApiError extends NativeApiError {
  constructor(message: string, status: number, code?: string, readonly evacuatedFile?: string, readonly preservedFile?: string, readonly recovery?: string) { super(message, status, code); }
}
const query = (projectId: string, params?: Record<string, string>) => new URLSearchParams({ ...params, id: projectId });
async function parse<T>(response: Response, fallback: string): Promise<T> {
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new SlidesApiError(typeof result.error === 'string' ? result.error : fallback, response.status,
    typeof result.code === 'string' ? result.code : undefined, typeof result.evacuatedFile === 'string' ? result.evacuatedFile : undefined,
    typeof result.preservedFile === 'string' ? result.preservedFile : undefined, typeof result.recovery === 'string' ? result.recovery : undefined);
  return result as T;
}
/** スライド専用の通信（/api/slides）。動画の nativeRequest・サムネの thumbnailRequest とは別。 */
export async function slidesRequest<T>(projectId: string, route: string, body?: unknown, params?: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/slides${route}?${query(projectId, params)}`, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal });
  return parse<T>(response, 'スライドの処理に失敗しました');
}
export async function uploadSlidesImage(projectId: string, file: File): Promise<SequenceAsset> {
  const response = await fetch(`/api/slides/upload?${query(projectId, { name: file.name })}`, { method: 'POST', body: file });
  return (await parse<{ asset: SequenceAsset }>(response, '画像を取り込めません')).asset;
}
const isSlidesSummary = (value: unknown): value is SlidesProjectSummary => {
  const item = value as Partial<SlidesProjectSummary> | null;
  return !!item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.pages === 'number' && (item.status === 'ok' || item.status === 'broken');
};
/** スライド案件の一覧（形の合わないものは捨てる）。 */
export async function listSlides(signal?: AbortSignal): Promise<SlidesProjectSummary[]> {
  const { projects } = await parse<{ projects: unknown }>(await fetch('/api/slides/projects', { signal }), 'スライドの一覧を取得できません');
  return Array.isArray(projects) ? projects.filter(isSlidesSummary) : [];
}
export async function createSlides(name: string): Promise<{ id: string }> {
  return parse<{ id: string }>(await fetch('/api/slides/projects/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }), 'スライドを作れません');
}
export const slidesAssetUrl = (projectId: string, assetId: string) => `/api/slides/asset?${query(projectId, { asset: assetId })}`;
export const slidesPreviewUrl = (projectId: string, pageId: string, hash: string) => `/api/slides/preview/image?${query(projectId, { pageId, hash })}`;
export const slidesExportFileUrl = (projectId: string, executionId: string, index: number) => `/api/slides/export/file?${query(projectId, { executionId, index: String(index) })}`;
