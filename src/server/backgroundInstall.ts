// src/server/backgroundInstall.ts — 新規プロジェクト作成後にバックグラウンドで npm install を走らせる。
// createProject のレスポンスはブロックしない（fire-and-forget）。
// renderJob.ts の「node_modules が無ければ install」の前例を、プロジェクト作成直後にも適用する。
// 失敗しても致命的ではない（実際に npm run dev / render するときに再度 install されるため、
// ここではログに残す程度でよい）。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnCommand, type FakeProcess, type SpawnCommandOptions } from './spawnShell';
import { NPM_INSTALL_ARGS } from './installArgs';

export interface BackgroundInstallDeps {
  existsSync: (path: string) => boolean;
  spawn: (opts: SpawnCommandOptions) => FakeProcess;
  log: (msg: string) => void;
  logError: (msg: string) => void;
}

const defaultDeps: BackgroundInstallDeps = {
  existsSync,
  spawn: spawnCommand,
  log: (msg) => console.log(msg),
  logError: (msg) => console.error(msg),
};

/** projectDir ごとに install 進行中かどうかを追跡（多重起動の抑止）。 */
const installingDirs = new Set<string>();

/**
 * projectDir に node_modules が無ければバックグラウンドで npm install を開始する。
 * 呼び出し元をブロックしない・例外を投げない（致命的でないため）。
 * 既に install 中、または node_modules が既にある場合は何もしない。
 */
export function triggerBackgroundInstall(
  projectDir: string,
  deps: Partial<BackgroundInstallDeps> = {},
): void {
  const d = { ...defaultDeps, ...deps };

  // e2e ではプロジェクトを何度も作る。実 npm install が並列に走るとマシンが飽和し、
  // 無関係なテストがタイムアウトするため、テスト時だけ止められるようにする。
  if (process.env.SME_NO_BACKGROUND_INSTALL === '1') return;
  if (installingDirs.has(projectDir)) return;
  if (d.existsSync(join(projectDir, 'node_modules'))) return;

  installingDirs.add(projectDir);

  // POSIX の detached 子プロセスは unref しないと親プロセス（サーバ）のイベント
  // ループを掴んだままになりうる。fire-and-forget のバックグラウンド install は
  // 完了を待つ必要がないため、起動できたら直ちに unref する。
  let proc: FakeProcess;
  try {
    proc = d.spawn({ command: 'npm', args: [...NPM_INSTALL_ARGS], cwd: projectDir });
  } catch (err) {
    installingDirs.delete(projectDir);
    const msg = err instanceof Error ? err.message : String(err);
    d.logError(`[backgroundInstall] npm install の起動に失敗しました（${projectDir}）: ${msg}`);
    return;
  }

  proc.unref?.();

  // stdout/stderr は drain 必須（listener を必ず付ける。忘れると長尺ハングの事故がある）。
  proc.stdout.on('data', () => { /* drain */ });
  proc.stderr.on('data', () => { /* drain */ });

  proc.on('error', (err: Error) => {
    installingDirs.delete(projectDir);
    d.logError(`[backgroundInstall] npm install でエラーが発生しました（${projectDir}）: ${err.message}`);
  });

  proc.on('exit', (code: number | null) => {
    installingDirs.delete(projectDir);
    if (code === 0) {
      d.log(`[backgroundInstall] npm install 完了: ${projectDir}`);
    } else {
      d.logError(`[backgroundInstall] npm install が終了コード ${code ?? 'null'} で終了しました: ${projectDir}`);
    }
  });
}
