import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { resolvePythonBin } from './resolvePython';

export type TranscribeJobPhase =
  | 'starting'
  | 'loading-model'
  | 'analyzing'
  | 'writing'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface TranscribeJobEvent {
  phase: TranscribeJobPhase;
  percent?: number;
  elapsedMs?: number;
  error?: { code: string; message: string };
}

export interface TranscribeJob {
  projectId: string;
  startedAt: number;
  phase: TranscribeJobPhase;
  percent?: number;
  error?: { code: string; message: string };
  backupPath: string | null;
}

/** テスト容易性のため、必要なメソッド/プロパティだけを subset したインターフェース。 */
export interface FakeProcess extends EventEmitter {
  stdout: Readable;
  kill(signal: NodeJS.Signals | number): boolean;
}

export interface SpawnOptions {
  scriptPath: string;
  args: string[];
  cwd?: string;
}

export interface JobsManagerDeps {
  /** child_process.spawn の代替（テストで差し替え可能）。 */
  spawn: (opts: SpawnOptions) => FakeProcess;
}

const defaultDeps: JobsManagerDeps = {
  spawn: ({ scriptPath, args, cwd }) =>
    // whisper が入っている Python を解決して使う（python3 固定だと別バージョンに
    // 入った whisper を見落とす。HARNESS_PYTHON（旧 SUPERMOVIE_PYTHON）で明示指定も可能）。
    nodeSpawn(resolvePythonBin(), [scriptPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as FakeProcess,
};

export class TranscribeJobManager {
  private jobs = new Map<string, TranscribeJob>();
  private procs = new Map<string, FakeProcess>();
  private subs = new Map<string, Set<(ev: TranscribeJobEvent) => void>>();
  private buffers = new Map<string, string>();

  constructor(private deps: JobsManagerDeps = defaultDeps) {}

  exists(projectId: string): boolean {
    return this.jobs.has(projectId);
  }

  get(projectId: string): TranscribeJob | undefined {
    return this.jobs.get(projectId);
  }

  /** 実行中ジョブ数（重ジョブ負荷ゲート用）。 */
  activeCount(): number {
    return this.jobs.size;
  }

  start(
    projectId: string,
    opts: { backupPath: string | null; spawnOpts?: SpawnOptions },
  ): TranscribeJob {
    if (this.jobs.has(projectId)) {
      throw new Error('already-running');
    }
    const job: TranscribeJob = {
      projectId,
      startedAt: Date.now(),
      phase: 'starting',
      backupPath: opts.backupPath,
    };
    this.jobs.set(projectId, job);
    const spawnOpts = opts.spawnOpts ?? { scriptPath: '', args: [] };
    const proc = this.deps.spawn(spawnOpts);
    this.procs.set(projectId, proc);
    this.buffers.set(projectId, '');
    proc.stdout.on('data', (chunk: Buffer) => this.onStdout(projectId, chunk));
    proc.on('exit', (code: number | null) => this.onExit(projectId, code));
    // spawn 失敗（Python 実行ファイルが無い／非実行＝stale な HARNESS_PYTHON / SUPERMOVIE_PYTHON や
    // .supermovie-python 等）は exit ではなく error として非同期に飛ぶ。listener が
    // 無いと unhandled error で Vite サーバごと落ちるため、failed ジョブへ変換する。
    proc.on('error', (err: Error) => this.onSpawnError(projectId, err));
    return job;
  }

  subscribe(projectId: string, fn: (ev: TranscribeJobEvent) => void): () => void {
    let set = this.subs.get(projectId);
    if (!set) {
      set = new Set();
      this.subs.set(projectId, set);
    }
    set.add(fn);
    const subs = set;
    return () => subs.delete(fn);
  }

  cancel(projectId: string): boolean {
    const proc = this.procs.get(projectId);
    const job = this.jobs.get(projectId);
    if (!job) return false;
    if (proc) proc.kill('SIGTERM');
    this.emit(projectId, { phase: 'cancelled' });
    this.cleanup(projectId);
    return true;
  }

  /** 全ジョブをキャンセル（サーバ shutdown 用）。 */
  killAll(): void {
    for (const id of [...this.jobs.keys()]) {
      this.cancel(id);
    }
  }

  private onStdout(projectId: string, chunk: Buffer): void {
    const prev = this.buffers.get(projectId) ?? '';
    const text = prev + chunk.toString('utf8');
    const lines = text.split('\n');
    const tail = lines.pop() ?? '';
    this.buffers.set(projectId, tail);
    const job = this.jobs.get(projectId);
    if (!job) return;
    for (const line of lines) {
      if (line.trim() === '') continue;
      let ev: TranscribeJobEvent;
      try {
        ev = JSON.parse(line) as TranscribeJobEvent;
      } catch {
        continue;
      }
      job.phase = ev.phase;
      if (ev.percent !== undefined) job.percent = ev.percent;
      if (ev.error) job.error = ev.error;
      this.emit(projectId, ev);
    }
  }

  private onSpawnError(projectId: string, err: Error): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    const ev: TranscribeJobEvent = {
      phase: 'failed',
      error: {
        code: 'python-spawn-failed',
        message:
          `Python を起動できませんでした（${err.message}）。` +
          'HARNESS_PYTHON（旧 SUPERMOVIE_PYTHON）/ .supermovie-python の指す Python が存在するか確認してください。',
      },
    };
    job.phase = 'failed';
    job.error = ev.error;
    this.emit(projectId, ev);
    // cleanup しない: spawn の error は POST が 200 を返した直後に非同期で飛ぶため、
    // ここで消すと client が SSE を購読する前に失敗 snapshot が消え、バナーが
    // 「実行中」のまま固まる。終了状態を保持し、SSE 接続時に discard させる。
  }

  /** 終了済みジョブを破棄する（SSE が terminal snapshot を観測した後に呼ぶ）。 */
  discard(projectId: string): void {
    this.cleanup(projectId);
  }

  private onExit(projectId: string, code: number | null): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    if (job.phase !== 'completed' && job.phase !== 'failed' && job.phase !== 'cancelled') {
      const ev: TranscribeJobEvent = {
        phase: 'failed',
        error: { code: 'unknown', message: `subprocess exit ${code}` },
      };
      job.phase = 'failed';
      job.error = ev.error;
      this.emit(projectId, ev);
    }
    this.cleanup(projectId);
  }

  private emit(projectId: string, ev: TranscribeJobEvent): void {
    const set = this.subs.get(projectId);
    if (!set) return;
    for (const fn of set) fn(ev);
  }

  /**
   * ジョブ終了時の状態クリア。**subs は消さない**（2026-07-23 I-1 修正・renderJob.ts の
   * cleanup コメント参照）: 複数接続が同一 projectId を subscribe している場合の
   * 再入バグ（片方の discard がもう片方の購読者まで巻き込んで消す）を防ぐ。
   * 購読解除は subscribe() が返す unsubscribe のみが行う。
   */
  private cleanup(projectId: string): void {
    this.jobs.delete(projectId);
    this.procs.delete(projectId);
    this.buffers.delete(projectId);
  }
}
