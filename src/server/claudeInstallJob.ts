/**
 * claude のローカル導入ジョブ（エディタ全体で1本・排他）。
 * npm install --prefix <editorDir>/.claude-runtime @anthropic-ai/claude-code@<版固定>
 * グローバル導入はしない（sudo 不要・ロールバックはディレクトリ削除・版固定で検証済み動作を配る）。
 * 進捗はポーリング（/api/ai/install/status）で返す。
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { clearToolCache, managedRuntimeDir } from './aiToolBin';
import { AI_TOOLS } from './aiTools';
import { spawnCommand } from './spawnShell';

const CLAUDE_INSTALL = AI_TOOLS.claude.installPackage;
if (CLAUDE_INSTALL === null) throw new Error('claude アダプタに installPackage が必要です');
const INSTALL_SPEC = `${CLAUDE_INSTALL.name}@${CLAUDE_INSTALL.version}`;

export interface InstallStatus {
  phase: 'idle' | 'running' | 'done' | 'failed';
  /** stdout/stderr の末尾（最大 200 行）。必ず drain する（未 drain ハングは既知事故）。 */
  log: string[];
  error?: string;
}

const MAX_LOG_LINES = 200;

export interface InstallJobDeps {
  spawnImpl?: (dir: string) => ChildProcess;
  /**
   * defer #3: プロセスツリー全体（孫プロセスを含む）を kill する。renderJob.ts の
   * RenderJobManagerDeps.killGroup と同じ DI パターン（テストで差し替え可能）。
   * npm install は実際のダウンロード/展開等で孫プロセスを派生させるため、本体のみ
   * SIGTERM すると孤児化して残ることがある。POSIX はプロセスグループ kill、
   * Windows は taskkill /T。
   */
  killGroup?: (pid: number) => void;
}

/** 既定の killGroup（renderJob.ts の defaultDeps.killGroup と同じ実装）。 */
function defaultKillGroup(pid: number): void {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    process.kill(-pid, 'SIGTERM');
  }
}

export function createInstallJob(deps: InstallJobDeps = {}) {
  let child: ChildProcess | null = null;
  let status: InstallStatus = { phase: 'idle', log: [] };
  const killGroup = deps.killGroup ?? defaultKillGroup;

  function pushLog(chunk: Buffer | string): void {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line === '') continue;
      status.log.push(line);
      if (status.log.length > MAX_LOG_LINES) status.log.shift();
    }
  }

  function defaultSpawn(editorDir: string): ChildProcess {
    const prefix = managedRuntimeDir(editorDir);
    mkdirSync(prefix, { recursive: true });
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    // spawnShell.ts の spawnCommand を使う（renderJob.ts と同じ npm/npx spawn 経路）。
    // Windows は shell:true 経由＋cmd 予約文字 quote、POSIX は detached（＝プロセス
    // グループのリーダーになる）ため、defer #3 の killAll() がツリーごと kill できる。
    return spawnCommand({
      command: npm,
      args: ['install', '--prefix', prefix, '--no-fund', '--no-audit', INSTALL_SPEC],
    }) as unknown as ChildProcess;
  }

  /**
   * プロセス（と孫プロセス）を終了させる。pid が取得できる場合はツリーごと kill。
   * killGroup が失敗した場合（プロセスグループを持たない等）、または pid 不明の場合は
   * 本体プロセスのみ SIGTERM。renderJob.ts の killProcessTree と同じ構造。
   */
  function killProcessTree(proc: ChildProcess): void {
    if (proc.pid) {
      try {
        killGroup(proc.pid);
        return;
      } catch {
        // フォールバック: 本体プロセスのみ SIGTERM
      }
    }
    proc.kill();
  }

  return {
    start(editorDir: string): { ok: boolean; error?: string } {
      if (status.phase === 'running') return { ok: false, error: '導入は既に実行中です' };
      status = { phase: 'running', log: [] };
      try {
        child = (deps.spawnImpl ?? defaultSpawn)(editorDir);
      } catch (err) {
        status = { phase: 'failed', log: [], error: err instanceof Error ? err.message : String(err) };
        return { ok: false, error: status.error };
      }
      child.stdout?.on('data', pushLog);
      child.stderr?.on('data', pushLog);
      child.on('error', (err) => {
        status = { ...status, phase: 'failed', error: err.message };
        child = null;
        // 起動自体に失敗した場合も無条件でクリアする（下記 exit ハンドラと同じ理由）。
        clearToolCache();
      });
      child.on('exit', (code) => {
        status = code === 0
          ? { ...status, phase: 'done' }
          : { ...status, phase: 'failed', error: `npm install が終了コード ${code} で失敗しました` };
        child = null;
        // 導入完了で findTool/checkToolVersion のキャッシュ（TTL 5秒）を即座に無効化する。
        // これが無いと「導入したのに『入っていません』と出る」が TTL 満了まで再現する。
        // 失敗時（code !== 0）も無条件でクリアする — 途中で失敗した npm install が
        // .claude-runtime に部分的な成果物（壊れた bin 等）を残しうるため、
        // 「失敗なら何も変わっていない」は事実として成り立たない。
        clearToolCache();
      });
      return { ok: true };
    },
    status(): InstallStatus {
      return { ...status, log: [...status.log] };
    },
    killAll(): void {
      if (child) killProcessTree(child);
      child = null;
    },
  };
}

/** サーバ全体で共有するシングルトン。 */
export const claudeInstallJob = createInstallJob();
