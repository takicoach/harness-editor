/**
 * codex の隔離 CODEX_HOME を用意する。
 *
 * 目的: codex には `--strict-mcp-config` 相当が無く、`-c mcp_servers={}` でも
 * ユーザーの ~/.codex/config.toml の MCP サーバーは消えない（実測）。そのため
 * CODEX_HOME をエディタ管理の空ディレクトリへ向けて分離する
 * （実測: 隔離 home + `-c` 注入で `codex mcp list` が sme-editor の 1 件だけになる）。
 *
 * ログインの引き継ぎ: CODEX_HOME は auth.json の置き場でもあるため、隔離すると
 * 再ログインを求められる。ユーザーの ~/.codex/auth.json へリンクを張って引き継ぐ
 * （実測: symlink で `auth mode: chatgpt` になり再ログイン不要）。
 * リンクが張れない環境（Windows で開発者モード無効・別ボリューム）では
 * **隔離をやめてユーザーの設定をそのまま使う** — ログイン不能（機能が丸ごと壊れる）
 * より、隔離の喪失（機能は動く・注意書きを出す）を選ぶ。黙って下げないため notes に残す。
 *
 * config.toml は作らない。MCP は毎回 `-c` で注入する（実ポートに追随させるため固定で
 * 書けない）。codex 自身が信頼判断などの状態を config.toml に書き足すのはそのまま許す。
 *
 * 重要な契約: この関数は絶対に throw しない。失敗はすべて戻り値
 * （`{ env: {}, notes: [FALLBACK_NOTE] }` または隔離継続）で表現する。
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  linkSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { PrepareResult } from './aiTools';

export interface CodexHomeDeps {
  homeDir?: () => string;
  symlink?: (target: string, path: string) => void;
  hardlink?: (target: string, path: string) => void;
}

/**
 * codex の隔離 home の置き場: `<ユーザーのホーム>/.supermovie/codex-home/<フォルダ名>-<ハッシュ>`。
 *
 * なぜエディタフォルダの外か: エディタフォルダはそのまま ZIP 圧縮して配布・共有されうる。
 * `zip -r` は既定で symlink をデリファレンスし、Finder の「圧縮」は hard link を実体化する。
 * 隔離 home がエディタフォルダの内側（旧: `<editorDir>/.codex-runtime`）にあると、そこに
 * 張った auth.json への symlink/hard link（＝オーナーの ChatGPT ログイン情報そのもの）が
 * 配布物へ実体として同梱されてしまう。エディタフォルダの外（ユーザーのホーム配下）に
 * 置けば、この事故が構造的に起きなくなる。
 *
 * なぜ editorDir ごとに分けるか: オーナーは同じ機で複数のエディタ（別ブランチの worktree
 * 等）を同時に起動する。1 か所に固定すると、状態・信頼判断・auth リンクが混ざる。
 * ディレクトリ名は「読める部分（フォルダ名）＋短いハッシュ」— 衝突を避けつつ、
 * Finder で見ても由来がわかるようにする。ハッシュは `resolve()` を通した絶対パスに
 * 対して取る（相対パス表記の違いで別ディレクトリ扱いになるのを防ぐため）。
 */
export function codexRuntimeDir(editorDir: string, deps: { homeDir?: () => string } = {}): string {
  const home = deps.homeDir?.() ?? homedir();
  const absEditorDir = resolve(editorDir);
  const hash = createHash('sha256').update(absEditorDir).digest('hex').slice(0, 8);
  return join(home, '.supermovie', 'codex-home', `${basename(absEditorDir)}-${hash}`);
}

export const FALLBACK_NOTE =
  'Codex のログイン設定を分離できなかったため、お使いの Codex 設定をそのまま使います' +
  '（他の MCP も読み込まれます）。';

