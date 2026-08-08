import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { parseRenderProgress, type RenderProgress } from './renderProgress';
import { parseFfmpegProgress } from './fastCutRender';
import { quoteForCmdShell, spawnCommand, type FakeProcess } from './spawnShell';
import { NPM_INSTALL_ARGS } from './installArgs';

// renderJob.test.ts が './renderJob' から import しているため後方互換で再エクスポート。
export { quoteForCmdShell, type FakeProcess };

/** SSE イベントのフェーズ。 */
export type RenderJobPhase =
  | 'preparing'
  | 'bundling'
  | 'rendering'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'cancelled';

/** SSE で流すイベント。 */
export interface RenderJobEvent {
  phase: RenderJobPhase;
  progress?: RenderProgress;
  error?: { code: string; message: string };
  /** 完了はしたが気になる点がある時の注意書き（例: フレーム数が想定と違う）。 */
  warning?: string;
}

/** ジョブの内部状態。 */
export interface RenderJob {
  projectId: string;
  startedAt: number;
  phase: RenderJobPhase;
  progress?: RenderProgress;
  error?: { code: string; message: string };
  warning?: string;
}

export interface RenderSpawnOptions {
  /** 実行するコマンド（npm / npx 等）。 */
  command: string;
  /** コマンドに渡す引数配列。 */
  args: string[];
  cwd?: string;
}

export interface StartRenderOptions {
  /** Remotion プロジェクトのルート（spawn の cwd）。 */
  projectDir: string;
  /** true の場合 render 前に npm install を実行する。 */
  needsInstall: boolean;
  /** 一時出力パス。成功後に finalOutput へ atomic rename する。 */
  tmpOutput: string;
  /** 最終出力パス。 */
  finalOutput: string;
  /** remotion render へ渡す追加 CLI 引数（--crf / --scale 等・省略時なし）。 */
  extraArgs?: string[];
  /**
   * 「カットしただけ」の高速経路（省略時は通常の Remotion 経路）。
   * Remotion を起動せず ffmpeg で原本を切って繋ぐ。出力は tmpOutput（rename は共通）。
   * totalFrames は進捗の分母（ffmpeg は concat 後の総尺を事前に知らせないため渡す）。
   */
  fastCut?: {
    command: string;
    args: string[];
    totalFrames: number;
    /**
     * 書き出し後の検算（省略可）。出力の実フレーム数が totalFrames と一致するかを見る。
     * 不一致なら注意書きを返す（カット位置がずれている可能性を利用者に伝えるため）。
     */
    verify?: (output: string, expectedFrames: number) => string | null;
  };
  /**
   * 仕上げ工程（省略時なし）。render 成功後に ffmpeg 等を spawn し、
   * output 成功後に output → finalOutput を rename、tmpOutput は削除する。
   * スーパーサンプリング縮小（シマー除去）に使う。
   */
  post?: {
    command: string;
    args: string[];
    /** 仕上げ工程の出力パス（成功後に finalOutput へ rename）。 */
    output: string;
  };
}

export interface RenderJobManagerDeps {
  /** child_process.spawn の代替（テストで差し替え可能）。 */
  spawn: (opts: RenderSpawnOptions) => FakeProcess;
  /** fs.renameSync の代替（テストで差し替え可能）。 */
  rename: (src: string, dest: string) => void;
  /** fs.unlinkSync の代替（テストで差し替え可能）。 */
  unlink: (path: string) => void;
  /**
   * プロセスツリー全体（孫プロセスを含む）を kill する。
   * `npx remotion render` はヘッドレス Chrome / ffmpeg を子として起動するため、
   * 本体プロセスのみ SIGTERM しても孫プロセスが孤児化して残る。
   * POSIX はプロセスグループ kill、Windows は taskkill /T。テストで差し替え可能。
   */
  killGroup: (pid: number) => void;
  /**
   * fs.existsSync の代替（テストで差し替え可能・省略時はチェックをスキップ）。
   * render プロセスが exit 0 なのに出力を書かないケース（headless shell 展開壊れ等）を
   * 仕上げ工程へ流す前に検出するために使う。
   */
  exists?: (path: string) => boolean;
}

const COMPOSITION_ID = 'MainVideo';

const defaultDeps: RenderJobManagerDeps = {
  spawn: spawnCommand,
  rename: renameSync,
  unlink: unlinkSync,
  killGroup: (pid: number) => {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  },
  exists: existsSync,
};

/**
 * SME_RENDER_MOCK=1 時に使う mock deps を生成する。
 * 実 npm/npx を起動せず、delayMs の間に progress 25%→50%→75% を emit して exit 0。
 * rename は no-op。SME_RENDER_MOCK_FAIL=1 の場合は失敗（exit 1）で終わる。
 */
