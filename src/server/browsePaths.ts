import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { HttpError } from './http';
import { VIDEO_EXTENSIONS } from '../shared/videoExtensions';
import { CREATE_MEDIA_EXTENSIONS } from '../shared/createMedia';
/** 「フォルダから選ぶ」（media=all）の拡張子。作成で受け付ける集合と同じ正本を使う（設計 M5）。 */
export const BROWSE_MEDIA_EXTENSIONS=CREATE_MEDIA_EXTENSIONS;

/**
 * 外付けストレージ等の動画を symlink で取り込むための「フォルダ走査」。
 *
 * ブラウザの file input は選んだファイルの絶対パスを渡さないため、サーバ側に
 * 限定的なファイラを持つ。任意のパスを列挙できる API にはせず、**起点（roots）配下だけ**を
 * 許可する。起点外への脱出は realpath 解決後の封じ込め判定で潰す。
 */

/** 走査の起点。UI の切り替えタブに 1:1 で対応する。 */
export interface BrowseRoot {
  key: string;
  label: string;
  path: string;
}

/** 1 フォルダあたりの返却上限。巨大フォルダで UI とサーバを詰まらせない。 */
export const MAX_BROWSE_ENTRIES = 2000;

/**
 * 走査の起点を解決する。
 *
 * 既定は macOS 想定（/Volumes ＝外付け、ホームの主要フォルダ）。SME_BROWSE_ROOTS で
 * 差し替えられる（区切りは OS の path.delimiter。Windows のドライブ文字と衝突する
 * `:` 固定にはしない）。存在しない起点は落とす（外付け未接続なら黙って消える）。
 */
export function browseRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  exists: (p: string) => boolean = (p) => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  },
): BrowseRoot[] {
  const override = env.SME_BROWSE_ROOTS?.trim();
  const candidates: BrowseRoot[] = override
    ? override.split(delimiter).filter((p) => p !== '').map((p) => ({
        key: p,
        label: basename(p) || p,
        path: resolve(p),
      }))
    : [
        { key: 'volumes', label: '外付け', path: '/Volumes' },
        { key: 'desktop', label: 'デスクトップ', path: join(home, 'Desktop') },
        { key: 'downloads', label: 'ダウンロード', path: join(home, 'Downloads') },
        { key: 'movies', label: 'ムービー', path: join(home, 'Movies') },
      ];
  return candidates.filter((r) => exists(r.path));
}

/** path がちょうど root か root 配下に収まるかを文字列で判定する。 */
function isContained(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * 走査・取り込みの対象として許可されたパスかを検証し、realpath を返す。
 *
 * 起点そのものと、その配下だけを許可する。判定は realpath 解決後に行うため、
 * `..` でも「起点内から外を指す symlink」でも脱出できない。
 */
export function assertBrowsablePath(
  path: string,
  roots: BrowseRoot[] = browseRoots(),
  realpath: (p: string) => string = realpathSync,
): string {
  if (!isAbsolute(path)) {
    throw new HttpError(400, `絶対パスを指定してください: ${path}`);
  }
  let real: string;
  try {
    real = realpath(resolve(path));
  } catch {
    throw new HttpError(404, `見つかりません: ${path}`);
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpath(root.path);
    } catch {
      continue;
    }
    if (isContained(real, realRoot)) return real;
  }
  throw new HttpError(403, `この場所は選べません（外付け・デスクトップ・ダウンロード・ムービーの中から選んでください）: ${path}`);
}

/** フォルダ 1 階層の中身。 */
export interface BrowseListing {
  roots: BrowseRoot[];
  /** 表示中のフォルダ（realpath）。起点一覧を返す時は null。 */
  path: string | null;
  /** 一つ上のフォルダ。起点そのもの・起点一覧では null。 */
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
  files: Array<{ name: string; path: string; sizeBytes: number }>;
  /** MAX_BROWSE_ENTRIES で打ち切ったら true。 */
  truncated: boolean;
}

/** 一つ上のフォルダ。起点そのものなら null（起点の外へは上がれない）。 */
export function parentOf(dir: string, roots: BrowseRoot[], realpath: (p: string) => string = realpathSync): string | null {
  for (const root of roots) {
    try {
      if (realpath(root.path) === dir) return null;
    } catch {
      // 解決できない起点は無視
    }
  }
  const up = dirname(dir);
  return up === dir ? null : up;
}

/**
 * フォルダの中身を返す。サブフォルダと動画ファイルのみ。
 * 隠しファイルは除外、個々の stat 失敗（権限・未マウント）はその項目だけ捨てる
 * （一覧全体を落とさない）。件数は MAX_BROWSE_ENTRIES で打ち切る。
 */
export function listDirectory(
  dir: string,
  roots: BrowseRoot[] = browseRoots(),
  deps: {
    readdir?: (p: string) => string[];
    stat?: (p: string) => { isDirectory(): boolean; isFile(): boolean; size: number };
    realpath?: (p: string) => string;
    extensions?: readonly string[];
  } = {},
): BrowseListing {
  const readdir = deps.readdir ?? ((p: string) => readdirSync(p));
  const stat = deps.stat ?? ((p: string) => statSync(p));
  const realpath = deps.realpath ?? realpathSync;

  let entries: string[];
  try {
    entries = readdir(dir);
  } catch {
    throw new HttpError(404, `フォルダを開けませんでした（未接続か、権限がありません）: ${dir}`);
  }
  const dirs: BrowseListing['dirs'] = [];
  const files: BrowseListing['files'] = [];
  let truncated = false;
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (dirs.length + files.length >= MAX_BROWSE_ENTRIES) {
      truncated = true;
      break;
    }
    const full = join(dir, name);
    let st: { isDirectory(): boolean; isFile(): boolean; size: number };
    try {
      st = stat(full);
    } catch {
      continue; // 切れたリンク・権限なし・未マウントは飛ばす
    }
    if (st.isDirectory()) {
      dirs.push({ name, path: full });
    } else if (st.isFile() && (deps.extensions??VIDEO_EXTENSIONS).includes(extname(name).toLowerCase())) {
      files.push({ name, path: full, sizeBytes: st.size });
    }
  }
  const collator = new Intl.Collator('ja');
  dirs.sort((a, b) => collator.compare(a.name, b.name));
  files.sort((a, b) => collator.compare(a.name, b.name));
  return { roots, path: dir, parent: parentOf(dir, roots, realpath), dirs, files, truncated };
}

/**
 * この環境でシンボリックリンクを作れるかの事前診断。
 * Windows（Developer Mode 無効）や一部のファイルシステムでは作れないため、
 * 取り込み前に判定して理由を返す。
 */
export function canCreateSymlink(
  probe: () => void,
): { ok: true } | { ok: false; message: string } {
  try {
    probe();
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `この環境ではリンクを作れませんでした（${detail}）。「パソコンから選ぶ」でコピー取り込みしてください`,
    };
  }
}

/** 切れたリンクか（lstat では在るが stat が失敗する）を判定する。 */
export function isBrokenLink(
  path: string,
  deps: { lstat?: (p: string) => unknown; stat?: (p: string) => unknown } = {},
): boolean {
  const lstat = deps.lstat ?? ((p: string) => lstatSync(p));
  const stat = deps.stat ?? ((p: string) => statSync(p));
  try {
    lstat(path);
  } catch {
    return false; // そもそも何も無い＝「動画未配置」であってリンク切れではない
  }
  try {
    stat(path);
    return false;
  } catch {
    return true;
  }
}