/**
 * 自分（このモジュール）が張ったリンクである印。
 *
 * 当初は「マーカーファイルの有無」だけで「自分が張ったリンクだ」と判定していた。
 * しかしマーカーは「かつてここでリンクを張った」というイベントの記録でしかなく、
 * 「今そこにある auth.json が今もそのリンクである」ことは何も保証しない。
 * codex が隔離 home の中でトークンを更新する際に auth.json を新しい実ファイルと
 * して作り直すと（temp + rename）、隔離側は元の実体から切り離されるが、マーカー
 * だけは残って陳腐化する。マーカーの存在だけを見て判定すると、次回起動時に
 * 「置換してよい」と誤判定し、更新済みの新しいトークンをユーザーの古い
 * ~/.codex/auth.json へのリンクで上書きしてしまう（1回限りのリフレッシュ
 * トークン方式なら強制再ログインになりうる、安全側ではなく危険側に倒れる不具合）。
 *
 * そのため、マーカーには「今のリンクの同一性」（`lstatSync` の ino。0 になりうる
 * 環境向けに mtimeMs・size もフォールバックとして併記）を JSON 1 行で書く。
 * 判定時は、マーカーの同一性と**現在の** auth.json の同一性が一致する場合にだけ
 * 「自分が張ったリンクのまま」とみなす。一致しない・マーカーが無い・壊れている
 * 場合はすべて保護側（消さない・上書きしない）に倒す。
 */
const AUTH_LINK_MARKER = '.auth-linked';

/** `replaceAuthLink` が使う tmp ファイル名の接頭辞。起動時の残骸掃除と共有する。 */
const TMP_AUTH_FILE_PREFIX = '.auth.json.tmp-';

interface LinkIdentity {
  ino: number;
  mtimeMs: number;
  size: number;
}

