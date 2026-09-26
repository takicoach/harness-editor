import type { ComponentType } from 'react';

/** テロップ部品の React コンポーネント型。segment の中身はプロジェクト側の TelopSegment。 */
export type TelopComponent = ComponentType<{ segment: unknown }>;

/** 動的 import したモジュールから Telop コンポーネントを検証して取り出す。 */
export function pickTelopExport(mod: Record<string, unknown>): TelopComponent {
  const telop = mod.Telop;
  if (typeof telop !== 'function') {
    throw new Error('テロップ部品 (Telop) を読み込めませんでした。対象プロジェクトに src/テロップテンプレート/Telop.tsx の Telop export がありません。');
  }
  return telop as TelopComponent;
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
  return 'テロップ部品を読み込めませんでした';
}

/**
 * Native swatches compile against our audited frame API. Inspect failed responses
 * before importing the Blob so project TSX errors retain their concrete message.
 * The mainframe import map supplies React and @harness/frame-runtime to the module.
 */
export async function loadNativeTelopComponent(projectId: string, signal?: AbortSignal): Promise<TelopComponent> {
  return loadTelopUrl(`/api/native-telop-component?id=${encodeURIComponent(projectId)}`, signal);
}

async function loadTelopUrl(url: string, signal?: AbortSignal): Promise<TelopComponent> {
  const res = await fetch(url, signal ? { signal } : undefined);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(buildErrorMessage(text));
  }
  const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  try {
    const mod = (await import(/* @vite-ignore */ blobUrl)) as Record<string, unknown>;
    return pickTelopExport(mod);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
