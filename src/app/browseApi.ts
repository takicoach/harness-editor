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
export async function browseFolder(path?: string): Promise<BrowseListing> {
  const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`;
  return fetchJson<BrowseListing>(`/api/browse${query}`);
}

/** 外部実体へのリンクで新規プロジェクトを作る（実体はコピーしない）。 */
export async function createProjectLinkRequest(name: string, path: string): Promise<{ id: string }> {
  return putJsonPost<{ id: string }>(
    `/api/create-project-link?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`,
    {},
  );
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
