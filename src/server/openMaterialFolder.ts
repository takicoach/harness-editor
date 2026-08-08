import type { ServerResponse } from 'node:http';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sendJson } from './http';

/** 素材種別 → プロジェクト内の格納フォルダ（materialList.ts の assetDir と対応）。 */
const KIND_DIRS: Record<string, string> = {
  se: 'public/se',
  image: 'public/images',
  bgm: 'public/BGM',
  video: 'public',
};

/** 素材種別から絶対フォルダパスを解決する。未知の種別は null。 */
export function materialFolderFor(projectDir: string, kind: string): string | null {
  const rel = KIND_DIRS[kind];
  return rel === undefined ? null : join(projectDir, rel);
}

/**
 * OS のファイラーでフォルダを開く（revealInFinder のフォルダ版）。
 * fire-and-forget: エラーは握りつぶし、開発サーバを落とさない。
 */
export function openFolder(
  dir: string,
  platform: NodeJS.Platform,
  spawnFn: typeof nodeSpawn = nodeSpawn,
): void {
  const [command, args] =
    platform === 'darwin'
      ? (['open', [dir]] as const)
      : platform === 'win32'
        ? (['explorer', [dir]] as const)
        : (['xdg-open', [dir]] as const);
  const child = spawnFn(command, [...args], { stdio: 'ignore' });
  child.on('error', () => { /* ignore open failures */ });
  child.unref();
}

/**
 * POST /api/materials/open-folder?id=<projectId>&kind=<se|image|bgm|video>
 * 素材フォルダを Finder 等で開く。フォルダが無ければ作ってから開く
 * （空状態から「開いてドロップする」動線を成立させるため）。
 */
export function handleOpenMaterialFolder(
  res: ServerResponse,
  projectDir: string,
  kind: string,
): void {
  const dir = materialFolderFor(projectDir, kind);
  if (dir === null) {
    sendJson(res, 400, { error: `不明な素材種別です: ${kind}` });
    return;
  }
  mkdirSync(dir, { recursive: true });
  openFolder(dir, process.platform);
  sendJson(res, 200, { ok: true });
}
