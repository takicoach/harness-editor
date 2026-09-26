/**
 * AI ツール（claude / codex）実行ファイルの検出と版チェック。
 * **claude 専用ではない** — ツールは AiToolAdapter で渡す。
 * 探索順: (1) テスト用差し替え口 → (2) PATH 上の which/where（普段使う版を最優先）→
 * (3) 既知の置き場（~/.local/bin 等） → (4) エディタ管理ディレクトリ（.claude-runtime・
 * 自動導入対象のツールのみ） → (5) ログインシェル（最後の手段）。
 * 検出のみを担い、導入は claudeInstallJob が行う。
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { AiToolAdapter } from './aiTools';

/**
 * `execFile` を手で Promise 化する（`promisify(execFile)` は使わない）。
 * Node の `execFile` は `util.promisify.custom` を自前実装で持ち、`promisify()` は
 * それを見つけると素通しでそちらを使う — テストで `execFile` を `vi.fn` に差し替えても
 * その custom 実装は元の C++ バインディングを直接呼ぶため、呼び出しがスパイに記録されない
 * （in-flight 共有テスト等が壊れる）。コールバック形を自前でラップして必ずスパイ経由にする。
 */
function run(file: string, args: string[], opts: { encoding: 'utf8'; timeout: number }): Promise<{ stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(file, args, opts, (err, stdout) => {
      if (timer !== undefined) clearTimeout(timer);
      if (err) reject(err);
      else resolvePromise({ stdout: stdout.toString() });
    });
    // execFile の `timeout` オプションも子を kill するが、それに任せない:
    // ログインシェルが子孫プロセスを残したまま固まると callback が返らないことがある。
    // 自前の上限で必ず kill して Promise を解決させる（Important 6）。
    // SIGKILL で送る（T24 Minor）: デフォルトの SIGTERM は子が trap/無視できるため、
    // 詰まったログインシェルが上限を過ぎても生き残ることがある。execFile は options に
    // `detached` を素通ししない実装のため、プロセスグループ全体の kill はここでは
    // 実現できない（そのために spawn へ切り替えると既存の in-flight/キャッシュ検証テストが
    // execFile スパイに依存しており広範囲に壊れる）。単一プロセスの確実な終了に留める。
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 既に終了している */ }
      reject(new Error(`[sme] ${file} が ${opts.timeout}ms 以内に終わりませんでした`));
    }, opts.timeout);
  });
}

/** 1 候補あたりの上限。ログインシェルの起動まで含めてここで頭打ちにする。 */
export const CANDIDATE_TIMEOUT_MS = 3_000;

/**
 * 候補 1 件の解決に上限を掛ける。`which`/`loginShell` は注入もできる（テスト・将来の
 * 別実装）ので、上限を子プロセス側の timeout だけに頼らず findTool 側でも持つ。
 * 上限に達したら「見つからなかった」として次の段へ進む。
 */
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise((done) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; done(onTimeout); } }, ms);
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    work.then(finish, () => finish(onTimeout));
  });
}

/**
 * ツール名として受け付ける形。**外部プロセスの起動経路に入る前に**弾く（Critical 1）。
 * 現行の binName（claude / codex）は全てこの形。空白・引用符・`;`・`$` などを含む名前は
 * ログインシェル経路で意味を持ちうるため、探索そのものを行わない。
 */
const SAFE_BIN_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * binName が `..` を含まないか（T24 Minor）。SAFE_BIN_NAME の文字クラスは `.` を
 * 許すため `..` 自体は正規表現だけでは弾けない。既知の置き場は
 * `join(dir, binName)` で組み立てるため、binName が `..` を含むと親ディレクトリへ
 * 抜けて意図しない実行ファイルを候補にしうる（AI_TOOLS は固定値だが将来ツールが
 * 増える時のための防御）。
 */
function hasDotDotSegment(name: string): boolean {
  return name.split(/[\\/]/).includes('..');
}

