import { fetchJson, putJsonPost } from './fetchJson';

/** フォルダ走査の起点（外付け・デスクトップ等）。 */
export interface BrowseRoot {
  key: string;
  label: string;
  path: string;
}

/** フォルダ 1 階層の中身。 */
export interface BrowseListing {
  roots: BrowseRoot[];
  path: string | null;
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
  files: Array<{ name: string; path: string; sizeBytes: number }>;
  truncated: boolean;
}

/** フォルダの中身を取得する。path 省略で起点一覧。 */
export async function browseFolder(path?: string,media?:'all'): Promise<BrowseListing> {
  const params=new URLSearchParams({...path?{path}:{},...media?{media}:{}});
  const query=params.size?'?'+params:'';
  return fetchJson<BrowseListing>(`/api/browse${query}`);
}

/** 切れた（食い違った）リンクの接続先を選び直す。warnings が返ったら未適用。 */
export async function relinkRequest(
  id: string,
  path: string,
  force: boolean,
): Promise<{ target: string; warnings: string[] }> {
  return putJsonPost<{ target: string; warnings: string[] }>(
    `/api/relink?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}${force ? '&force=1' : ''}`,
    {},
  );
}
