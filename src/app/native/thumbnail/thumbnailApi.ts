import type { SequenceAsset } from '../../../core/sequence/model';
import type { ThumbnailExportStatus } from '../../../server/thumbnail/exports';
import type { ThumbnailFileStatus, ThumbnailSessionState } from '../../../server/thumbnail/service';
import { NativeApiError } from '../api';

export type { ThumbnailExportStatus, ThumbnailFileStatus, ThumbnailSessionState };
export class ThumbnailApiError extends NativeApiError {
  constructor(message: string, status: number, code?: string, readonly evacuatedFile?: string, readonly preservedFile?: string) { super(message, status, code); }
}
/** サムネ専用の通信。動画の nativeRequest（/api/sequence）とは別。 */
export async function thumbnailRequest<T>(projectId: string, route: string, body?: unknown, params?: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/thumbnail${route}?${new URLSearchParams({ ...params, id: projectId })}`, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ThumbnailApiError(typeof result.error === 'string' ? result.error : 'サムネの処理に失敗しました', response.status,
    typeof result.code === 'string' ? result.code : undefined, typeof result.evacuatedFile === 'string' ? result.evacuatedFile : undefined,
    typeof result.preservedFile === 'string' ? result.preservedFile : undefined);
  return result as T;
}
export async function uploadThumbnailImage(projectId: string, file: File): Promise<SequenceAsset> {
  const response = await fetch(`/api/thumbnail/upload?${new URLSearchParams({ id: projectId, name: file.name })}`, { method: 'POST', body: file });
  const result = await response.json().catch(() => ({})) as { error?: string; asset?: SequenceAsset };
  if (!response.ok || !result.asset) throw new ThumbnailApiError(result.error ?? '画像を取り込めません', response.status);
  return result.asset;
}
export function thumbnailPreviewUrl(projectId: string, pageId: string, contentHash: string): string {
  return `/api/thumbnail/preview/image?${new URLSearchParams({ id: projectId, pageId, hash: contentHash })}`;
}
export function thumbnailExportFileUrl(projectId: string, executionId: string): string {
  return `/api/thumbnail/export/file?${new URLSearchParams({ id: projectId, executionId })}`;
}
/** 動画側の素材の原本（引き出しの見本とコマ選び用）。 */
export function sequenceAssetUrl(projectId: string, assetId: string): string {
  return `/api/sequence/asset?${new URLSearchParams({ id: projectId, asset: assetId })}`;
}
