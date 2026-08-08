import type { ComponentType } from 'react';

/** 挿入画像部品の React コンポーネント型。segment の中身はプロジェクト側の ImageSegment。 */
export type InsertImageComponent = ComponentType<{ segment: unknown }>;

/** 動的 import したモジュールから InsertImage コンポーネントを検証して取り出す。 */
export function pickInsertImageExport(mod: Record<string, unknown>): InsertImageComponent {
  const insertImage = mod.InsertImage;
  if (typeof insertImage !== 'function') {
    throw new Error(
      '挿入画像部品 (InsertImage) を読み込めませんでした。対象プロジェクトに src/InsertImage/InsertImage.tsx の InsertImage export がありません。',
    );
  }
  return insertImage as InsertImageComponent;
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
    // JSON でなければ既定メッセージへフォールバック。
  }
  return '挿入画像部品を読み込めませんでした';
}

/**
 * サーバがバンドルした対象プロジェクトの挿入画像部品を動的 import する。
 * Telop と同じく Blob URL 経由で import map を効かせる。
 */
export async function loadInsertImageComponent(
  projectId: string,
): Promise<InsertImageComponent> {
  const url = `/api/insert-image-component?id=${encodeURIComponent(projectId)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(buildErrorMessage(text));
  }
  const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  try {
    const mod = (await import(/* @vite-ignore */ blobUrl)) as Record<string, unknown>;
    return pickInsertImageExport(mod);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