export interface ToolLocation {
  /** spawn する実行ファイル。 */
  file: string;
  /** 実行ファイルの前置引数（.mjs 差し替え時に [スクリプトパス] が入る）。 */
  args: string[];
  /** 採用した実行ファイルの絶対パス。UI の「見つかった場所」に出す。 */
  path: string;
  source: 'test-override' | 'path' | 'known-dir' | 'managed' | 'login-shell';
}
export type ToolStatus = 'ready' | 'outdated' | 'missing' | 'unverified';

export interface FindToolOptions {
  editorDir: string;
  which?: (binName: string) => Promise<string | null>;
  knownDirs?: readonly string[];
  loginShell?: (binName: string) => Promise<string | null>;
  /**
   * プロセス内キャッシュ（TTL 5秒）を読み書きせず毎回探索する。
   * テストが「注入したから迂回されるはず」という暗黙の規約に頼らないための明示フラグ
   * （Important 7）。本番経路では使わない。
   */
  bypassCache?: boolean;
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
  return process.env.HARNESS_MANAGED_AI_DIR || join(editorDir, '.claude-runtime');
}

function managedToolPath(tool: AiToolAdapter, editorDir: string): string {
  const bin = process.platform === 'win32' ? `${tool.binName}.cmd` : tool.binName;
  return join(managedRuntimeDir(editorDir), 'node_modules', '.bin', bin);
}

/** ランチャー経由でない起動でも見つかるように、実績のある置き場を並べる（PATH の次に見る）。 */
export function knownToolDirs(env: NodeJS.ProcessEnv): string[] {
  // HOME/USERPROFILE（win32 は APPDATA）が無い環境では home 由来の候補を**作らない**。
  // join('', '.local', 'bin') は '.local/bin' という相対パスになり、起動時の cwd 配下の
  // ファイルを実行ファイル候補にしてしまう（Critical 2）。
  const home = env.HOME ?? env.USERPROFILE ?? '';
  const fromHome = (...parts: string[]): string => (home === '' ? '' : join(home, ...parts));
  const appData = env.APPDATA ?? '';
  const dirs = process.platform === 'win32'
    ? [appData === '' ? '' : join(appData, 'npm'), fromHome('AppData', 'Roaming', 'npm')]
    : [fromHome('.local', 'bin'), fromHome('.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin',
       fromHome('.npm-global', 'bin')];
  // 最後の砦: 空・相対パスは候補にしない（上の組み立てが将来増えても効く）。
  return dirs.filter(dir => dir !== '' && isAbsolute(dir));
}

/**
 * 実行可能な「ファイル」か。accessSync(X_OK) 単独だと実行ビットの立った
 * ディレクトリ（トラバース可能なだけ）も true になってしまう（T24 Minor:
 * ディレクトリを実行ファイル扱いしない）。isFile() を先に確認する。
 */
function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

/** PATH 上の実行ファイルを探す（無ければ null）。テストでは which を注入して差し替える。 */
async function defaultWhich(binName: string): Promise<string | null> {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await run(cmd, [binName], { encoding: 'utf8', timeout: CANDIDATE_TIMEOUT_MS });
    const first = stdout.split(/\r?\n/)[0]?.trim();
    return first ? first : null;
  } catch { return null; }
}

/** ログインシェルの command -v（最後の手段。起動設定まで実行するため時間上限を必ず掛ける）。 */
async function defaultLoginShell(binName: string): Promise<string | null> {
  if (process.platform === 'win32') return null;
  try {
    // binName はコマンド文字列に**補間しない**。`$1` に位置引数として渡す（`$0` はダミー）。
    // `--` も付けて、`-` 始まりの名前がオプションとして解釈されないようにする（Critical 1）。
    const { stdout } = await run(
      '/bin/zsh', ['-lc', 'command -v -- "$1"', 'sme-find-tool', binName],
      { encoding: 'utf8', timeout: CANDIDATE_TIMEOUT_MS },
    );
    const first = stdout.split(/\r?\n/)[0]?.trim();
    return first ? first : null;
  } catch { return null; }
}

/**
 * findTool / checkToolVersion のプロセス内キャッシュ TTL。
 * どちらも execFile/execFileSync（`which`/`where`・`--version`）を内部で呼び、
 * GET /api/ai/tools は毎リクエストでツールの数だけこれを呼ぶ。TTL を置くのは、
 * ユーザーが別ターミナルで手動導入した直後に反映されるようにするため
 * （プロセス再起動なしで数秒後には検出結果が追いつく）。
 */
