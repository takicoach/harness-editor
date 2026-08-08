import { spawn as nodeSpawn } from 'node:child_process';
import { renameSync } from 'node:fs';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

/** SSE イベントのフェーズ。 */
export type DenoiseJobPhase =
  | 'preparing'
  | 'denoising'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'cancelled';

/** SSE で流すイベント。 */
export interface DenoiseJobEvent {
  phase: DenoiseJobPhase;
  error?: { code: string; message: string };
}

/** ジョブの内部状態。 */
export interface DenoiseJob {
  projectId: string;
  startedAt: number;
  phase: DenoiseJobPhase;
  error?: { code: string; message: string };
}

/** テスト容易性のため最小 subset に絞ったプロセスインターフェース。 */
export interface FakeProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill(signal: NodeJS.Signals | number): boolean;
}

export interface DenoiseSpawnOptions {
  /** ffmpeg 実行ファイル（パスまたは名前）。 */
  ffmpeg: string;
  /** ffmpeg に渡す引数配列（buildDenoiseArgs の出力）。 */
  ffmpegArgs: string[];
  cwd?: string;
}

export interface StartDenoiseOptions {
  ffmpeg: string;
  ffmpegArgs: string[];
  /** 一時出力パス。成功後に finalOutput へ atomic rename する。 */
  tmpOutput: string;
  /** 最終出力パス（main.mp4 等）。 */
  finalOutput: string;
  cwd?: string;
}

export interface DenoiseJobManagerDeps {
  /** child_process.spawn の代替（テストで差し替え可能）。 */
  spawn: (opts: DenoiseSpawnOptions) => FakeProcess;
  /** fs.renameSync の代替（テストで差し替え可能）。 */
  rename: (src: string, dest: string) => void;
}

