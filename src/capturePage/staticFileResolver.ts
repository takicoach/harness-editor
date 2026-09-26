/**
 * 撮影ページの staticFile リゾルバ（M2b T2・設計判断3）。
 *
 * captureRuntime の staticFile はリゾルバ注入式で、正規化の責務は撮影ページ側にある
 * （src/captureRuntime/components.tsx の staticFile doc comment が契約の正本）。
 * ここでは real remotion の正規化を**同値に再実装**する
 * （根拠: node_modules/remotion/dist/cjs/static-file.js を読解。逐語コピーはしない。
 *  同値性は staticFileResolver.test.ts が real staticFile と直接比較して固定する）。
 *
 * real の staticFile がやっていること（読解結果）:
 *   1. null / undefined を TypeError で拒否
 *   2. http:// https:// で始まるリモート URL を TypeError で拒否
 *   3. '..' / './' で**始まる**相対パスを TypeError で拒否
 *      （'images/../b.png' のような途中の '..' は real も拒否しない — 実測で同値を確認）
 *   4. 絶対パス（/Users /home /tmp /etc /opt /var と C: D: E:）を TypeError で拒否
 *   5. 'public/' 接頭辞を TypeError で拒否
 *   6. '/' 区切りのセグメントごとに encodeURIComponent（'/' は素通し）
 *   7. 先頭スラッシュを全て落として '/' を1つ付け直す
 *
 * 未実装（意図的な差分）:
 * - すでに %エンコード済みに見えるパスへの console.warn（real の warnOnce）。値には影響しない。
 * - `window.remotion_staticBase` 分岐。撮影ページはこのグローバルを設定しないため到達しない。
 */
import { assetUrl } from '../app/panels/materialList';

/** real: `path.startsWith(...)` で拒否する絶対パスの接頭辞。 */
const ABSOLUTE_PREFIXES = ['/Users', '/home', '/tmp', '/etc', '/opt', '/var', 'C:', 'D:', 'E:'];

/** 先頭スラッシュを全て落とす（real の trimLeadingSlash 相当）。 */
function trimLeadingSlash(path: string): string {
  let i = 0;
  while (i < path.length && path[i] === '/') i += 1;
  return path.slice(i);
}

/** real の検証（拒否ルール）だけを適用し、public/ 相対の**生**パスを返す。 */
function assertAndTrim(path: string): string {
  if (path === null) {
    throw new TypeError('null was passed to staticFile()');
  }
  if (typeof path === 'undefined') {
    throw new TypeError('undefined was passed to staticFile()');
  }
  if (path.startsWith('http://') || path.startsWith('https://')) {
    throw new TypeError(
      `staticFile() はリモート URL を扱えません（受け取った値: "${path}"）。URL は staticFile() に通さずそのまま使ってください。`,
    );
  }
  if (path.startsWith('..') || path.startsWith('./')) {
    throw new TypeError(
      `staticFile() は相対パスを扱えません（受け取った値: "${path}"）。public/ フォルダ内のパスを渡してください。`,
    );
  }
  if (ABSOLUTE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new TypeError(
      `staticFile() は絶対パスを扱えません（受け取った値: "${path}"）。public/ フォルダ内のパスを渡してください。`,
    );
  }
  if (path.startsWith('public/')) {
    throw new TypeError(
      `staticFile() には public/ 接頭辞を付けないでください（受け取った値: "${path}"）。`,
    );
  }
  return trimLeadingSlash(path);
}

/**
 * real remotion の staticFile と同値の正規化結果（セグメント単位で符号化された URL パス）。
 * 撮影ページ自体はこの文字列をそのまま使わないが、「real と同値であること」を実測で
 * 固定できる形にしておくためのエクスポート（同値の正本）。
 */
export function normalizeStaticFilePath(path: string): string {
  const trimmed = assertAndTrim(path);
  const encoded = trimmed.split('/').map(encodeURIComponent).join('/');
  return `/${encoded}`;
}

/**
 * projectId を固定した staticFile リゾルバを作る。解決先は既存の `/api/asset` 規約
 * （`?id=<projectId>&path=<public 相対パス>`・src/app/panels/materialList.ts の assetUrl と同形式）。
 *
 * 符号化について: real の staticFile は「URL のパス位置」に置くためセグメント単位で
 * encodeURIComponent する。`/api/asset` はパスを**クエリ値**として受け取り、サーバは
 * URLSearchParams で1回デコードした生パスをファイル名として解決する。したがって
 * 正しい符号化は「生パスを1回だけ encodeURIComponent する」であり、real のセグメント
 * 符号化をそのまま query に載せると二重符号化になる（"a b.png" が "a%20b.png" という
 * 名前のファイルとして探されてしまう）。検証ルールと先頭スラッシュ除去は real と同値のまま、
 * 符号化だけを解決先の規約に合わせる。
 */
export function createAssetResolver(projectId: string): (path: string) => string {
  return (path: string): string => {
    const publicRelative = assertAndTrim(path);
    return assetUrl(projectId, publicRelative);
  };
}
