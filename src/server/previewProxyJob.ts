import { spawn as nodeSpawn } from 'node:child_process';
import { renameSync, unlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

/**
 * プレビュー軽量化（preview proxy 生成）ジョブ。
 * NormalizeJobManager と同型の 1 パス版に、ffmpeg -progress からの percent 進捗を足したもの。
 * projectId ごとに 1 本のみ。完成後に尺一致を検証し、ズレていれば破棄して失敗にする。
 */

export type PreviewProxyPhase =
  | 'preparing'
  | 'converting'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface PreviewProxyEvent {
  phase: PreviewProxyPhase;
  /** converting 中のみ 0〜99。それ以外は undefined。 */
  percent?: number;
  error?: { code: string; message: string };
}

export interface PreviewProxyJob {
  projectId: string;
  startedAt: number;
  phase: PreviewProxyPhase;
  percent: number | null;
  error?: { code: string; message: string };
}

export interface FakeProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill(signal: NodeJS.Signals | number): boolean;
}

export interface PreviewProxySpawnOptions {
  ffmpeg: string;
  ffmpegArgs: string[];
  cwd?: string;
}

export interface StartPreviewProxyOptions {
  ffmpeg: string;
  ffmpegArgs: string[];
  /** 一時出力。成功・検証後に finalOutput へ atomic rename。 */
  tmpOutput: string;
  /** 最終出力（public/<base>.preview.mp4）。 */
  finalOutput: string;
  /** 元動画の尺（percent 計算と完成後の検証に使う）。 */
  durationSeconds: number;
  /** 完成物の尺を測る（probeDurationSeconds を注入。null=測定失敗）。 */
  probeDuration: (path: string) => number | null;
  cwd?: string;
}

export interface PreviewProxyJobManagerDeps {
  spawn: (opts: PreviewProxySpawnOptions) => FakeProcess;
  rename: (src: string, dest: string) => void;
  unlink: (path: string) => void;
}

const defaultDeps: PreviewProxyJobManagerDeps = {
  spawn: ({ ffmpeg, ffmpegArgs, cwd }) =>
    nodeSpawn(ffmpeg, ffmpegArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }) as unknown as FakeProcess,
  rename: renameSync,
  unlink: (p) => {
    try {
      unlinkSync(p);
    } catch {
      /* 一時ファイルの掃除失敗は無害 */
    }
  },
};

/**
 * ffmpeg -progress 出力から最後の out_time=HH:MM:SS.micro を秒へ変換する。
 * out_time_ms はバージョンにより単位が揺れる（実体はマイクロ秒）ため out_time を使う。
 * 見つからなければ null。
 */
export function parseProgressSeconds(text: string): number | null {
  const matches = text.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  const m = last.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/)!;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 完成物の尺が元動画と一致とみなせるか（±max(1.5秒, 0.5%)）。 */
export function durationsMatch(sourceSeconds: number, proxySeconds: number): boolean {
  const tolerance = Math.max(1.5, sourceSeconds * 0.005);
  return Math.abs(sourceSeconds - proxySeconds) <= tolerance;
}

/**
 * SME_PREVIEW_MOCK=1 用の mock deps。実 ffmpeg を起動せず、delayMs の間に
 * 進捗 25%→50%→75% を stdout へ流して成功する。
 */
export function createMockPreviewProxyDeps(delayMs = 3000): PreviewProxyJobManagerDeps {
  return {
    spawn: () => {
      const em = new EventEmitter() as FakeProcess;
      em.stdout = new Readable({ read() {} });
      em.stderr = new Readable({ read() {} });
      em.kill = () => {
        setImmediate(() => em.emit('exit', 1));
        return true;
      };
      const step = Math.max(0, delayMs / 4);
      // 尺 60 秒想定（previewProxyApi の mock ソース情報と揃える）
      setTimeout(() => em.stdout.push('out_time=00:00:15.000000\n'), step);
      setTimeout(() => em.stdout.push('out_time=00:00:30.000000\n'), step * 2);
      setTimeout(() => em.stdout.push('out_time=00:00:45.000000\n'), step * 3);
      setTimeout(() => {
        em.stdout.push('out_time=00:01:00.000000\nprogress=end\n');
        setImmediate(() => em.emit('exit', 0));
      }, step * 4);
      return em;
    },
    rename: () => {
      /* no-op in mock */
    },
    unlink: () => {
      /* no-op in mock */
    },
  };
}

export class PreviewProxyJobManager {
  private jobs = new Map<string, PreviewProxyJob>();
  private procs = new Map<string, FakeProcess>();
  private subs = new Map<string, Set<(ev: PreviewProxyEvent) => void>>();
  private opts = new Map<string, StartPreviewProxyOptions>();