function identityOf(stat: { ino: number; mtimeMs: number; size: number }): LinkIdentity {
  return { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
}

/**
 * ino が両方とも 0 でなければ ino を信頼する（同一ボリューム内で衝突しない値のため）。
 * 0 になりうる環境（一部の Windows FS）向けに mtimeMs・size のフォールバックを使う。
 */
function identitiesMatch(a: LinkIdentity, b: LinkIdentity): boolean {
  if (a.ino !== 0 && b.ino !== 0) return a.ino === b.ino;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** マーカーを読んで同一性情報を返す。読めない・壊れている場合は null（判別不能）。 */
function readMarkerIdentity(runtime: string): LinkIdentity | null {
  let raw: string;
  try {
    raw = readFileSync(join(runtime, AUTH_LINK_MARKER), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).ino === 'number' &&
      typeof (parsed as Record<string, unknown>).mtimeMs === 'number' &&
      typeof (parsed as Record<string, unknown>).size === 'number'
    ) {
      const p = parsed as LinkIdentity;
      return { ino: p.ino, mtimeMs: p.mtimeMs, size: p.size };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 隔離 home の auth.json を張り替えてよいか判定する（削除も作成もしない・判定のみ）。
 *
 * 1. 無い → 作れる。
 * 2. マーカーが読めて、その同一性情報が**現在の** auth.json と一致する →
 *    自分が張ったリンクがそのまま生きている → 置き換え可。
 * 3. それ以外（マーカーが無い・壊れている・同一性が一致しない）→ 保護側に倒す。
 *    マーカー無しの実ファイルはユーザーが隔離 home で直接ログインした資格情報かも
 *    しれないし、同一性が一致しないのは codex がリンクを実ファイルへ作り直した後
 *    かもしれない。どちらも消す・上書きするとユーザーの認証を壊しうるため、
 *    判別が付かない場合は常に「置換不可」に倒す。
 */
function canReplaceAuthLink(runtime: string): boolean {
  const authPath = join(runtime, 'auth.json');
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(authPath);
  } catch {
    return true; // 存在しない → そのまま作れる
  }
  const marker = readMarkerIdentity(runtime);
  if (!marker) return false;
  return identitiesMatch(marker, identityOf(stat));
}

/**
 * 既に自分が張った正しいリンクなら、張り直さず成功として扱う。
 *
 * rename が一時的に失敗しただけ（Windows のロック等）で、それまで機能していた
 * 隔離を捨てて警告付き降格に落ちるのは損なので、変更が不要なら何もしない。
 *
 * - symlink: 対象パスの比較で十分（symlink は常に対象ファイルの最新内容を透過的に
 *   指すため、内容の同一性まで見る必要が無い）。
 * - hard link: マーカーの同一性情報が現在の auth.json と一致し、かつ realAuth と
 *   同一実体（ino・dev が一致）であることまで確認する。realAuth 側が張り替えられた
 *   後は「自分のリンクではある（マーカーは一致する）が、もう realAuth と同じ実体では
 *   ない」ため張り直しが必要であり、ここでは true にしてはならない。
 */
function isAlreadyLinkedCorrectly(runtime: string, realAuth: string): boolean {
  const linkPath = join(runtime, 'auth.json');
  let linkStat: ReturnType<typeof lstatSync>;
  try {
    linkStat = lstatSync(linkPath);
  } catch {
    return false;
  }
  if (linkStat.isSymbolicLink()) {
    try {
      return readlinkSync(linkPath) === realAuth;
    } catch {
      return false;
    }
  }
  const marker = readMarkerIdentity(runtime);
  if (!marker || !identitiesMatch(marker, identityOf(linkStat))) return false;
  let realStat: ReturnType<typeof lstatSync>;
  try {
    realStat = lstatSync(realAuth);
  } catch {
    return false;
  }
  return (
    linkStat.ino !== 0 &&
    realStat.ino !== 0 &&
    linkStat.ino === realStat.ino &&
    linkStat.dev === realStat.dev
  );
}

/**
 * tmp に作って rename で原子的に差し替える。成功したら「今作ったこのリンクの
 * 同一性」をマーカーへ書く（symlink・hard link の両方で同じ扱い。以前は symlink
 * だと `isSymbolicLink()` 自体を証拠にしてマーカーを書かなかったが、それだと
 * codex がその後 symlink を実ファイルへ作り直した際に「マーカー無し実ファイル」
 * との判別が同一性ベースにならず不正確になるため、常にマーカーで統一する）。
 *
 * symlink → 失敗したら hardlink の順に試す。どちらも一旦 tmp パスに作ってから
 * `renameSync(tmp, linkPath)` で置き換える。先に既存リンクを消してから新規作成を
 * 試すと、両方失敗した場合に「それまで機能していた隔離リンクを失った上でフォール
 * バック」になってしまう。tmp + rename ならリンク作成そのものが失敗しても
 * `linkPath` は無傷のまま残る。
 */
function replaceAuthLink(
  runtime: string,
  realAuth: string,
  symlink: (target: string, path: string) => void,
  hardlink: (target: string, path: string) => void
): boolean {
  const linkPath = join(runtime, 'auth.json');
  const markerPath = join(runtime, AUTH_LINK_MARKER);

  const tryLink = (fn: (target: string, path: string) => void): boolean => {
    const tmpPath = join(
      runtime,
      `${TMP_AUTH_FILE_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    try {
      fn(realAuth, tmpPath);
    } catch {
      return false; // symlink: Windows で開発者モード無効だと EPERM。hardlink: 別ボリューム等で EXDEV。
    }
    try {
      renameSync(tmpPath, linkPath);
    } catch {
      // rename 自体が失敗しても呼び出し元の既存 linkPath はまだ生きている。
      // tmp だけ後始末する（失敗理由は問わず握りつぶす — 隔離 home にゴミを残さない
      // ための best-effort で、ここで例外を投げても呼び出し元は困らないため）。
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        /* best-effort のため無視 */
      }
      return false;
    }
    // マーカーには「今作ったこのリンクの同一性」を書く。書き込みに失敗すると
    // （例: 書き込んだ瞬間だけディスクフル）、次回 canReplaceAuthLink が「マーカー
    // 無しの実ファイル」＝ユーザー自身の資格情報と誤認して以後ずっと保護対象に
    // 固定されてしまう（古い資格情報が無警告で固定される劣化）。マーカーを書け
    // ないなら今回のリンク自体を諦めて undo し、失敗として返す（次回呼び出し時は
    // linkPath が存在しないので普通にやり直せる＝自己修復する）。
    let identity: LinkIdentity;
    try {
      identity = identityOf(lstatSync(linkPath));
    } catch {
      try {
        rmSync(linkPath, { force: true });
      } catch {
        /* best-effort のため無視 */
      }
      return false;
    }
    try {
      writeFileSync(markerPath, JSON.stringify(identity));
      return true;
    } catch {
      try {
        rmSync(linkPath, { force: true });
      } catch {
        /* best-effort のため無視 */
      }
      return false;
    }
  };

  if (tryLink(symlink)) return true;
  return tryLink(hardlink);
}

/**
 * リンク作成と rename の間でプロセスが落ちると、tmp（ユーザー資格情報への hard
 * link そのもの、または symlink 経由で読める内容）が隔離 home に残り続ける。
 * 次回起動時に掃除する。
 *
 * 例外は握りつぶす — 消せなくても実害は「隔離 home にゴミが残る」程度で、
 * canReplaceAuthLink・isAlreadyLinkedCorrectly は auth.json とマーカーしか
 * 見ないためこの掃除の成否には依存しない。
 */
function cleanupStaleTmpFiles(runtime: string): void {
  let entries: string[];
  try {
    entries = readdirSync(runtime);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(TMP_AUTH_FILE_PREFIX)) continue;
    try {
      rmSync(join(runtime, name), { force: true });
    } catch {
      /* best-effort のため無視（理由は上記コメントの通り） */
    }
  }
}

export function prepareCodexHome(editorDir: string, deps: CodexHomeDeps = {}): PrepareResult {
  let home: string;
  try {
    home = deps.homeDir?.() ?? homedir();
    // os.homedir() は HOME が未設定なら passwd 引き当てにフォールバックするが、
    // HOME が「空文字」に設定されている場合は throw も passwd フォールバックもせず
    // "" をそのまま返す（実測）。"" は isAbsolute() が false になる相対パスであり、
    // ここで降格しないと codexRuntimeDir が相対パスを返し、mkdirSync が
    // process.cwd()（＝配布 ZIP に含まれうるエディタフォルダ配下）に隔離 home を
    // 作ってしまう。そこで codex login すると実 auth.json がエディタフォルダ側に
    // 落ちうる＝今回の改修で潰したはずの漏洩経路が復活するため、絶対パスで
    // なければ隔離を諦めて降格する。
    if (!home || !isAbsolute(home)) return { env: {}, notes: [FALLBACK_NOTE] };
  } catch {
    // os.homedir() は HOME 未設定＋passwd 引き当て失敗などで throw しうる。
    // 「prepareCodexHome は絶対に throw しない」契約を守るためここで確実に補足する。
    return { env: {}, notes: [FALLBACK_NOTE] };
  }
  const symlink = deps.symlink ?? ((t, p) => symlinkSync(t, p));
  const hardlink = deps.hardlink ?? ((t, p) => linkSync(t, p));
  const stateHomeDir = join(home, '.supermovie');
  const codexHomeParentDir = join(stateHomeDir, 'codex-home');

  let runtime: string;
  try {
    // 同じ関数内で homedir() を2回呼んで別の値になる事故を避けるため、上で解決した
    // home をそのまま codexRuntimeDir に渡す（homedir() を再度呼ばせない）。
    // createHash/resolve/basename は現実的には throw しないが、「この関数は絶対に
    // throw しない」契約を構造で守るため、この呼び出しも try の中に入れておく。
    runtime = codexRuntimeDir(editorDir, { homeDir: () => home });
    // 0o700: 実ログイン時はここに資格情報の実ファイルが置かれる（隔離 home で
    // 直接ログインするケース）ので、~/.codex と同水準のパーミッションにする。
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
  } catch {
    return { env: {}, notes: [FALLBACK_NOTE] };
  }
  try {
    // mkdirSync の mode は「新規作成時」にしか効かない。何らかの理由で runtime が
    // 既に緩い権限（0o755 等）で存在していた場合、上の mkdirSync は成功するだけで
    // 権限は是正されない。ここで明示的に chmod して 0o700 を保証する。
    // Windows では chmod が実質無効（ACL ベースで POSIX パーミッションを解釈しない）
    // なので、失敗しても無視して隔離自体は続行する（本関数は絶対に throw しない契約）。
    chmodSync(runtime, 0o700);
  } catch {
    /* Windows 等で chmod が効かない・失敗しても隔離継続には支障ないため無視する */
  }
  // 親階層（~/.supermovie・~/.supermovie/codex-home）も同水準へ締める。
  // 実測: `mkdirSync(path, { recursive: true, mode })` は、その 1 回の呼び出しで
  // 新規作成された各階層すべてに mode を適用する（末端だけではない）。そのため
  // 初回作成時はここまでの mkdirSync だけで親も 0o700 になっている。ただし
  // 「mkdirSync の mode は新規作成時にしか効かない」という上のコメントと同じ理由が
  // 親階層にも当てはまる: どちらかが本呼び出しより前から緩い権限で存在していた
  // 場合（手動作成・将来他機能が先に触る等）は是正されない。現状 ~/.supermovie を
  // 作るコードは本モジュールのみで実害は薄いが、資格情報の置き場に連なる階層であり
  // 是正コストがほぼ0のため、leaf と同じ chmod 補正を親2階層にも適用しておく。
  try { chmodSync(codexHomeParentDir, 0o700); } catch { /* 同上 */ }
  try { chmodSync(stateHomeDir, 0o700); } catch { /* 同上 */ }

  cleanupStaleTmpFiles(runtime);

  const realAuth = join(home, '.codex', 'auth.json');
  const linkPath = join(runtime, 'auth.json');
  const markerPath = join(runtime, AUTH_LINK_MARKER);

  // 「張り替えてよいか」は realAuth の存在チェックより前に判定する。
  // ユーザーが codex logout した後（realAuth が消えた後）でも、前回張ったリンク切れの
  // symlink をここで検出して掃除できるようにするため（さもないと下の「未ログイン」
  // 分岐に入れず、リンク切れが隔離 home に居座り続ける）。
  if (!canReplaceAuthLink(runtime)) {
    // 自分が張ったリンクだと確証が持てない（マーカー無し／同一性不一致）。
    // ユーザー自身の資格情報かもしれないし、codex が作り直した最新の実ファイルかも
    // しれない。どちらであっても触らず隔離継続。
    return { env: { CODEX_HOME: runtime }, notes: [] };
  }

  if (!existsSync(realAuth)) {
    // 未ログイン。前回張ったリンクとマーカーを必ず外してから隔離継続する。
    // 外さないと、リンク切れの symlink が隔離 home に残ったまま codex がログイン結果を
    // auth.json へ書き込み、symlink を辿ってユーザーの ~/.codex/auth.json を新規作成
    // してしまう（隔離の目的に反する。再現筋: ①一度リンク成功 → ② codex logout で
    // 実ファイル削除 → ③ 再度エディタから起動、で実測確認済み）。
    try {
      rmSync(linkPath, { force: true });
    } catch {
      /* Windows でロックされていても隔離自体は続行できるので無視する */
    }
    try {
      rmSync(markerPath, { force: true });
    } catch {
      /* 同上 */
    }
    return { env: { CODEX_HOME: runtime }, notes: [] };
  }

  if (isAlreadyLinkedCorrectly(runtime, realAuth)) {
    // 既に自分の正しいリンクが張られている。張り直す必要が無いので何もしない
    // （rename が一時的に失敗しただけで機能していた隔離を捨てるのを避ける）。
    return { env: { CODEX_HOME: runtime }, notes: [] };
  }

  if (replaceAuthLink(runtime, realAuth, symlink, hardlink)) {
    return { env: { CODEX_HOME: runtime }, notes: [] };
  }
  // symlink・hardlink 両方失敗（Windows で開発者モード無効 + 別ボリューム等）。
  // 隔離を諦めてユーザーの設定をそのまま使う（ログイン不能より隔離喪失を選ぶ）。
  return { env: {}, notes: [FALLBACK_NOTE] };
}
