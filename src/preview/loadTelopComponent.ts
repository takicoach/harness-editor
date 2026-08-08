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
 * サーバがバンドルした対象プロジェクトのテロップ部品を動的 import する。
 *
 * 先に fetch して応答を検査する。`Telop.tsx` のビルド失敗時、サーバは 500 + {error}
 * JSON を返すが、dynamic import() はその本文を見せず汎用エラーになってしまうため、
 * ここでサーバの具体的な日本語メッセージを拾って投げ直す。検証済みの JS は Blob URL
 * 経由で import する（import map は Blob モジュールの bare import にも効く）。
 */
export async function loadTelopComponent(projectId: string): Promise<TelopComponent> {
  const url = `/api/telop-component?id=${encodeURIComponent(projectId)}`;
  const res = await fetch(url);
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