export function createMockRenderDeps(delayMs = 3000): RenderJobManagerDeps {
  const shouldFail = process.env.SME_RENDER_MOCK_FAIL === '1';
  return {
    spawn: () => {
      const em = new EventEmitter() as FakeProcess;
      em.stdout = new Readable({ read() {} });
      em.stderr = new Readable({ read() {} });
      em.kill = () => {
        setImmediate(() => em.emit('exit', 1));
        return true;
      };
      if (shouldFail) {
        setTimeout(() => {
          em.stderr.push('Mock render failure (SME_RENDER_MOCK_FAIL=1)\n');
          setImmediate(() => em.emit('exit', 1));
        }, delayMs);
        return em;
      }
      const step = Math.max(0, delayMs / 4);
      setTimeout(() => em.stdout.push('Rendered 25/100\n'), step);
      setTimeout(() => em.stdout.push('Rendered 50/100\n'), step * 2);
      setTimeout(() => em.stdout.push('Rendered 75/100\n'), step * 3);
      setTimeout(() => {
        em.stdout.push('Rendered 100/100\n');
        setImmediate(() => em.emit('exit', 0));
      }, step * 4);
      return em;
    },
    rename: () => { /* no-op in mock mode */ },
    unlink: () => { /* no-op in mock mode */ },
    killGroup: () => { /* no-op in mock mode（実プロセスグループを持たないため） */ },
  };
}

/**
 * 書き出し（Remotion render）ジョブを管理する。
 * denoiseJob.ts の DenoiseJobManager と同じ構造を持つ。
 *
 * 排他制御: projectId ごとに 1 本のみ実行可能。
 * needsInstall=true の場合、npm install（phase=preparing）→ render の 2 段プロセス。
 */
export class RenderJobManager {
  private jobs = new Map<string, RenderJob>();
  /** projectId → 直近の書き出し先パス。cleanup を跨いで残す（lastOutput 参照）。 */
  private lastOutputs = new Map<string, string>();
  private procs = new Map<string, FakeProcess>();
  private subs = new Map<string, Set<(ev: RenderJobEvent) => void>>();
  private opts = new Map<string, StartRenderOptions>();
  private stderrTails = new Map<string, string>();

  constructor(private deps: RenderJobManagerDeps = defaultDeps) {}

  exists(projectId: string): boolean {
    return this.jobs.has(projectId);
  }

  get(projectId: string): RenderJob | undefined {
    return this.jobs.get(projectId);
  }

  /**
   * 直近の書き出しが出力したパス（「フォルダで表示」用）。
   *
   * **cleanup では消さない**。ジョブ record は完了時に cleanup で捨てられるが、
   * 「Finderで表示」ボタンが押されるのは完了 **後** なので、job から引くと必ず
   * undefined になる。出力名は解像度で変わる（video-720p.mp4 等）ため、固定名の
   * 決め打ちに戻さないための情報源として別マップで保持する。
   */
  lastOutput(projectId: string): string | undefined {
    return this.lastOutputs.get(projectId);
  }

  /** 実行中ジョブ数（重ジョブ負荷ゲート用）。 */
  activeCount(): number {
    return this.jobs.size;
  }

  start(projectId: string, opts: StartRenderOptions): RenderJob {
    if (this.jobs.has(projectId)) {
      throw new Error('already-running');
    }
    const job: RenderJob = {
      projectId,
      startedAt: Date.now(),
      phase: 'preparing',
    };
    this.jobs.set(projectId, job);
    this.opts.set(projectId, opts);
    this.lastOutputs.set(projectId, opts.finalOutput);
    this.stderrTails.set(projectId, '');

    if (opts.needsInstall) {
      this.spawnInstall(projectId);
    } else {
      this.spawnRender(projectId);
    }

    return job;
  }

  private spawnInstall(projectId: string): void {
    const opts = this.opts.get(projectId)!;
    const proc = this.deps.spawn({
      command: 'npm',
      args: [...NPM_INSTALL_ARGS],
      cwd: opts.projectDir,
    });
    this.procs.set(projectId, proc);

    // stdout/stderr は drain 必須（listener を必ず付ける）
    proc.stdout.on('data', () => { /* drain */ });
    proc.stderr.on('data', () => { /* drain */ });

    proc.on('exit', (code: number | null) => this.onInstallExit(projectId, code));
    proc.on('error', (err: Error) => this.onSpawnError(projectId, err));
  }

