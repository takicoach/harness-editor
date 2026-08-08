/**
 * AI ツール（claude / codex）実行ファイルの検出と版チェック。
 * **claude 専用ではない** — ツールは AiToolAdapter で渡す。
 * 優先順: 差し替え口（テストゲート付き）→ グローバル導入（which/where）→
 * エディタ管理ディレクトリ（.claude-runtime・自動導入対象のツールのみ）。
 * 検出のみを担い、導入は claudeInstallJob が行う。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { AiToolAdapter } from './aiTools';

export interface ToolLocation {
  /** spawn する実行ファイル。 */
  file: string;
  /** 実行ファイルの前置引数（.mjs 差し替え時に [スクリプトパス] が入る）。 */
  args: string[];
  source: 'global' | 'managed' | 'test-override';
}

/**
 * テスト用の差し替え口。**本番アダプタ（aiTools.ts）には持たせない** — テスト専用の
 * 概念をツール定義に混ぜないため、対応表をこのモジュール内に閉じ込める。
 */
const BIN_OVERRIDE_ENV: Record<string, string> = {
  claude: 'SME_CLAUDE_BIN',
  codex: 'SME_CODEX_BIN',
};

export function managedRuntimeDir(editorDir: string): string {
  return join(editorDir, '.claude-runtime');
}

function managedToolPath(tool: AiToolAdapter, editorDir: string): string {
  const bin = process.platform === 'win32' ? `${tool.binName}.cmd` : tool.binName;
  return join(managedRuntimeDir(editorDir), 'node_modules', '.bin', bin);
}

/** PATH 上の実行ファイルを探す（無ければ null）。テストでは which を注入して差し替える。 */
function defaultWhich(binName: string): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [binName], { encoding: 'utf8' }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    return first ? first : null;
  } catch {
    return null;
  }
}

/**
 * findTool / checkToolVersion のプロセス内キャッシュ TTL。
 * どちらも execFileSync（`which`/`where`・`--version`）という同期処理を内部で呼び、
 * GET /api/ai/tools は毎リクエストでツールの数だけこれを呼ぶ。この製品は Vite dev
 * サーバーそのものが製品で Node は単一スレッドのため、キャッシュ無しだと同期呼び出しの
 * 間じゅう HMR・動画配信・SSE を含む全リクエストが止まる（外部レビュー Important 2。
 * Windows のグローバル shim 経由だと `--version` だけで 1〜3 秒かかりえる）。
 * TTL を置くのは、ユーザーが別ターミナルで手動導入した直後に反映されるようにするため
 * （プロセス再起動なしで数秒後には検出結果が追いつく）。
 */
const TOOL_CACHE_TTL_MS = 5_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const findToolCache = new Map<string, CacheEntry<ToolLocation | null>>();
const versionCache = new Map<string, CacheEntry<{ ok: true } | { ok: false; found: string | null }>>();

/**
 * findTool / checkToolVersion のキャッシュを明示的に無効化する。
 * - claudeInstallJob が導入完了（exit code 0）を検知した箇所から呼ぶ（「導入したのに
 *   『入っていません』と出る」を防ぐ。TTL 満了を待たせない）。
 * - テストからも呼べるようにしてある。各テストの前後で呼ぶことで、tool.id が同じでも
 *   editorDir・loc が違う別テストの結果を誤って再利用しない（キャッシュ未クリアだと
 *   後続テストが前のテストの `which`/`run` 注入結果を見てしまう＝相互汚染）。
 */
export function clearToolCache(): void {
  findToolCache.clear();
  versionCache.clear();
}

function findToolUncached(
  tool: AiToolAdapter,
  editorDir: string,
  deps: { which?: (binName: string) => string | null },
): ToolLocation | null {
  const which = deps.which ?? defaultWhich;
  const global = which(tool.binName);
  if (global !== null) return { file: global, args: [], source: 'global' };
  // 自動導入の対象でないツールは管理ディレクトリを持たない（探しても意味がない）。
  if (tool.installPackage === null) return null;
  const managed = managedToolPath(tool, editorDir);
  if (existsSync(managed)) return { file: managed, args: [], source: 'managed' };
  return null;
}

export function findTool(
  tool: AiToolAdapter,
  editorDir: string,
  deps: { which?: (binName: string) => string | null } = {},
): ToolLocation | null {
  // deps.which が注入されている（= テストからの差し替え）ときはキャッシュを読み書きしない。
  // キャッシュキーは tool.id::editorDir のみで which を含まないため、同じ tool・editorDir
  // に違う which を注入した2テストが原理的に混ざりうる（防波堤がテストの beforeEach
  // clearToolCache 頼みになる）。deps 注入時は毎回素の経路を通すことでこれを断つ。
  // 本番は deps 注入が無いのでキャッシュは従来どおり効く。
  if (deps.which !== undefined) return findToolUncached(tool, editorDir, deps);
  // editorDir をキーに含める: 管理ディレクトリ（.claude-runtime）の実体は editorDir ごとに
  // 異なるため、同じツールでも editorDir が違えば結果が違いうる（テストも一時ディレクトリ
  // ごとに異なる結果を期待している。含めないと editorDir をまたいで汚染する）。
  const key = `${tool.id}::${editorDir}`;
  const now = Date.now();
  const cached = findToolCache.get(key);
  if (cached !== undefined && cached.expiresAt > now) return cached.value;
  const value = findToolUncached(tool, editorDir, deps);
  findToolCache.set(key, { value, expiresAt: now + TOOL_CACHE_TTL_MS });
  return value;
}