const TOOL_CACHE_TTL_MS = 5_000;

/**
 * versionCache のキーで args を連結する区切り。実引数に現れない NUL を使う
 * （' ' だと `['a b']` と `['a','b']` が同じキーになる）。T0e で生の NUL バイトが
 * ソースに直接埋め込まれていたのをエスケープ表記へ戻した（Minor 9）。
 */
const ARG_KEY_SEP = '\u0000';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

type VersionResult = { ok: true } | { ok: false; found: string | null } | { ok: 'unverified' };

const findToolCache = new Map<string, CacheEntry<ToolLocation | null>>();
const versionCache = new Map<string, CacheEntry<VersionResult>>();
const inFlight = new Map<string, Promise<ToolLocation | null>>();
const versionInFlight = new Map<string, Promise<VersionResult>>();

/**
 * キャッシュの世代。clearToolCache() のたびに進める。
 * 走行中の探索が完了したときは「捕まえた世代 === 現在の世代」のときだけ結果を載せる。
 * そうしないと、導入完了で clear した直後に、**導入前に始まった**探索の not-found が
 * TTL いっぱいキャッシュに居座る（Important 4）。
 */
let cacheGeneration = 0;

/**
 * findTool / checkToolVersion のキャッシュを明示的に無効化する。
 * - claudeInstallJob が導入完了（exit code 0）を検知した箇所から呼ぶ（「導入したのに
 *   『入っていません』と出る」を防ぐ。TTL 満了を待たせない）。
 * - テストからも呼べるようにしてある。各テストの前後で呼ぶことで、tool.id が同じでも
 *   editorDir・loc が違う別テストの結果を誤って再利用しない。
 * - inFlight も消す。導入直後の再検出が、導入前に張られた in-flight Promise に
 *   相乗りしてしまう（古い not-found 結果を返す）のを防ぐため。
 */
export function clearToolCache(): void {
  cacheGeneration += 1;
  findToolCache.clear();
  versionCache.clear();
  inFlight.clear();
  versionInFlight.clear();
}

async function findToolUncached(tool: AiToolAdapter, opts: FindToolOptions): Promise<ToolLocation | null> {
  const which = opts.which ?? defaultWhich;
  const loginShell = opts.loginShell ?? defaultLoginShell;
  // 実在＋実行可能の検査は accessSync(X_OK) 1 回で足りる（存在しなければ同じ例外で
  // false になる。existsSync との二重 stat はしない — Minor 12）。isFile() は
  // executable() 内で先に確認する（ディレクトリを実行ファイル扱いしないため）。
  // isAbsolute も見る（T24 Minor）: which/where・注入された knownDirs/loginShell が
  // 相対パスを返した場合、resolve() は cwd 基準で絶対化してしまい、意図しない場所の
  // ファイルを「見つけた」と誤採用しうる。相対パスは候補にしない。
  const accept = (file: string | null, source: ToolLocation['source']): ToolLocation | null =>
    file !== null && file !== '' && isAbsolute(file) && executable(file)
      ? { file: resolve(file), args: [], path: resolve(file), source } : null;
  // (2) PATH。ユーザーが普段使う版を最優先する。which/where の結果も**候補にすぎない**ので
  // 他の段と同じく accept() を通す（Windows の `where` は cwd を先に見る・stale な
  // シムを返す等があり、存在しないパスを spawn すると pty が即死する — Important 3）。
  const pathResult = await withTimeout(which(tool.binName), CANDIDATE_TIMEOUT_MS, null);
  const onPath = accept(pathResult, 'path');
  if (onPath) return onPath;
  // (3) 既知の置き場。
  const bin = process.platform === 'win32' ? `${tool.binName}.cmd` : tool.binName;
  for (const dir of opts.knownDirs ?? knownToolDirs(process.env)) {
    const found = accept(join(dir, bin), 'known-dir');
    if (found) return found;
  }
  // (4) 管理ディレクトリ（自動導入の対象のみ）。
  if (tool.installPackage !== null) {
    const managed = accept(managedToolPath(tool, opts.editorDir), 'managed');
    if (managed) return managed;
  }
  // (5) ログインシェル（最後の手段）。起動設定まで実行するので必ず上限を掛ける。
  const viaLoginShell = accept(await withTimeout(loginShell(tool.binName), CANDIDATE_TIMEOUT_MS, null), 'login-shell');
  if (viaLoginShell) return viaLoginShell;
  // T24 Minor: 検出失敗（全段で見つからず）は warn しておく。「入っていない」のか
  // 「探索経路自体が壊れている」のかを、ユーザーからの問い合わせ時にログから区別できるようにする。
  console.warn(`[sme] ${tool.id}（${tool.binName}）が見つかりませんでした（PATH・既知の置き場・ログインシェルいずれも不在）`);
  return null;
}

