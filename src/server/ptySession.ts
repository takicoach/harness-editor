/**
 * AI ツール共用 pty セッション（エディタ全体で1本）。
 * - 起動対象は AI_TOOLS の許可リストに載っているものだけ（アダプタ駆動。resolveToolForPty /
 *   checkToolVersion に渡す）。
 * - 課金系環境変数を既定除去（SME_ALLOW_API_KEY=1 で無効化。除去キーはアダプタが持つ）
 * - projectRoot の健全性チェック（ホーム直下・ドライブルート拒否）
 * - scrollback リングバッファ（再接続時の再生用）
 * - OSC 10/11（色問い合わせ）への応答（テーマ由来の定数のみ・spawn ごとに作る）
 * 接続制御（トークン・Origin・単一書き込み）は ptyApi 側の責務。
 */
// I-3: node-pty はトップレベルで import しない。node-pty のネイティブモジュールの
// ロードに失敗すると（配布先は非エンジニアの Windows 機を含む）、この import が
// vite.config.ts → aiPlugin.ts → ptySession.ts の連鎖で dev サーバー自体の
// 起動失敗に増幅されてしまう（この製品は dev サーバーがそのまま製品）。
// 値（spawn）は ensure() 内で動的 import する。型は実行時 import を伴わないため
// トップレベルのまま安全。
import type { IPty, IDisposable, spawn as PtySpawnFn } from 'node-pty';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveToolForPty, checkToolVersion } from './aiToolBin';
import { AI_TOOLS, DEFAULT_AI_TOOL, type AiToolId } from './aiTools';
import { createOscColorResponder } from './oscColorReply';
import { terminalColorsFor } from '../shared/terminalColors';

const SCROLLBACK_MAX = 200_000;

export type SpawnHelperRepairResult =
  | { ok: true; repaired: boolean; helperPath: string | null }
  | { ok: false; error: string; helperPath: string };

/**
 * macOS 版 node-pty は AI 本体より先に同梱の spawn-helper を posix_spawnp する。
 * ZIP 展開や一部のパッケージ配布経路でこのファイルの実行ビットが落ちると、AI 本体が
 * 正常でも node-pty は情報量のない `posix_spawnp failed.` だけを返す。spawn の直前に
 * 実際にロード対象となる native ディレクトリを探し、helper の実行ビットだけを復旧する。
 */
