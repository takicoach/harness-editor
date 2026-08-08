import { spawn as nodeSpawn } from 'node:child_process';
import { renameSync } from 'node:fs';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { LoudnormMeasured } from './buildNormalizeArgs';

/** SSE イベントのフェーズ（denoise の preparing→denoising→finalizing を測定/適用の2段に拡張）。 */
export type NormalizeJobPhase =
  | 'preparing'
  | 'measuring'
  | 'normalizing'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface NormalizeJobEvent {
  phase: NormalizeJobPhase;
  error?: { code: string; message: string };
}

export interface NormalizeJob {
  projectId: string;
  startedAt: number;
  phase: NormalizeJobPhase;
  error?: { code: string; message: string };
}

export interface FakeProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill(signal: NodeJS.Signals | number): boolean;
}

export interface NormalizeSpawnOptions {
  ffmpeg: string;
  ffmpegArgs: string[];
  cwd?: string;
}

export interface StartNormalizeOptions {
  ffmpeg: string;
  /** 1パス目（測定）の引数。 */
  measureArgs: string[];
  /** 測定 stderr から実測値を取り出す（parseLoudnormJson を注入）。 */
  parseMeasured: (stderr: string) => LoudnormMeasured | null;
  /** 実測値（null=フォールバック）から2パス目（適用）の引数を作る。 */
  buildApplyArgs: (measured: LoudnormMeasured | null) => string[];
  /** 一時出力（適用の出力先）。成功後 finalOutput へ atomic rename。 */
  tmpOutput: string;
  /** 最終出力（メイン動画）。 */
  finalOutput: string;
  cwd?: string;
}

export interface NormalizeJobManagerDeps {
  spawn: (opts: NormalizeSpawnOptions) => FakeProcess;
  rename: (src: string, dest: string) => void;
}

