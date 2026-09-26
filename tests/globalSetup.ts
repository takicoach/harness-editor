import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * フィクスチャ root に残った使い捨てプロジェクトを、**実行開始前に**掃除する。
 *
 * 各 spec は afterEach / finally で自分の一時プロジェクトを消し切る（helpers.ts の
 * removeTempProject は消せなければその場で失敗する）。それでも worker 自体が異常終了
 * （実測: フルスイート中に project-status の worker が SIGABRT）すると afterEach は
 * 動かず、残骸がフィクスチャ root に残る。残骸は**そのランでは表面化せず、後続ランの
 * ホーム一覧を汚染する**（実測: 残骸 4 件で以後のフルスイートが 5 回中 2 回赤）。
 *
 * 掃除は「前のランの後始末」に限る。消したものは必ず名前を出す — 黙って消すと
 * 「毎回残骸を出す spec」を見逃す（残骸検査を無力化しない）。
 */
const REPO = resolve(import.meta.dirname, '..');
const FIXTURES_ROOT = join(REPO, 'src/server/__fixtures__');
/** 一時プロジェクトの複製元にする「巻き戻されない」スナップショットの置き場。 */
const SNAPSHOT_ROOT = join(REPO, 'tests/.fixture-snapshot');

/**
 * フィクスチャ root 直下で「消してはいけない」ディレクトリ名を **git に問い合わせて**返す。
 *
 * 以前はここが `['sample-project', 'misaligned-project', 'golden', 'm3-transitions']` の
 * ハードコード許可リストで、リストに無いディレクトリを無条件に rmSync していた。
 * つまり**将来 git 追跡下のフィクスチャを1つ足すと、e2e を回した瞬間に作業ツリーから
 * 黙って消える**（コミット済みなら git から復元できるが、追加した直後・コミット前なら
 * 失われる）。許可リストの更新漏れは静かに壊れる＝検出できない穴なので、
 * 「追跡下かどうか」という**事実**を毎回 git から取る。
 */
export function trackedFixtureDirs(): Set<string> {
  const out = execSync('git ls-files -z -- src/server/__fixtures__', {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const dirs = new Set<string>();
  for (const path of out.split('\0')) {
    if (path === '') continue;
    // 'src/server/__fixtures__/<name>/...' の <name> だけを拾う（直下のファイルは対象外）。
    const rest = path.slice('src/server/__fixtures__/'.length);
    const slash = rest.indexOf('/');
    if (slash > 0) dirs.add(rest.slice(0, slash));
  }
  return dirs;
}

/**
 * フィクスチャ root の entries のうち「前回ランの残骸として消してよい」名前を返す（純関数）。
 * 追跡下（tracked）とドット始まりは残す。
 *
 * **fail-closed**: tracked が空集合なら例外を投げる。`git ls-files` が空を返す状況
 * （git 履歴の無いコピー・ZIP 展開・worktree の取り違え）では「残していい名前」が全滅し、
 * この関数は **sample-project ごと消す指示を返す側へ静かに退化する**
 * （旧ハードコード KEEP はそこだけは守っていた）。削除の判断材料が消えたのなら、
 * 削除しないのが安全側。判断と一緒に置く（呼び出し側の作法に依存させない）。
 */
export function disposableFixtureDirs(entries: string[], tracked: ReadonlySet<string>): string[] {
  if (tracked.size === 0) {
    throw new Error(
      '追跡下フィクスチャが 0 件です（git ls-files が空）。掃除を中止します: ' +
        '全フィクスチャを削除しかねないため、git 履歴のある作業ツリーで実行してください。',
    );
  }
  return entries.filter((name) => !name.startsWith('.') && !tracked.has(name));
}

/**
 * 共有フィクスチャ `sample-project` の **pristine スナップショット**を HEAD から作る。
 *
 * 一時プロジェクトの複製元が「実行中に書き換わる共有フィクスチャ」だと、複製が壊れる:
 * smoke.spec.ts / heavy-job-confirm.spec.ts の afterEach が
 * `git checkout -- sample-project` / `git clean -fdx sample-project` を掛けている最中に
 * 別 worker が `cpSync` すると、書き換え途中のファイルをコピーしてしまう。
 * 実測（フルスイート）: コピー先を開いたエディタが
 * 「プロジェクトを読み込めません: [telopData.ts] telopData 配列が見つかりません」で止まり、
 * `.pv-stage .__remotion-player` が 20 秒待っても出ずに赤（当たる spec は回ごとに変わる）。
 * 誰も書き換えない場所から複製すれば原理的に起こらない。
 *
 * 中身は HEAD（＝afterEach の git checkout が戻す先）と同じにする。
 * フィクスチャを変えたら e2e の前にコミットする、という既存の規約と一致する。
 */
function makePristineSnapshot(): void {
  rmSync(SNAPSHOT_ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  mkdirSync(SNAPSHOT_ROOT, { recursive: true });
  execSync(
    `git archive HEAD src/server/__fixtures__/sample-project | tar -x -C "${SNAPSHOT_ROOT}"`,
    { cwd: REPO, stdio: 'ignore' },
  );
  const dir = join(SNAPSHOT_ROOT, 'src/server/__fixtures__/sample-project');
  if (!existsSync(join(dir, 'src'))) {
    throw new Error(`pristine スナップショットの作成に失敗しました: ${dir}`);
  }
}

/** 残骸の中身を浅く列挙する（診断用・深さ2まで）。 */
function listFilesShallow(dir: string, depth = 2, prefix = ''): string[] {
  if (depth === 0) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...listFilesShallow(full, depth - 1, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

/**
 * 作業ツリー汚染ゲート（scripts/check-worktree-dirt.mjs）のスナップショットを取る。
 *
 * E-2 で塞いだ穴: このゲートは `npm run test:e2e:isolated` にしか結線されておらず、
 * ゴールプロンプト §5 が指定する素の
 *   `npx playwright test --config playwright.isolated.config.ts`
 * では**走らなかった**。規定の実行経路で検査が存在しない＝典型的な fail-open なので、
 * playwright 設定そのもの（globalSetup / globalTeardown）へ結線し、どの起動経路でも走らせる。
 */
function snapshotWorktree(): void {
  execFileSync(process.execPath, [join(REPO, 'scripts/check-worktree-dirt.mjs'), 'snapshot'], {
    cwd: REPO,
    stdio: 'inherit',
  });
}

export default function globalSetup(): void {
  makePristineSnapshot();
  let entries: string[] = [];
  try {
    entries = readdirSync(FIXTURES_ROOT);
  } catch {
    // フィクスチャ root が無い（掃除するものが無い）。汚染スナップショットは必ず取る。
    entries = [];
  }
  const tracked = trackedFixtureDirs();
  for (const name of disposableFixtureDirs(entries, tracked)) {
    const dir = join(FIXTURES_ROOT, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    // 何が残っていたかまで出す。「誰が afterEach の後に書き戻したか」の手掛かりになる
    // （名前だけだと、残骸を出す spec を特定できないまま毎回黙って消えてしまう）。
    const inside = listFilesShallow(dir).slice(0, 8).join(' ');
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    console.warn(`[e2e] 前回ランの残骸を削除しました: src/server/__fixtures__/${name} [${inside}]`);
  }
  // 掃除まで済ませてからスナップショットを取る（掃除自体を「ランが汚した」と読ませない）。
  snapshotWorktree();
}