export function findTool(tool: AiToolAdapter, opts: FindToolOptions): Promise<ToolLocation | null> {
  // Critical 1: 外部プロセスを起動する前に名前を検査する。ここで弾けば which/where も
  // ログインシェルも一切起動しない。`..` は SAFE_BIN_NAME の文字クラスだけでは弾けない
  // ため別チェックにする（T24 Minor: 候補パスに `..` を含めない）。
  if (!SAFE_BIN_NAME.test(tool.binName) || hasDotDotSegment(tool.binName)) {
    console.warn('[sme] 実行ファイル名として受け付けられない binName です:', tool.binName);
    return Promise.resolve(null);
  }
  // Important 7: キャッシュを切るのは明示フラグのときだけ（注入の有無では切らない）。
  if (opts.bypassCache === true) return findToolUncached(tool, opts);
  // editorDir をキーに含める: 管理ディレクトリ（.claude-runtime）の実体は editorDir ごとに
  // 異なるため、同じツールでも editorDir が違えば結果が違いうる。
  // 注入の有無もキーに含める: 注入結果と本番経路の結果が同じキーで混ざらないようにする
  // （Minor 14。テスト同士の混線は editorDir が毎回 mkdtemp で違うことと beforeEach の
  // clearToolCache() で断つ）。
  const injected = opts.which !== undefined || opts.loginShell !== undefined || opts.knownDirs !== undefined;
  const key = `${tool.id}::${opts.editorDir}${injected ? '::injected' : ''}`;
  const cached = findToolCache.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  const shared = inFlight.get(key);
  if (shared) return shared;
  const generation = cacheGeneration;
  const pending = findToolUncached(tool, opts)
    .then(value => {
      // 走行中に clearToolCache() が入っていたら載せない（Important 4）。
      if (cacheGeneration === generation) findToolCache.set(key, { value, expiresAt: Date.now() + TOOL_CACHE_TTL_MS });
      return value;
    })
    .finally(() => {
      // T24 Minor: 世代が進んだ時に古い in-flight を消さない。
      // clearToolCache() は inFlight.clear() で古い Promise を即座に忘れる。その直後に
      // 同じ key で新しい findTool() 呼び出しが入ると、inFlight.set(key, newPending) で
      // 新しい Promise が登録される。ここで無条件に inFlight.delete(key) すると、後から
      // 解決する「この（古い）pending」の finally が、既に新しい pending を指している
      // key のエントリごと消してしまい、以降の呼び出しが新しい in-flight に相乗りできず
      // 探索をやり直す（性能劣化・タイミング次第では二重の子プロセス起動）。
      // 「自分がまだ登録されているキー」のときだけ消す。
      if (inFlight.get(key) === pending) inFlight.delete(key);
    });
  inFlight.set(key, pending);
  return pending;
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
export async function resolveToolForPty(
  tool: AiToolAdapter,
  editorDir: string,
  env: NodeJS.ProcessEnv,
  deps: Omit<FindToolOptions, 'editorDir'> = {},
): Promise<ToolLocation | null> {
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
        return { file: process.execPath, args: [resolve(override)], path: resolve(override), source: 'test-override' };
      }
      return { file: resolve(override), args: [], path: resolve(override), source: 'test-override' };
    }
    // ゲート外の差し替えは黙って無視せずログに残す（fail-open にしない・通常検出へ続行）。
    console.warn(`[sme] ${envName} はテストゲート外のため無視しました:`, override);
  }
  return findTool(tool, { editorDir, ...deps });
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