/**
 * 差し替えゲートが開くか。
 * 旧実装は `Boolean(env.VITEST)` だったが、`Boolean('0')` は true なので
 * `VITEST=0` でもゲートが開いてしまう（外部レビュー P2-7）。明示比較にする。
 */
function isVitest(env: NodeJS.ProcessEnv): boolean {
  return env.VITEST === '1' || env.VITEST === 'true';
}

/**
 * pty が spawn する実行ファイルを解決する。差し替え口（偽バイナリ）は
 * VITEST 中か、パスが <editorDir>/tests/fixtures/ 配下の場合のみ有効
 * （スペック「テスト方針」: テスト以外で差し替え口を有効化できない構造）。
 */
export function resolveToolForPty(
  tool: AiToolAdapter,
  editorDir: string,
  env: NodeJS.ProcessEnv,
  deps: { which?: (binName: string) => string | null } = {},
): ToolLocation | null {
  const envName = BIN_OVERRIDE_ENV[tool.id];
  const override = envName === undefined ? undefined : env[envName];
  if (override !== undefined && override !== '') {
    const fixturesDir = resolve(editorDir, 'tests', 'fixtures');
    const resolvedOverride = resolve(override);
    const insideFixtures =
      resolvedOverride === fixturesDir || resolvedOverride.startsWith(fixturesDir + sep);
    const allowed = isVitest(env) || insideFixtures;
    if (allowed) {
      // ゲート内で明示的に指定された差し替え先が無いのは「意図した not-found テスト」
      // （switchTool 等の異常系検証）であって、実システムの検出へフォールバックしてよい
      // 通常運用ではない。フォールバックすると、テスト機にたまたま本物が入っている場合に
      // 偽の成功が返り、しかも実プロセスが spawn されてしまう。
      if (!existsSync(override)) {
        // ゲート外（下記）とは別文言で警告する。SME_CLAUDE_BIN/SME_CODEX_BIN の指す先が
        // タイプミス等で存在しない場合、これが無ければ利用者には「見つかりません」としか
        // 出ず、原因（どのパスを見に行ったか）が分からない。
        console.warn(`[sme] ${envName} に指定されたパスが見つかりません:`, override);
        return null;
      }
      // .mjs は node で実行する（pty はシェバン無しスクリプトを直接 spawn できない）。
      if (override.endsWith('.mjs') || override.endsWith('.js')) {
        return { file: process.execPath, args: [resolve(override)], source: 'test-override' };
      }
      return { file: resolve(override), args: [], source: 'test-override' };
    }
    // ゲート外の差し替えは黙って無視せずログに残す（fail-open にしない・通常検出へ続行）。
    console.warn(`[sme] ${envName} はテストゲート外のため無視しました:`, override);
  }
  return findTool(tool, editorDir, deps);
}

/** `x.y.z` を最初に含む箇所を版として取り出す。 */
export function parseVersion(output: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0] ?? null;
}

/** 数値比較で actual >= min か（文字列比較だと 0.99.0 >= 0.145.0 を誤判定する）。 */
export function isVersionAtLeast(actual: string, min: string): boolean {
  const pa = actual.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pm = min.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const a = pa[i] ?? 0;
    const m = pm[i] ?? 0;
    if (a !== m) return a > m;
  }
  return true;
}

function defaultRun(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 10_000 });
}

/** checkToolVersion の実処理（キャッシュを介さない）。minVersion は呼び出し側で narrow 済み。 */
function checkToolVersionUncached(
  minVersion: string,
  loc: ToolLocation,
  run: (file: string, args: string[]) => string,
): { ok: true } | { ok: false; found: string | null } {
  try {
    const out = run(loc.file, [...loc.args, '--version']);
    const found = parseVersion(out);
    return found === null ? { ok: true } : isVersionAtLeast(found, minVersion) ? { ok: true } : { ok: false, found };
  } catch {
    return { ok: true };
  }
}

/**
 * 最低版を満たすか。`minVersion` が null のツールは `--version` を実行しない。
 * `--version` の実行や解析に失敗した場合は **ok として通す** — 版が読めないことを理由に
 * 機能を止めると、正常な環境でも起動できなくなる（fail-open を選ぶのはここが
 * 「起動可否」ではなく「親切な事前警告」の位置づけだから）。
 */
export function checkToolVersion(
  tool: AiToolAdapter,
  loc: ToolLocation,
  deps: { run?: (file: string, args: string[]) => string } = {},
): { ok: true } | { ok: false; found: string | null } {
  if (tool.minVersion === null) return { ok: true };
  const minVersion = tool.minVersion;
  // deps.run が注入されている（= テストからの差し替え）ときはキャッシュを読み書きしない。
  // findTool と同じ理由（キー未含有による混入をテストの手動 clearToolCache 頼みにしない）。
  if (deps.run !== undefined) return checkToolVersionUncached(minVersion, loc, deps.run);
  // loc（file/args/source）そのものをキーにする。managed 由来の loc.file は
  // <editorDir>/.claude-runtime/... を含むため editorDir ごとに自然に分離され、
  // global 由来は同じ実行ファイルなら editorDir をまたいで結果を共有してよい
  // （同じバイナリは同じ版を返す）。
  const key = `${tool.id}::${loc.source}::${loc.file}::${loc.args.join('\u0000')}`;
  const now = Date.now();
  const cached = versionCache.get(key);
  if (cached !== undefined && cached.expiresAt > now) return cached.value;

  const value = checkToolVersionUncached(minVersion, loc, defaultRun);
  versionCache.set(key, { value, expiresAt: now + TOOL_CACHE_TTL_MS });
  return value;
}