export function ensureNodePtySpawnHelperExecutable(
  nodePtyRoot: string,
  runtime: { platform: NodeJS.Platform; arch: string } = {
    platform: process.platform,
    arch: process.arch,
  },
): SpawnHelperRepairResult {
  if (runtime.platform !== 'darwin') return { ok: true, repaired: false, helperPath: null };

  // node-pty の native loader と同じ優先順。pty.node と spawn-helper が揃う最初の
  // ディレクトリだけを対象にし、実際には使われない別 arch の helper を触らない。
  const nativeDirs = [
    join(nodePtyRoot, 'build', 'Release'),
    join(nodePtyRoot, 'build', 'Debug'),
    join(nodePtyRoot, 'prebuilds', `darwin-${runtime.arch}`),
  ];
  for (const nativeDir of nativeDirs) {
    const nativeModule = join(nativeDir, 'pty.node');
    const helperPath = join(nativeDir, 'spawn-helper');
    if (!existsSync(nativeModule) || !existsSync(helperPath)) continue;
    try {
      const mode = statSync(helperPath).mode;
      if ((mode & 0o111) === 0o111) {
        return { ok: true, repaired: false, helperPath };
      }
      chmodSync(helperPath, mode | 0o111);
      return { ok: true, repaired: true, helperPath };
    } catch (err) {
      return {
        ok: false,
        helperPath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  // helper が見つからない場合は従来どおり動的 import に任せる。node-pty の構成変更や
  // Windows/Linuxを誤ってこの補正だけで起動不能にしないため、ここでは失敗扱いにしない。
  return { ok: true, repaired: false, helperPath: null };
}

function nodePtyPackageRoot(): string | null {
  try {
    // node-pty@1.1.0 の main は <package>/lib/index.js。pnpm の symlink 配置でも
    // createRequire.resolve は実体側へ解決するため、配布方式に依存せず package root を得られる。
    const entry = createRequire(import.meta.url).resolve('node-pty');
    return resolve(dirname(entry), '..');
  } catch {
    return null;
  }
}

/** ツールごとの課金系環境変数を除去する（キーの一覧はアダプタが持つ）。 */
export function sanitizeEnv(
  env: NodeJS.ProcessEnv,
  billingEnvKeys: readonly string[],
): { env: NodeJS.ProcessEnv; removed: string[] } {
  if (env.SME_ALLOW_API_KEY === '1') return { env: { ...env }, removed: [] };
  const out: NodeJS.ProcessEnv = { ...env };
  const removed: string[] = [];
  for (const k of billingEnvKeys) {
    if (out[k] !== undefined) {
      delete out[k];
      removed.push(k);
    }
  }
  return { env: out, removed };
}

/** プロジェクト置き場として健全か（被害半径の footgun 防止）。 */
export function isSaneProjectRoot(root: string): boolean {
  const r = resolve(root);
  if (r === resolve(homedir())) return false;
  if (r === parse(r).root) return false;
  return true;
}

export interface EnsureOpts {
  editorDir: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  port?: number; // 既定 2109
  /** 起動時テーマ（既定 dark）。TUI の色は起動時に決まる（claude は --settings、codex は OSC 応答）。 */
  theme?: 'light' | 'dark';
  /** 起動する AI ツール（既定 claude）。 */
  tool?: AiToolId;
}

export type EnsureResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** クライアントが分岐に使う機械可読なコード。 */
      code?: 'tool-mismatch' | 'not-found' | 'too-old';
      /** tool-mismatch のとき、実際に動いているツール。 */
      actualTool?: AiToolId;
    };

export type SwitchResult =
  | { ok: true; actualTool: AiToolId; sessionId: string; notes: string[] }
  | { ok: false; error: string; code?: 'not-found' | 'too-old' };

export function createPtySessionManager() {
  let pty: IPty | null = null;
  let ring = '';
  let exitCode: number | null = null;
  let removedEnvKeys: string[] = [];
  /** stale ハンドラガード用の世代カウンタ（下記 ensure 内コメント参照）。 */
  let generation = 0;
  /** kill 時に即座に止めたい現行セッションの onData 購読（onExit は確定まで生かす。下記 ensure 内コメント参照）。 */
  let liveDataSub: IDisposable | null = null;
  const dataFns = new Set<(c: string) => void>();
  const exitFns = new Set<(code: number) => void>();
  /** 現在動いている（または直近まで動いていた）ツール。単一セッションの正本。 */
  let tool: AiToolId | null = null;
  /** spawn ごとに変わるセッション識別子。 */
  let sid: string | null = null;
  /** prepare が出した注意書き（隔離できなかった等）。UI がそのまま表示する。 */
  let prepareNotes: string[] = [];
  /** 起動時テーマ（OSC 応答・startWaiting 等が参照する）。 */
  let theme: 'light' | 'dark' = 'dark';
  /** 切替を直列化する mutex（連打・並行切替で spawn が競合しないように）。 */
  let switchChain: Promise<unknown> = Promise.resolve();
  /** ptyApi が登録する writer 失効関数（循環 import を避けるため注入で受ける）。 */
  let invalidateWriter: (() => void) | null = null;

  /** SIGTERM → 猶予 → 強制 kill。編集途中の強制終了を既定にしない。 */
  const GRACEFUL_EXIT_MS = 3000;
  async function stopGracefully(): Promise<void> {
    const target = pty;
    if (target === null) return;
    liveDataSub?.dispose();
    liveDataSub = null;
    const exited = new Promise<void>((resolve) => {
      const off = target.onExit(() => { off.dispose(); resolve(); });
    });
    try {
      target.kill('SIGTERM');
    } catch {
      // 既に死んでいる場合は次の強制 kill も no-op になる。
    }
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((res) => setTimeout(() => res(true), GRACEFUL_EXIT_MS)),
    ]);
    if (timedOut) {
      try {
        // SIGTERM で終わらなかった場合の最終手段。node-pty の Unix 実装は kill(signal?) の
        // 既定シグナルが SIGHUP（トラップ可能）のため、引数無し kill() では SIGTERM/SIGHUP
        // を両方トラップするプロセスを終了させられない。SIGKILL は捕捉・無視不可能なので
        // ここでは明示する（Windows では node-pty がシグナル引数自体を無視して強制終了する
        // ため、明示しても既定と同じ挙動のまま安全）。
        target.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    pty = null;
    tool = null;
    sid = null;
  }

  const api = {
    /**
     * 既存セッションが running 中は「要求ツールが現行ツールと同じか」を確認して
     * 同じなら { ok: true }、違えば tool-mismatch で拒否する
     * （projectRoot が変わっていても既存セッションをそのまま返す — 単一セッション設計。
     * projectRoot を変えて再起動したい場合は先に killAll() すること）。
     */
    async ensure(opts: EnsureOpts): Promise<EnsureResult> {
      const wanted = opts.tool ?? DEFAULT_AI_TOOL;
      // 起動中なら「同じツールか」を必ず確認する。旧実装は opts を見ずに ok を返していたため、
      // 別タブが別ツールを選ぶと「表示は Codex・実体は Claude」になった（外部レビュー P1-1）。
      if (pty !== null) {
        return tool === wanted
          ? { ok: true }
          : {
              ok: false,
              error: `いま動いているのは ${AI_TOOLS[tool ?? DEFAULT_AI_TOOL].label} です。切り替えるには切替操作を使ってください。`,
              code: 'tool-mismatch',
              actualTool: tool ?? DEFAULT_AI_TOOL,
            };
      }
      if (!isSaneProjectRoot(opts.projectRoot)) {
        return {
          ok: false,
          error:
            'プロジェクト置き場（HARNESS_PROJECT_ROOT）がホームやドライブ直下を指しています。専用フォルダを指定してください。',
        };
      }
      if (!existsSync(opts.projectRoot)) {
        return { ok: false, error: `プロジェクト置き場が見つかりません: ${opts.projectRoot}` };
      }
      const adapter = AI_TOOLS[wanted];
      const loc = resolveToolForPty(adapter, opts.editorDir, opts.env);
      if (loc === null) {
        const hint = adapter.installPackage === null
          ? `ターミナルで npm i -g @openai/codex を実行してください。`
          : '先に導入してください。';
        return { ok: false, error: `${adapter.binName} が見つかりません。${hint}`, code: 'not-found' };
      }
      if (loc.source !== 'test-override') {
        const v = checkToolVersion(adapter, loc);
        if (!v.ok) {
          return {
            ok: false,
            code: 'too-old',
            error:
              `${adapter.label} が古すぎます（見つかった版: ${v.found ?? '不明'} / 必要: ${adapter.minVersion} 以上）。` +
              'ターミナルで npm i -g @openai/codex を実行して更新してください。',
          };
        }
      }
      // I-3: node-pty の動的 import。ネイティブモジュールのロード失敗を dev サーバーの
      // 起動失敗に波及させず、ここで { ok: false } に落として AI タブだけがエラーを出す。
      const nodePtyRoot = nodePtyPackageRoot();
      if (nodePtyRoot !== null) {
        const helper = ensureNodePtySpawnHelperExecutable(nodePtyRoot);
        if (!helper.ok) {
          return {
            ok: false,
            error:
              `ターミナル補助プログラムの実行権限を復旧できませんでした（${helper.error}）。` +
              'エディタを読み書き可能なフォルダへ移して、もう一度接続してください。',
          };
        }
      }
      let ptySpawn: typeof PtySpawnFn;
      try {
        ({ spawn: ptySpawn } = await import('node-pty'));
      } catch (err) {
        return {
          ok: false,
          error:
            `ターミナル機能の読み込みに失敗しました（${err instanceof Error ? err.message : String(err)}）。` +
            'AI タブ以外の機能は通常どおり使えます。',
        };
      }
      // await の間に別の ensure() が先に spawn していたら、そちらを尊重して二重 spawn しない。
      // このとき「要求ツールが同じか」も必ず見る（並行 ensure で別ツールを取り違えない）。
      if (pty !== null) {
        return tool === wanted
          ? { ok: true }
          : {
              ok: false,
              error: `いま動いているのは ${AI_TOOLS[tool ?? DEFAULT_AI_TOOL].label} です。`,
              code: 'tool-mismatch',
              actualTool: tool ?? DEFAULT_AI_TOOL,
            };
      }
      theme = opts.theme ?? 'dark';
      const prep = adapter.prepare?.({ editorDir: opts.editorDir, env: opts.env });
      prepareNotes = prep?.notes ?? [];
      const { env, removed } = sanitizeEnv(opts.env, adapter.billingEnvKeys);
      removedEnvKeys = removed;
      const spawnEnv = { ...env, ...(prep?.env ?? {}) };
      const args =
        loc.source === 'test-override'
          ? loc.args
          : [...loc.args, ...adapter.launchArgs(opts.port ?? 2109, theme)];
      try {
        pty = ptySpawn(loc.file, args, {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: opts.projectRoot,
          env: spawnEnv as { [k: string]: string },
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      tool = wanted;
      sid = randomUUID();
      exitCode = null;
      // stale ハンドラガード: 世代カウンタ方式。spawn 成功直後に自分の世代番号を
      // 確定させ、以後 generation が進んでいたら（＝別の ensure が新世代を spawn
      // した）自分は stale として扱う。
      // 旧方式（`pty !== null && pty !== self`）は pty が一度 null に戻ると
      // （後続世代が exit 済みだと）それより前の世代の遅延 exit まで
      // 「stale ではない」と誤判定してしまうバグがあった
      // （世代A→kill→世代B→Bのexit確定(pty=null)→Aの遅延exitが割り込み、
      // pty===null かつ pty!==selfA が false になるため通ってしまい、
      // exitCode/exitFns を古い値で二重上書きする）。null 状態に依存しない
      // 世代比較にすることでこの穴を塞ぐ。
      const myGen = ++generation;
      const isStale = (): boolean => myGen !== generation;
      const self = pty;
      // OSC 応答器はこのセッション専用に作る。マネージャ単位で使い回すと、跨ぎ検出用に
      // 保持している旧セッションの末尾バイトが新セッションの先頭と連結され、誤応答しうる。
      const respondOsc = createOscColorResponder(() => terminalColorsFor(theme));
      const dataSub = self.onData((chunk) => {
        if (isStale()) return; // 旧インスタンスの遅延 data を新セッションの ring/リスナーに混ぜない
        // OSC 10/11 の問い合わせに即答する。ring への蓄積・リスナー配布より先に判定する
        // （クライアントの xterm はこの時点でまだ存在しないため間に合わない）。
        for (const reply of respondOsc(chunk)) {
          try {
            // プロセス終了直後に data イベントが届く極小の窓（onExit で dataSub を
            // dispose するまでの間）では、終了済み pty への write になりうる。
            // onData は同期コールバックのため、ここで例外を投げると dev サーバー
            // 自体を落としかねない。配色が一瞬反映されないだけで端末機能自体は
            // 継続できるので、失敗は黙って捨てる。
            if (pty === self) self.write(reply);
          } catch {
            // 上記コメントの通り、握りつぶして dev サーバーを道連れにしない。
          }
        }
        ring = (ring + chunk).slice(-SCROLLBACK_MAX);
        for (const fn of dataFns) fn(chunk);
      });
      const exitSub = self.onExit(({ exitCode: code }) => {
        // 自インスタンスの購読は確定時に必ず後始末する（disposable は二重 dispose 安全）。
        dataSub.dispose();
        exitSub.dispose();
        if (liveDataSub === dataSub) liveDataSub = null;
        if (isStale()) return; // 既に新セッションが立っている → pty/exitCode を触らない
        exitCode = code;
        pty = null;
        tool = null;
        sid = null;
        for (const fn of exitFns) fn(code);
      });
      liveDataSub = dataSub;
      return { ok: true };
    },
    write(data: string): void {
      pty?.write(data);
    },
    resize(cols: number, rows: number): void {
      if (cols > 0 && rows > 0 && cols <= 500 && rows <= 300) pty?.resize(cols, rows);
    },
    startWaiting(): { ok: boolean; error?: string } {
      if (pty === null || tool === null) return { ok: false, error: 'AI が起動していません' };
      pty.write(AI_TOOLS[tool].waitingPrompt + '\r');
      return { ok: true };
    },
    onData(fn: (c: string) => void): () => void {
      dataFns.add(fn);
      return () => dataFns.delete(fn);
    },
    onExit(fn: (code: number) => void): () => void {
      exitFns.add(fn);
      return () => exitFns.delete(fn);
    },
    scrollback(): string {
      return ring;
    },
    state(): 'idle' | 'running' | 'exited' {
      if (pty !== null) return 'running';
      return exitCode === null ? 'idle' : 'exited';
    },
    lastExitCode(): number | null {
      return exitCode;
    },
    removedEnvKeys(): string[] {
      return [...removedEnvKeys];
    },
    currentTool(): AiToolId | null {
      return tool;
    },
    sessionId(): string | null {
      return sid;
    },
    /** prepare が出した注意書き（隔離できなかった等）。UI がそのまま表示する。 */
    notes(): string[] {
      return [...prepareNotes];
    },
    killAll(): void {
      // kill 対象セッションの出力購読は即座に止める（死にゆくプロセスの遅延出力が
      // ring/リスナーへ混ざるのを防ぐ）。onExit は実際の終了確定まで生かす
      // （state() が 'exited' に遷移する契機はこの確定イベントのため）。
      liveDataSub?.dispose();
      liveDataSub = null;
      pty?.kill();
      pty = null;
      tool = null;
      sid = null;
    },
    setInvalidateWriter(fn: (() => void) | null): void {
      invalidateWriter = fn;
    },

    /**
     * ツール切替の原子的操作。停止と起動を別 API に分けるとクライアントが 2 段階で
     * 組み立てることになり、2 タブ操作・連打で「表示は Codex・実体は Claude」や
     * 「旧タブの writer が新 pty に書き込む」が起きる（外部レビュー P1-2）。
     * 手順: writer 失効 → 穏当終了 → scrollback 破棄 → 新 spawn。mutex で直列化する。
     */
    async switchTool(opts: EnsureOpts & { tool: AiToolId }): Promise<SwitchResult> {
      // 契約: switchTool は throw しない（必ず SwitchResult を解決する）。
      // api.ensure() は spawn / node-pty 動的 import の失敗を { ok: false } に正規化しているが、
      // その内部で呼ばれる adapter.prepare?.() と checkToolVersion は素通しで、投げれば
      // ensure() ごと reject し、この run() や switchChain 経由で呼び出し側の promise が
      // reject してしまう（switchChain = next.catch() はチェーンの継続を守るだけで、
      // 呼び出し側に返す next 自体は守らない）。次タスクで HTTP 配線する側が
      // try/catch を書き忘れても未処理 rejection にならないよう、ここで丸ごと正規化する。
      const run = async (): Promise<SwitchResult> => {
        try {
          invalidateWriter?.();
          await stopGracefully();
          // 旧ツールの表示履歴を新しい端末に再生しない（確認文言「会話は残りません」と一致させる）。
          ring = '';
          const r = await api.ensure(opts);
          if (!r.ok) return { ok: false, error: r.error, code: r.code === 'tool-mismatch' ? undefined : r.code };
          return {
            ok: true,
            actualTool: opts.tool,
            sessionId: sid ?? '',
            notes: [...prepareNotes],
          };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      };
      const next = switchChain.then(run, run);
      switchChain = next.catch(() => undefined);
      return next;
    },
  };
  return api;
}

export type PtySessionManager = ReturnType<typeof createPtySessionManager>;

export const ptySessions = createPtySessionManager();
