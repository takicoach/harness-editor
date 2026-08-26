import { extractErrorMessage, fetchJson } from './fetchJson';
import type { AssetKind } from '../shared/assetKey';

/** サーバ trashStore.TrashEntry と同形（HTTP 契約）。 */
export interface TrashEntry {
  id: string;
  kind: string;
  name: string;
  originalPath: string;
  deletedAt: string;
}

export interface LibrariesPatch {
  seLibrary: string[];
  imageLibrary: string[];
  bgmLibrary: string[];
  videoLibrary: string[];
  assetVersions: Record<string, string>;
}

export type DeleteMaterialResult =
  | { ok: true; entry: TrashEntry; libraries: LibrariesPatch; usedCount: number | null }
  | { ok: false; code: 'in-use'; count: number }
  | { ok: false; code: 'scan-failed' };

/** 応答が想定形でないときの共通エラー（分割代入で undefined を撒く前に止める）。 */
function malformed(): Error {
  return new Error('サーバからの応答を解釈できませんでした');
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) throw malformed();
  return body as Record<string, unknown>;
}

/** 素材ライブラリのパッチ形状を検証して取り出す。欠けていれば null（パッチ無し）。 */
function readLibraries(b: Record<string, unknown>): LibrariesPatch | null {
  const keys = ['seLibrary', 'imageLibrary', 'bgmLibrary', 'videoLibrary'] as const;
  if (keys.every((k) => b[k] === undefined) && b['assetVersions'] === undefined) return null;
  for (const k of keys) {
    if (!Array.isArray(b[k]) || (b[k] as unknown[]).some((v) => typeof v !== 'string')) {
      throw malformed();
    }
  }
  const versions = b['assetVersions'];
  if (typeof versions !== 'object' || versions === null || Array.isArray(versions)) throw malformed();
  return {
    seLibrary: b['seLibrary'] as string[],
    imageLibrary: b['imageLibrary'] as string[],
    bgmLibrary: b['bgmLibrary'] as string[],
    videoLibrary: b['videoLibrary'] as string[],
    assetVersions: versions as Record<string, string>,
  };
}

/**
 * 素材をゴミ箱へ移動する。409 は例外にせず判別可能な結果として返す
 * （in-use は再確認ダイアログ、scan-failed は削除保留の通知に使う）。
 */
export async function deleteMaterialRequest(
  id: string,
  kind: AssetKind,
  file: string,
  force: boolean,
): Promise<DeleteMaterialResult> {
  const q =
    `id=${encodeURIComponent(id)}&kind=${encodeURIComponent(kind)}` +
    `&file=${encodeURIComponent(file)}${force ? '&force=1' : ''}`;
  const res = await fetch(`/api/material?${q}`, { method: 'DELETE' });
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 409 && typeof body === 'object' && body !== null) {
    const b = body as { error?: unknown; count?: unknown };
    if (b.error === 'in-use') {
      return { ok: false, code: 'in-use', count: typeof b.count === 'number' ? b.count : 0 };
    }
    if (b.error === 'scan-failed') return { ok: false, code: 'scan-failed' };
  }
  if (!res.ok) throw new Error(extractErrorMessage(body));
  const b = asRecord(body);
  const entry = b['entry'];
  if (typeof entry !== 'object' || entry === null) throw malformed();
  const libraries = readLibraries(b);
  if (libraries === null) throw malformed();
  const usedCount = b['usedCount'];
  return {
    ok: true,
    entry: entry as TrashEntry,
    libraries,
    usedCount: typeof usedCount === 'number' ? usedCount : null,
  };
}

/** ゴミ箱一覧。id=null はルート（プロジェクトのゴミ箱）。 */
export async function listTrashRequest(id: string | null): Promise<TrashEntry[]> {
  const q = id === null ? '' : `?id=${encodeURIComponent(id)}`;
  const body = await fetchJson<unknown>(`/api/trash${q}`);
  const entries = asRecord(body)['entries'];
  if (!Array.isArray(entries)) throw malformed();
  return entries as TrashEntry[];
}

async function postTrash(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(extractErrorMessage(body));
  return asRecord(body);
}

/** ゴミ箱操作の結果。libraries は素材ゴミ箱のときのみ載る（ルートは null）。 */
export interface RestoreResult {
  restoredPath: string;
  libraries: LibrariesPatch | null;
}
export interface EmptyResult {
  removed: number;
  libraries: LibrariesPatch | null;
}

export async function restoreTrashRequest(id: string | null, entryId: string): Promise<RestoreResult> {
  const b = await postTrash('/api/trash/restore', { ...(id === null ? {} : { id }), entryId });
  if (typeof b['restoredPath'] !== 'string') throw malformed();
  return { restoredPath: b['restoredPath'], libraries: readLibraries(b) };
}

/**
 * ゴミ箱の完全削除。entryId 省略は「全件」だが、暗黙にせず all:true をワイヤ上で明示する
 * （組み立てミス 1 箇所でゴミ箱が全部消える暗黙契約をやめる。サーバも空の body では全消ししない）。
 */
export async function emptyTrashRequest(id: string | null, entryId?: string): Promise<EmptyResult> {
  const b = await postTrash('/api/trash/empty', {
    ...(id === null ? {} : { id }),
    ...(entryId === undefined ? { all: true } : { entryId }),
  });
  if (typeof b['removed'] !== 'number') throw malformed();
  return { removed: b['removed'], libraries: readLibraries(b) };
}

/** プロジェクト本体をルートのゴミ箱へ移動する。 */
export async function deleteProjectRequest(id: string): Promise<TrashEntry> {
  const res = await fetch(`/api/project?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 409 && typeof body === 'object' && body !== null
    && (body as { error?: unknown }).error === 'busy') {
    // サーバは機械可読な 'busy' を返す。表示は日本語に置き換える。
    throw new Error('このプロジェクトで処理（書き出し・文字起こし・AI への指示など）が実行中です。終わってからもう一度お試しください');
  }
  if (!res.ok) throw new Error(extractErrorMessage(body));
  return (body as { entry: TrashEntry }).entry;
}