  private spawnRender(projectId: string): void {
    const opts = this.opts.get(projectId)!;
    const proc = this.deps.spawn(
      opts.fastCut === undefined
        ? {
            command: 'npx',
            args: ['remotion', 'render', COMPOSITION_ID, opts.tmpOutput, ...(opts.extraArgs ?? [])],
            cwd: opts.projectDir,
          }
        : { command: opts.fastCut.command, args: opts.fastCut.args, cwd: opts.projectDir },
    );
    this.procs.set(projectId, proc);

    proc.stdout.on('data', (chunk: Buffer | string) => this.onRenderData(projectId, chunk));
    proc.stderr.on('data', (chunk: Buffer | string) => this.onRenderData(projectId, chunk, true));

    proc.on('exit', (code: number | null) => this.onRenderExit(projectId, code));
    proc.on('error', (err: Error) => this.onSpawnError(projectId, err));
  }

  private onInstallExit(projectId: string, code: number | null): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    if (code === 0) {
      // install 成功 → render プロセスへ（phase は preparing のまま）
      this.procs.delete(projectId);
      this.spawnRender(projectId);
      return;
    }
    this.fail(projectId, 'npm-install-failed', `npm install が終了コード ${code ?? 'null'} で終了しました`);
  }

  private onRenderData(projectId: string, chunk: Buffer | string, isStderr = false): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    const text = chunk.toString();

    if (isStderr) {
      // stderr は末尾 500 文字のみ保持
      const tail = (this.stderrTails.get(projectId) ?? '') + text;
      this.stderrTails.set(projectId, tail.slice(-500));
    }

    const fastCut = this.opts.get(projectId)?.fastCut;
    const progress = fastCut === undefined
      ? parseRenderProgress(text)
      : parseFfmpegProgress(text, fastCut.totalFrames);
    if (progress) {
      job.phase = 'rendering';
      job.progress = progress;
      this.emit(projectId, { phase: 'rendering', progress });
      return;
    }
    // 進捗なしの最初のデータで bundling へ
    if (job.phase === 'preparing') {
      job.phase = 'bundling';
      this.emit(projectId, { phase: 'bundling' });
    }
  }

  subscribe(projectId: string, fn: (ev: RenderJobEvent) => void): () => void {
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
    if (proc) this.killProcessTree(proc);
    const opts = this.opts.get(projectId);
    if (opts) {
      try {
        this.deps.unlink(opts.tmpOutput);
      } catch {
        // 一時ファイルが存在しなくても OK
      }
      if (opts.post) {
        try {
          this.deps.unlink(opts.post.output);
        } catch {
          // 仕上げ出力が存在しなくても OK
        }
      }
    }
    this.emit(projectId, { phase: 'cancelled' });
    this.cleanup(projectId);
    return true;
  }

  /**
   * プロセス（と孫プロセス）を終了させる。
   * pid が取得できる場合はツリーごと kill（ヘッドレス Chrome / ffmpeg の孤児化防止。
   * POSIX はプロセスグループ、Windows は taskkill /T）。
   * killGroup が失敗した場合、または pid 不明の場合は本体プロセスのみ SIGTERM。
   */
  private killProcessTree(proc: FakeProcess): void {
    if (proc.pid) {
      try {
        this.deps.killGroup(proc.pid);
        return;
      } catch {
        // フォールバック: 本体プロセスのみ SIGTERM
      }
    }
    proc.kill('SIGTERM');
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

  private onRenderExit(projectId: string, code: number | null): void {
    const job = this.jobs.get(projectId);
    if (!job) return;

    if (code === 0) {
      const opts = this.opts.get(projectId)!;
      // exit 0 でも出力が無いケースがある（headless shell 展開壊れ等・2026-07-23 実例）。
      // このまま仕上げ工程へ進むと ffmpeg が ENOENT の exit 254 を返し原因が分からなくなる。
      if (this.deps.exists && !this.deps.exists(opts.tmpOutput)) {
        this.fail(
          projectId,
          'render-no-output',
          '書き出しプロセスは正常終了しましたが、出力ファイルが生成されませんでした。' +
            'Remotion の描画用ブラウザ（chrome-headless-shell）の破損が疑われます。' +
            'プロジェクトの node_modules/.remotion を削除して再実行してください。',
        );
        return;
      }
      if (opts.post) {
        this.procs.delete(projectId);
        this.spawnPost(projectId);
        return;
      }
      try {
        this.deps.rename(opts.tmpOutput, opts.finalOutput);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.fail(projectId, 'rename-failed', `一時ファイルの差し替えに失敗しました: ${msg}`);
        return;
      }
      // 高速経路（ffmpeg カット）は出力フレーム数を検算する。カット位置がずれていれば
      // ここで気づける（引き継ぎ手順の手作業チェックの自動化）。
      let warning: string | undefined;
      if (opts.fastCut?.verify !== undefined) {
        warning = opts.fastCut.verify(opts.finalOutput, opts.fastCut.totalFrames) ?? undefined;
      }
      job.phase = 'done';
      if (warning !== undefined) job.warning = warning;
      this.emit(projectId, warning === undefined ? { phase: 'done' } : { phase: 'done', warning });
      this.cleanup(projectId);
    } else {
      const tail = this.stderrTails.get(projectId) ?? '';
      this.fail(
        projectId,
        'render-failed',
        `書き出しが終了コード ${code ?? 'null'} で終了しました${tail ? `: ${tail}` : ''}`,
      );
    }
  }

  /** 仕上げ工程（ffmpeg 縮小）。stderr は末尾のみ保持し、失敗診断に使う。 */
  private spawnPost(projectId: string): void {
    const opts = this.opts.get(projectId)!;
    const job = this.jobs.get(projectId);
    if (!job) return;
    job.phase = 'finalizing';
    this.emit(projectId, { phase: 'finalizing' });
    const proc = this.deps.spawn({
      command: opts.post!.command,
      args: opts.post!.args,
      cwd: opts.projectDir,
    });
    this.procs.set(projectId, proc);

    // stdout/stderr は drain 必須（listener を必ず付ける）
    proc.stdout.on('data', () => { /* drain */ });
    proc.stderr.on('data', (chunk: Buffer | string) => {
      const tail = (this.stderrTails.get(projectId) ?? '') + chunk.toString();
      this.stderrTails.set(projectId, tail.slice(-500));
    });

    proc.on('exit', (code: number | null) => this.onPostExit(projectId, code));
    proc.on('error', (err: Error) => this.onSpawnError(projectId, err));
  }

  private onPostExit(projectId: string, code: number | null): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    const opts = this.opts.get(projectId)!;
    if (code === 0) {
      try {
        this.deps.rename(opts.post!.output, opts.finalOutput);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.fail(projectId, 'rename-failed', `一時ファイルの差し替えに失敗しました: ${msg}`);
        return;
      }
      try {
        this.deps.unlink(opts.tmpOutput);
      } catch {
        // 中間ファイルが消せなくても出力は完成している
      }
      job.phase = 'done';
      this.emit(projectId, { phase: 'done' });
      this.cleanup(projectId);
      return;
    }
    const tail = this.stderrTails.get(projectId) ?? '';
    this.fail(
      projectId,
      'finalize-failed',
      `仕上げ（縮小エンコード）が終了コード ${code ?? 'null'} で終了しました${tail ? `: ${tail}` : ''}`,
    );
  }

  private onSpawnError(projectId: string, err: Error): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    const ev: RenderJobEvent = {
      phase: 'failed',
      error: {
        code: 'spawn-failed',
        message:
          `プロセスを起動できませんでした（${err.message}）。` +
          'Node.js 環境を確認してください。',
      },
    };
    job.phase = 'failed';
    job.error = ev.error;
    this.emit(projectId, ev);
    // denoiseJob と同様: SSE が観測するまでジョブを保持する
  }

  private fail(projectId: string, code: string, message: string): void {
    const job = this.jobs.get(projectId);
    if (!job) return;
    const ev: RenderJobEvent = { phase: 'failed', error: { code, message } };
    job.phase = 'failed';
    job.error = ev.error;
    this.emit(projectId, ev);
    // onSpawnError と同様: SSE が観測するまでジョブを保持する（POST〜SSE 接続の
    // 隙間に高速失敗しても idle と誤認されないようにする）。破棄は SSE 側の discard。
    // 万一 SSE が一度も張られなくても、エディタはプロジェクトを開くと必ず
    // GET /api/render（SSE）を張るため、次に張られた SSE の snapshot 分岐
    // （renderApi.ts の terminal 判定 → discard）で回収される。
  }

  private emit(projectId: string, ev: RenderJobEvent): void {
    const set = this.subs.get(projectId);
    if (!set) return;
    for (const fn of set) fn(ev);
  }

  /**
   * ジョブ終了時の状態クリア。**subs は消さない**（2026-07-23 I-1 修正）:
   * 同一 projectId を複数の SSE 接続（例: 同一プロジェクトを開いた2タブ）が subscribe
   * している状態で、片方の emit ループ中に subs.delete(projectId) すると、Set 全体が
   * 消え去るため、もう片方の購読者まで巻き込んで失う（次のジョブの emit が届かず
   * 恒久的に無音化する）。購読解除は subscribe() が返す unsubscribe（Set からの
   * 自分の fn だけの削除）のみが行う。
   */
  private cleanup(projectId: string): void {
    this.jobs.delete(projectId);
    this.procs.delete(projectId);
    this.opts.delete(projectId);
    this.stderrTails.delete(projectId);
  }
}