/**
 * `--version` の上限は 10 秒（既存踏襲・Minor 13）。候補探索（3 秒）より長いのは、
 * ここで叩くのは**既に採用が決まった実行ファイル**で、初回起動時に Node のウォームアップや
 * 自動更新チェックが走りうるため。短くすると健全なツールを unverified に落としかねない。
 */
const VERSION_TIMEOUT_MS = 10_000;

async function defaultExec(file: string, args: string[]): Promise<string> {
  const { stdout } = await run(file, args, { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS });
  return stdout;
}

/** checkToolVersion の実処理（キャッシュを介さない）。minVersion は呼び出し側で narrow 済み。 */
async function checkToolVersionUncached(
  minVersion: string,
  loc: ToolLocation,
  exec: (file: string, args: string[]) => Promise<string>,
): Promise<VersionResult> {
  let out: string;
  try {
    out = await exec(loc.file, [...loc.args, '--version']);
  } catch {
    // --version の失敗は成功扱いにしない（設計 E）。
    return { ok: 'unverified' };
  }
  const found = parseVersion(out);
  if (found === null) return { ok: 'unverified' };
  return isVersionAtLeast(found, minVersion) ? { ok: true } : { ok: false, found };
}

/**
 * 最低版を満たすか。`minVersion` が null のツールは `--version` を実行しない。
 * `--version` の実行や解析に失敗した場合は `unverified` を返す（成功扱いにしない）。
 */
export function checkToolVersion(
  tool: AiToolAdapter,
  loc: ToolLocation,
  deps: {
    exec?: (file: string, args: string[]) => Promise<string>;
    /**
     * findTool と同じ意味の明示フラグ（I1）。「再確認」ボタンが TTL 5 秒の
     * キャッシュ／in-flight 共有を素通しして毎回 `--version` を叩き直すために使う。
     */
    bypassCache?: boolean;
  } = {},
): Promise<VersionResult> {
  if (tool.minVersion === null) return Promise.resolve({ ok: true });
  const minVersion = tool.minVersion;
  // deps.exec が注入されている（= テストからの差し替え）ときはキャッシュも in-flight 共有も
  // 使わない（注入内容がキーに入らないため）。
  if (deps.exec !== undefined) return checkToolVersionUncached(minVersion, loc, deps.exec);
  if (deps.bypassCache === true) return checkToolVersionUncached(minVersion, loc, defaultExec);
  // loc（file/args）そのものをキーにする。managed 由来の loc.file は
  // <editorDir>/.claude-runtime/... を含むため editorDir ごとに自然に分離され、
  // path 由来は同じ実行ファイルなら editorDir をまたいで結果を共有してよい
  // （同じバイナリは同じ版を返す）。
  const key = `${tool.id}::${loc.source}::${loc.file}::${loc.args.join(ARG_KEY_SEP)}`;
  const cached = versionCache.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  // findTool と同じ in-flight 共有。GET /api/ai/tools が同時に 2 本来ても --version は
  // 1 回（Important 5）。
  const shared = versionInFlight.get(key);
  if (shared) return shared;
  const generation = cacheGeneration;
  const pending = checkToolVersionUncached(minVersion, loc, defaultExec)
    .then(value => {
      // TTL は `--version` の**完了後**から数える。開始時刻基準だと、遅い --version の
      // 分だけ有効期間が食われる（Important 5）。
      if (cacheGeneration === generation) versionCache.set(key, { value, expiresAt: Date.now() + TOOL_CACHE_TTL_MS });
      return value;
    })
    // T24 Minor: findTool の in-flight と同じ理由で、自分がまだ登録されているときだけ消す。
    .finally(() => { if (versionInFlight.get(key) === pending) versionInFlight.delete(key); });
  versionInFlight.set(key, pending);
  return pending;
}