const defaultDeps: DenoiseJobManagerDeps = {
  spawn: ({ ffmpeg, ffmpegArgs, cwd }) =>
    nodeSpawn(ffmpeg, ffmpegArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as FakeProcess,
  rename: renameSync,
};

/**
 * SME_DENOISE_MOCK=1 時に使う mock deps を生成する。
 * 実 ffmpeg を起動せず、delayMs 後に成功完了をシミュレートする。
 * rename は finalOutput を self-copy（= no-op）で代替する。
 */
export function createMockDenoiseDeps(delayMs = 3000): DenoiseJobManagerDeps {
  return {
    spawn: () => {
      const em = new EventEmitter() as FakeProcess;
      em.stdout = new Readable({ read() {} });
      em.stderr = new Readable({ read() {} });
      em.kill = () => {
        // キャンセル時: exit イベントを非 0 で発行してクリーンアップを促す
        setImmediate(() => em.emit('exit', 1));
        return true;
      };
      // delayMs 後に stdout へデータを流し（denoising フェーズ遷移）、その直後に exit(0)
      setTimeout(() => {
        em.stdout.push('progress\n');
        setImmediate(() => em.emit('exit', 0));
      }, delayMs);
      return em;
    },
    // tmpOutput は実在しないため self-copy は不要。finalOutput はすでに存在するのでそのまま。
    rename: (_src: string, _dest: string) => { /* no-op in mock mode */ },
  };
}

/**
 * ノイズ除去ジョブを管理する。
 * transcribeJob.ts の TranscribeJobManager と同じ構造を持つ。
 *
 * 排他制御: projectId ごとに 1 本のみ実行可能。
 */
export class DenoiseJobManager {
  private jobs = new Map<string, DenoiseJob>();
  private procs = new Map<string, FakeProcess>();
  private subs = new Map<string, Set<(ev: DenoiseJobEvent) => void>>();
  private tmpOutputs = new Map<string, string>();
  private finalOutputs = new Map<string, string>();

  constructor(private deps: DenoiseJobManagerDeps = defaultDeps) {}

  exists(projectId: string): boolean {
    return this.jobs.has(projectId);
  }

  get(projectId: string): DenoiseJob | undefined {
    return this.jobs.get(projectId);
  }

  /** 実行中ジョブ数（重ジョブ負荷ゲート用）。 */
  activeCount(): number {
    return this.jobs.size;
  }

  start(projectId: string, opts: StartDenoiseOptions): DenoiseJob {
    if (this.jobs.has(projectId)) {
      throw new Error('already-running');
    }
    const job: DenoiseJob = {
      projectId,
      startedAt: Date.now(),
      phase: 'preparing',
    };
    this.jobs.set(projectId, job);
    this.tmpOutputs.set(projectId, opts.tmpOutput);
    this.finalOutputs.set(projectId, opts.finalOutput);

    const proc = this.deps.spawn({
      ffmpeg: opts.ffmpeg,
      ffmpegArgs: opts.ffmpegArgs,
      cwd: opts.cwd,
    });
    this.procs.set(projectId, proc);

    // ffmpeg の進捗は stderr に出るが、stdout も受け取る。
    // stdout に何か来た時点で処理開始（denoising）と判断する。
    proc.stdout.on('data', () => this.onFirstData(projectId));
    proc.stderr.on('data', () => this.onFirstData(projectId));

    proc.on('exit', (code: number | null) => this.onExit(projectId, code));
    proc.on('error', (err: Error) => this.onSpawnError(projectId, err));

    return job;
  }

  /** 最初の出力データで denoising フェーズへ移行（べき等）。 */
  private onFirstData(projectId: string): void {
    const job = this.jobs.get(projectId);
    if (!job || job.phase !== 'preparing') return;
    job.phase = 'denoising';
    this.emit(projectId, { phase: 'denoising' });
  }

  subscribe(projectId: string, fn: (ev: DenoiseJobEvent) => void): () => void {
    let set = this.subs.get(projectId);
    if (!set) {
      set = new Set();
      this.subs.set(projectId, set);
    }
    set.add(fn);
    const ref = set;
    return () => ref.delete(fn);
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

  killAll(): void {
    for (const id of [...this.jobs.keys()]) {
      this.cancel(id);
    }
  }

  /** 終了済みジョブを破棄する（SSE が terminal snapshot を観測した後に呼ぶ）。 */
  discard(projectId: string): void {
    this.cleanup(projectId);
  }

  private onExit(projectId: string, code: number | null): void {
    const job = this.jobs.get(projectId);
    if (!job) return;

    if (code === 0) {
      // finalizing: アトミック rename で tmpOutput → finalOutput へ差し替え
      job.phase = 'finalizing';
      this.emit(projectId, { phase: 'finalizing' });

      const tmp = this.tmpOutputs.get(projectId)!;
      const final = this.finalOutputs.get(projectId)!;
      try {
        this.deps.rename(tmp, final);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const ev: DenoiseJobEvent = {
          phase: 'failed',
          error: { code: 'rename-failed', message: `一時ファイルの差し替えに失敗しました: ${msg}` },
        };
        job.phase = 'failed';
        job.error = ev.error;
        this.emit(projectId, ev);
        this.cleanup(projectId);
        return;
      }

      job.phase = 'done';
      this.emit(projectId, { phase: 'done' });
      this.cleanup(projectId);
    } else {
      const ev: DenoiseJobEvent = {
        phase: 'failed',
        error: { code: 'ffmpeg-error', message: `ffmpeg が終了コード ${code ?? 'null'} で終了しました` },
      };
      job.phase = 'failed';
      job.error = ev.error;
      this.emit(projectId, ev);
      this.cleanup(projectId);
    }
  }

  private onSpawnError(projectId: string, err: Error): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    const ev: DenoiseJobEvent = {
      phase: 'failed',
      error: {
        code: 'ffmpeg-spawn-failed',
        message:
          `ffmpeg を起動できませんでした（${err.message}）。` +
          'ffmpeg をインストールするか、HARNESS_FFMPEG に実行ファイルのパスを設定してください。',
      },
    };
    job.phase = 'failed';
    job.error = ev.error;
    this.emit(projectId, ev);
    // transcribeJob と同様: SSE が観測するまでジョブを保持する
  }

  private emit(projectId: string, ev: DenoiseJobEvent): void {
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
    this.tmpOutputs.delete(projectId);
    this.finalOutputs.delete(projectId);
  }
}