  constructor(private deps: PreviewProxyJobManagerDeps = defaultDeps) {}

  exists(projectId: string): boolean {
    return this.jobs.has(projectId);
  }
  get(projectId: string): PreviewProxyJob | undefined {
    return this.jobs.get(projectId);
  }

  /** 実行中ジョブ数（重ジョブ負荷ゲート用）。 */
  activeCount(): number {
    return this.jobs.size;
  }

  start(projectId: string, opts: StartPreviewProxyOptions): PreviewProxyJob {
    if (this.jobs.has(projectId)) throw new Error('already-running');
    const job: PreviewProxyJob = {
      projectId,
      startedAt: Date.now(),
      phase: 'preparing',
      percent: null,
    };
    this.jobs.set(projectId, job);
    this.opts.set(projectId, opts);

    const proc = this.deps.spawn({ ffmpeg: opts.ffmpeg, ffmpegArgs: opts.ffmpegArgs, cwd: opts.cwd });
    this.procs.set(projectId, proc);
    proc.stdout.on('data', (d: Buffer | string) => this.onProgressData(projectId, String(d)));
    // stderr は drain 必須（リスナー無しだと OS パイプ満杯で ffmpeg が write ブロック→ハング）
    proc.stderr.on('data', () => {});
    proc.on('exit', (code: number | null) => this.onExit(projectId, code));
    proc.on('error', (err: Error) => this.onSpawnError(projectId, err));
    return job;
  }

  private onProgressData(projectId: string, chunk: string): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    if (job.phase === 'preparing') {
      job.phase = 'converting';
      this.emit(projectId, { phase: 'converting', percent: job.percent ?? 0 });
    }
    if (job.phase !== 'converting') return;
    const opts = this.opts.get(projectId)!;
    const sec = parseProgressSeconds(chunk);
    if (sec === null || opts.durationSeconds <= 0) return;
    // 100% は rename 完了（done）で表す。converting 中は 99 まで。
    const percent = Math.min(99, Math.floor((sec / opts.durationSeconds) * 100));
    if (job.percent === null || percent > job.percent) {
      job.percent = percent;
      this.emit(projectId, { phase: 'converting', percent });
    }
  }

  private onExit(projectId: string, code: number | null): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    const opts = this.opts.get(projectId)!;
    if (code !== 0) {
      this.deps.unlink(opts.tmpOutput);
      this.fail(projectId, {
        code: 'ffmpeg-error',
        message: `軽量版の生成が終了コード ${code ?? 'null'} で失敗しました`,
      });
      return;
    }
    job.phase = 'finalizing';
    this.emit(projectId, { phase: 'finalizing' });

    // 完成物の尺検証: 元動画とズレていたら採用しない（プレビューの時間軸が狂うため）。
    const proxySec = opts.probeDuration(opts.tmpOutput);
    if (proxySec === null || !durationsMatch(opts.durationSeconds, proxySec)) {
      this.deps.unlink(opts.tmpOutput);
      this.fail(projectId, {
        code: 'duration-mismatch',
        message:
          proxySec === null
            ? '軽量版の検証に失敗しました（尺を取得できません）'
            : `軽量版の尺が元動画と一致しません（元 ${opts.durationSeconds.toFixed(1)}s / 軽量版 ${proxySec.toFixed(1)}s）`,
      });
      return;
    }

    try {
      this.deps.rename(opts.tmpOutput, opts.finalOutput);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.unlink(opts.tmpOutput);
      this.fail(projectId, { code: 'rename-failed', message: `軽量版の差し替えに失敗しました: ${msg}` });
      return;
    }
    job.phase = 'done';
    job.percent = 100;
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
    // SSE が観測するまでジョブを保持（cleanup しない）。normalizeJob と同じ規律。
  }

  private fail(projectId: string, error: { code: string; message: string }): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    job.phase = 'failed';
    job.error = error;
    this.emit(projectId, { phase: 'failed', error });
    this.cleanup(projectId);
  }

  subscribe(projectId: string, fn: (ev: PreviewProxyEvent) => void): () => void {
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
    const opts = this.opts.get(projectId);
    if (opts) this.deps.unlink(opts.tmpOutput);
    this.emit(projectId, { phase: 'cancelled' });
    this.cleanup(projectId);
    return true;
  }

  killAll(): void {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  discard(projectId: string): void {
    this.cleanup(projectId);
  }

  private emit(projectId: string, ev: PreviewProxyEvent): void {
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
  }
}