const defaultDeps: NormalizeJobManagerDeps = {
  spawn: ({ ffmpeg, ffmpegArgs, cwd }) =>
    nodeSpawn(ffmpeg, ffmpegArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as FakeProcess,
  rename: renameSync,
};

/**
 * SME_NORMALIZE_MOCK=1 用の mock deps。実 ffmpeg を起動せず delayMs 後に成功する。
 * spawn は測定・適用の2回呼ばれるが、各回 setTimeout→exit(0) で成功させる。
 * 測定 stderr は空＝parseMeasured が null を返し動的フォールバックで適用される。
 */
export function createMockNormalizeDeps(delayMs = 3000): NormalizeJobManagerDeps {
  return {
    spawn: () => {
      const em = new EventEmitter() as FakeProcess;
      em.stdout = new Readable({ read() {} });
      em.stderr = new Readable({ read() {} });
      em.kill = () => { setImmediate(() => em.emit('exit', 1)); return true; };
      setTimeout(() => {
        em.stdout.push('progress\n');
        setImmediate(() => em.emit('exit', 0));
      }, delayMs);
      return em;
    },
    rename: () => { /* no-op in mock */ },
  };
}

/**
 * 音量正規化ジョブ（2パス）を管理する。projectId ごとに 1 本のみ。
 */
export class NormalizeJobManager {
  private jobs = new Map<string, NormalizeJob>();
  private procs = new Map<string, FakeProcess>();
  private subs = new Map<string, Set<(ev: NormalizeJobEvent) => void>>();
  private opts = new Map<string, StartNormalizeOptions>();
  private measuredStderr = new Map<string, string>();

  constructor(private deps: NormalizeJobManagerDeps = defaultDeps) {}

  exists(projectId: string): boolean { return this.jobs.has(projectId); }
  get(projectId: string): NormalizeJob | undefined { return this.jobs.get(projectId); }
  /** 実行中ジョブ数（重ジョブ負荷ゲート用）。 */
  activeCount(): number { return this.jobs.size; }

  start(projectId: string, opts: StartNormalizeOptions): NormalizeJob {
    if (this.jobs.has(projectId)) throw new Error('already-running');
    const job: NormalizeJob = { projectId, startedAt: Date.now(), phase: 'preparing' };
    this.jobs.set(projectId, job);
    this.opts.set(projectId, opts);
    this.measuredStderr.set(projectId, '');
    this.spawnMeasure(projectId, opts);
    return job;
  }

  // ── 1パス目: 測定 ──────────────────────────────────────────────
  private spawnMeasure(projectId: string, opts: StartNormalizeOptions): void {
    const proc = this.deps.spawn({ ffmpeg: opts.ffmpeg, ffmpegArgs: opts.measureArgs, cwd: opts.cwd });
    this.procs.set(projectId, proc);
    proc.stdout.on('data', () => this.onMeasureData(projectId));
    proc.stderr.on('data', (d: Buffer | string) => {
      this.onMeasureData(projectId);
      this.measuredStderr.set(projectId, (this.measuredStderr.get(projectId) ?? '') + String(d));
    });
    proc.on('exit', (code: number | null) => this.onMeasureExit(projectId, code));
    proc.on('error', (err: Error) => this.onSpawnError(projectId, err));
  }

  private onMeasureData(projectId: string): void {
    const job = this.jobs.get(projectId);
    if (!job || job.phase !== 'preparing') return;
    job.phase = 'measuring';
    this.emit(projectId, { phase: 'measuring' });
  }

  private onMeasureExit(projectId: string, code: number | null): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    if (code !== 0) {
      this.fail(projectId, { code: 'ffmpeg-error', message: `音量測定が終了コード ${code ?? 'null'} で失敗しました` });
      return;
    }
    const opts = this.opts.get(projectId)!;
    const measured = opts.parseMeasured(this.measuredStderr.get(projectId) ?? '');
    this.spawnApply(projectId, opts, opts.buildApplyArgs(measured));
  }

  // ── 2パス目: 適用 ──────────────────────────────────────────────
  private spawnApply(projectId: string, opts: StartNormalizeOptions, applyArgs: string[]): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    job.phase = 'normalizing';
    this.emit(projectId, { phase: 'normalizing' });
    const proc = this.deps.spawn({ ffmpeg: opts.ffmpeg, ffmpegArgs: applyArgs, cwd: opts.cwd });
    this.procs.set(projectId, proc); // cancel 用に最新 proc へ差し替え
    // 実 spawn のパイプ詰まり防止: ffmpeg の stdout/stderr を drain する
    // （リスナーが無いと OS パイプバッファ満杯で ffmpeg が write ブロック→ハング）。
    // 測定パス spawnMeasure と対称。
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});
    proc.on('exit', (code: number | null) => this.onApplyExit(projectId, code));
    proc.on('error', (err: Error) => this.onSpawnError(projectId, err));
  }

  private onApplyExit(projectId: string, code: number | null): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    if (code !== 0) {
      this.fail(projectId, { code: 'ffmpeg-error', message: `音量調整が終了コード ${code ?? 'null'} で失敗しました` });
      return;
    }
    job.phase = 'finalizing';
    this.emit(projectId, { phase: 'finalizing' });
    const opts = this.opts.get(projectId)!;
    try {
      this.deps.rename(opts.tmpOutput, opts.finalOutput);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.fail(projectId, { code: 'rename-failed', message: `一時ファイルの差し替えに失敗しました: ${msg}` });
      return;
    }
    job.phase = 'done';
    this.emit(projectId, { phase: 'done' });
    this.cleanup(projectId);
  }

  private onSpawnError(projectId: string, err: Error): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    const error = {
      code: 'ffmpeg-spawn-failed',
      message:
        `ffmpeg を起動できませんでした（${err.message}）。` +
        'ffmpeg をインストールするか、HARNESS_FFMPEG に実行ファイルのパスを設定してください。',
    };
    job.phase = 'failed';
    job.error = error;
    this.emit(projectId, { phase: 'failed', error });
    // SSE が観測するまでジョブを保持（cleanup しない）。
  }

  /** 失敗を発行して cleanup する（測定/適用の exit!=0・rename 失敗）。 */
  private fail(projectId: string, error: { code: string; message: string }): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    job.phase = 'failed';
    job.error = error;
    this.emit(projectId, { phase: 'failed', error });
    this.cleanup(projectId);
  }

  subscribe(projectId: string, fn: (ev: NormalizeJobEvent) => void): () => void {
    let set = this.subs.get(projectId);
    if (!set) { set = new Set(); this.subs.set(projectId, set); }
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
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  discard(projectId: string): void { this.cleanup(projectId); }

  private emit(projectId: string, ev: NormalizeJobEvent): void {
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
    this.opts.delete(projectId);
    this.measuredStderr.delete(projectId);
  }
}
