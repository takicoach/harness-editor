import type { ComponentType } from 'react';

/** サブ動画部品の React コンポーネント型。segment の中身はプロジェクト側の VideoInsert。 */
export type InsertVideoComponent = ComponentType<{ segment: unknown }>;

/** 動的 import したモジュールから InsertVideo コンポーネントを検証して取り出す。 */
export function pickInsertVideoExport(mod: Record<string, unknown>): InsertVideoComponent {
  const insertVideo = mod.InsertVideo;
  if (typeof insertVideo !== 'function') {
    throw new Error(
      'サブ動画部品 (InsertVideo) を読み込めませんでした。対象プロジェクトに src/InsertVideo/InsertVideo.tsx の InsertVideo export がありません。',
    );
  }
  return insertVideo as InsertVideoComponent;
}

/** API のエラーレスポンス（{error} JSON）から日本語メッセージを取り出す。 */
function buildErrorMessage(rawBody: string): string {
  try {
    const body: unknown = JSON.parse(rawBody);
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const e = (body as { error: unknown }).error;
      if (typeof e === 'string' && e !== '') return e;
    }
  } catch {
    // フォールバック
  }
  return 'サブ動画部品を読み込めませんでした';
}

/**
 * サーバがバンドルした対象プロジェクトのサブ動画部品を動的 import する。
 * loadInsertImageComponent と同じく Blob URL 経由で import map を効かせる。
 */
export async function loadInsertVideoComponent(projectId: string): Promise<InsertVideoComponent> {
  const url = `/api/insert-video-component?id=${encodeURIComponent(projectId)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(buildErrorMessage(text));
  }
  const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  try {
    const mod = (await import(/* @vite-ignore */ blobUrl)) as Record<string, unknown>;
    return pickInsertVideoExport(mod);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
