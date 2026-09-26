import { delimiter, sep } from 'node:path';

export interface PtyPathPlatform { platform: NodeJS.Platform; sep: string; delimiter: string }

/**
 * `platform.sep` を基準にした dirname。`node:path` の `dirname` はビルド先プラットフォームの
 * セパレータで posix/win32 の実装が固定される（macOS で動くこのプロセスでは常に posix 実装）ため、
 * テストが注入する win32 の `\` 区切りパスを渡しても分割できない。テストの platform 引数に
 * 忠実にするため、自前で最後の区切り文字までを切り出す。
 */
function dirOf(path: string, sepChar: string): string {
  const idx = path.lastIndexOf(sepChar);
  return idx === -1 ? '' : path.slice(0, idx);
}

/**
 * pty へ渡す PATH。採用した実行ファイルの親ディレクトリと node の bin を先頭へ前置する。
 * ランチャー経由でない起動（Finder/ダブルクリック）だと PATH に ~/.local/bin が無く、
 * AI 本体が呼ぶ子プロセス（node・npx・git）が見つからないため（設計 E・2026-09-16 の実測）。
 *
 * 前置するのは「採用した実行ファイルの親」であって既知の置き場の一覧ではない
 * （一覧を全部前置すると、ユーザーが普段使う版とは違う版の子プロセスを掴む・裁定 P1-6 の逆流）。
 * 重複は落として先頭へ引き上げる（単純追加だと起動のたびに PATH が伸びる）。
 */
export function buildPtyPath(
  basePath: string | undefined,
  toolFile: string,
  nodeExecPath: string,
  platform: PtyPathPlatform = { platform: process.platform, sep, delimiter },
): string {
  const insensitive = platform.platform === 'win32';
  const key = (value: string) => (insensitive ? value.toLowerCase() : value);
  const front = [dirOf(toolFile, platform.sep), dirOf(nodeExecPath, platform.sep)].filter((value) => value !== '' && value !== '.');
  const rest = (basePath ?? '').split(platform.delimiter).filter((value) => value !== '');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...front, ...rest]) {
    if (seen.has(key(entry))) continue;
    seen.add(key(entry));
    out.push(entry);
  }
  return out.join(platform.delimiter);
}
