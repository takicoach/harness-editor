import { existsSync, realpathSync } from 'node:fs';
import { realpath as realpathAsync } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { HttpError } from './http';
import { UnresponsiveFileError, unresponsiveReadMessage, watchedFs } from './sequence/fsWatch';

/** プロジェクト探索のルートディレクトリ。HARNESS_PROJECT_ROOT（旧 SME_PROJECT_ROOT）環境変数、無ければ cwd。 */
export function getProjectRoot(): string {
  return resolve(process.env.HARNESS_PROJECT_ROOT ?? process.env.SME_PROJECT_ROOT ?? process.cwd());
}

/** path がちょうど root か root 配下に収まるかを文字列で判定する。 */
export function isContained(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * クライアントから来たプロジェクト ID を実ディレクトリへ解決する。
 * トラバーサル防御 2 段:
 *  1. 正規化パスがルート配下か（文字列封じ込め）。
 *  2. シンボリックリンク実体（realpathSync）がルート配下か。
 *     ルート配下に外を指すリンクがあっても脱出を防ぐ。
 * 解決対象が存在しない場合は 1 のみで判定する（存在しないものは書き込み前に別途検出される）。
 */
export function resolveProjectDir(root: string, id: string): string {
  const normalizedRoot = resolve(root);
  const dir = resolve(normalizedRoot, id);
  if (!isContained(dir, normalizedRoot)) {
    throw new HttpError(400, `不正なプロジェクトパスです: ${id}`);
  }
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    // 実体が無い（未作成）。文字列封じ込めは通過済みなので dir を返す。
    return dir;
  }
  const realRoot = realpathSync(normalizedRoot);
  if (!isContained(real, realRoot)) {
    throw new HttpError(400, `不正なプロジェクトパスです: ${id}`);
  }
  return real;
}


/** 外付けの回転待ちより長く、利用者が固まったと感じる前に案内を返せる長さ（browsePaths.ts の確認と同じ）。 */
const PROJECT_DIR_UNRESPONSIVE_MS = 5000;

/**
 * resolveProjectDir と同じ判定を、サーバーを止めずに行う。応答しないドライブでは limitMs で待つのをやめて 503 で断る
 * （同期の realpathSync はその間すべての API を止める。2026-11-04 実測）。新しい経路はこちらを使う。
 */
export async function resolveProjectDirAsync(
  root: string,
  id: string,
  deps: { realpath?: (p: string) => Promise<string>; limitMs?: number } = {},
): Promise<string> {
  const normalizedRoot = resolve(root);
  const dir = resolve(normalizedRoot, id);
  if (!isContained(dir, normalizedRoot)) throw new HttpError(400, `不正なプロジェクトパスです: ${id}`);
  const check = deps.realpath ?? ((p: string) => realpathAsync(p));
  const limitMs = deps.limitMs ?? PROJECT_DIR_UNRESPONSIVE_MS;
  const real = async (path: string): Promise<string | null> => {
    try {
      return await watchedFs('realpath', path, () => check(path), { limitMs });
    } catch (error) {
      if (error instanceof UnresponsiveFileError) throw new HttpError(503, unresponsiveReadMessage(path));
      return null;
    }
  };
  const realDir = await real(dir);
  // 実体が無い（未作成）。文字列封じ込めは通過済みなので dir を返す。
  if (realDir === null) return dir;
  const realRoot = (await real(normalizedRoot)) ?? normalizedRoot;
  if (!isContained(realDir, realRoot)) throw new HttpError(400, `不正なプロジェクトパスです: ${id}`);
  return realDir;
}

/**
 * プロジェクトの public/ 配下のアセット相対パスを実パスへ解決する。
 * トラバーサル防御 2 段:
 *  1. 正規化パスが public/ 配下か（文字列封じ込め）。
 *  2. シンボリックリンク実体（realpathSync）が public/ 配下か。
 *     public/ 内から外を指すリンクがあっても脱出を防ぐ。
 * 存在しない場合は 404。public/ ディレクトリ自体が無いプロジェクトも 404 にする。
 */
export function resolvePublicAsset(projectDir: string, relPath: string): string {
  const publicDir = resolve(projectDir, 'public');
  const abs = resolve(publicDir, relPath);
  if (!isContained(abs, publicDir)) {
    throw new HttpError(400, `不正なアセットパスです: ${relPath}`);
  }
  if (!existsSync(abs)) {
    throw new HttpError(404, `アセットが見つかりません: public/${relPath}`);
  }
  // 実体（realpath）による封じ込め確認。public/ が存在する場合のみ実施。
  let realPublic: string;
  try {
    realPublic = realpathSync(publicDir);
  } catch {
    // public/ 自体が存在しない（existsSync(abs) が先に 404 を投げるが念のため）。
    throw new HttpError(404, `アセットが見つかりません: public/${relPath}`);
  }
  const realAbs = realpathSync(abs);
  if (!isContained(realAbs, realPublic)) {
    throw new HttpError(400, `不正なアセットパスです: ${relPath}`);
  }
  return realAbs;
}
