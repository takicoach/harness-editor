#!/usr/bin/env node
/**
 * テストランがリポジトリを汚していないかを実測で検査する。
 *
 *   node scripts/check-worktree-dirt.mjs snapshot   # ラン前の状態を控える
 *   node scripts/check-worktree-dirt.mjs verify     # ラン後に汚していないか検査
 *
 * ラン前の作業ツリーが既に汚れていることはある（作業中の編集・過去の残骸）ので、
 * 「クリーンかどうか」ではなく **snapshot からの変化** を見る。
 *
 * H-2 の実測: 撮影 spec がコミット済み png を上書きし、フルスイート後に 78 件の
 * modified が出ていた。同じ形の退行（テストが追跡ファイルへ書く／残骸を残す）を
 * 機械的に止めるためのゲート。
 *
 * ## `git status` の行だけを比べると穴が開く（E-2 で塞いだ fail-open）
 *
 * 以前はここが `git status --porcelain` の**行集合の差**だけを見ていた。行は
 * 「状態コード＋パス」しか持たないので、**スナップショット時点で既に差分として
 * 載っているパスへテストが再書き込みしても、行が変わらず素通りする**。
 * 具体的には
 *   - 作業中で `M docs/reports/.../x.png` になっているファイルをテストが上書きする
 *   - 未追跡（`?? .../y.png`）の成果物をテストが別内容で書き直す
 * が「汚していない」と判定されていた。まさに H-2 で起きた事故の形（撮影 spec が
 * 既存の png を上書きする）を、作業ツリーが少し汚れているだけで見逃す。
 *
 * よって行に加えて**各パスの内容ハッシュ**を控え、
 *   - 新しく現れた差分（従来の判定）
 *   - 既にあった差分パスの**内容が変わった**（新設。上書きの検出）
 * の両方を汚染として扱う。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// 既定は本リポジトリ。テスト（scripts/checkWorktreeDirt.test.ts）は使い捨ての git リポジトリを
// 指してこのゲート自身の回帰を検証するため、環境変数で対象 root を差し替えられるようにする。
const REPO_ROOT = resolve(process.env.HARNESS_DIRT_ROOT ?? resolve(import.meta.dirname, '..'));
// 置き場は .gitignore 済みのディレクトリ（スナップショット自体が差分を生まないように）。
// 加えて、検査対象からも常に除外する（テスト用の使い捨てリポジトリでは ignore されないため）。
const SNAPSHOT_DIR_REL = '.aaa-shots';
const SNAPSHOT = join(REPO_ROOT, SNAPSHOT_DIR_REL, '.worktree-status.json');

/** `git status --porcelain -z -uall` を [{ code, path }] に解く。 */
function statusEntries() {
  const raw = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const tokens = raw.split('\0');
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '' || token.length < 4) continue;
    const code = token.slice(0, 2);
    const path = token.slice(3);
    // rename/copy は「新パス\0元パス」の 2 トークン。元パス側を読み飛ばす。
    if (code.includes('R') || code.includes('C')) i += 1;
    if (path.startsWith(`${SNAPSHOT_DIR_REL}/`)) continue;
    out.push({ code, path });
  }
  return out;
}

/** 内容ハッシュ（存在しない＝削除済みは 'ABSENT'）。 */
function hashOf(relPath) {
  const full = join(REPO_ROOT, relPath);
  try {
    if (!statSync(full).isFile()) return 'NOT-A-FILE';
    return createHash('sha256').update(readFileSync(full)).digest('hex');
  } catch {
    return 'ABSENT';
  }
}

/** 検査に使う「状態」を作る: 行集合 + パスごとの内容ハッシュ。 */
function currentState() {
  const entries = statusEntries();
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const e of entries) hashes[e.path] = hashOf(e.path);
  return { lines: entries.map((e) => `${e.code} ${e.path}`), hashes };
}

/**
 * 証拠更新ラン（`npm run shots:evidence` = AAA_UPDATE_EVIDENCE=1）だけの限定除外。
 *
 * 証拠 png の置き場は追跡下（docs/reports/aaa-screenshots/）で、このランは**そこを
 * 書き換えるために**回す。除外しないと正規の再生成手順が必ず非ゼロ終了になり、
 * 「証拠を撮り直せない」＝証拠が再検証できない状態に逆戻りする。
 *
 * 除外はこの1ディレクトリだけに閉じる（他のパスは env に関係なく汚染として落とす）。
 * 通常ランでは AAA_UPDATE_EVIDENCE が無いので、撮影 spec がここへ書けば従来どおり赤になる。
 */
const EVIDENCE_DIR_REL = 'docs/reports/aaa-screenshots/';
const EVIDENCE_UPDATE = process.env.AAA_UPDATE_EVIDENCE === '1';
function isIntentionalEvidenceWrite(path) {
  return EVIDENCE_UPDATE && path.startsWith(EVIDENCE_DIR_REL);
}

const mode = process.argv[2];

if (mode === 'snapshot') {
  mkdirSync(dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(currentState()), 'utf8');
  process.exit(0);
}

if (mode === 'verify') {
  if (!existsSync(SNAPSHOT)) {
    console.error(
      'check-worktree-dirt: スナップショットが無い。先に `node scripts/check-worktree-dirt.mjs snapshot` を実行すること。',
    );
    process.exit(2);
  }
  const before = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const beforeLines = new Set(before.lines ?? []);
  const beforeHashes = before.hashes ?? {};
  const after = currentState();

  const problems = [];
  for (const line of after.lines) {
    if (beforeLines.has(line)) continue;
    if (isIntentionalEvidenceWrite(line.slice(3))) continue;
    problems.push(`新しい差分: ${line}`);
  }
  for (const [path, hash] of Object.entries(after.hashes)) {
    const prev = beforeHashes[path];
    if (prev !== undefined && prev !== hash && !isIntentionalEvidenceWrite(path)) {
      problems.push(`既にあった差分ファイルを上書き: ${path}`);
    }
  }
  // before にしか無いパス＝ランの最中に status から消えた。突合が after 側からの片方向
  // だけだと、**ランが人の未追跡ファイルを消しても「汚していない」**と判定される
  // （消えたパスは after.lines にも after.hashes にも現れないため）。作業中のメモ・
  // 撮り置きの png が黙って消えるのはまさに止めたい事故なので、両方向で突合する。
  // 追跡ファイルが status から消えた場合（= HEAD の内容へ戻された）も同じく汚染扱いにする。
  // globalSetup の意図的な残骸掃除はスナップショットより前に済むので誤検知しない。
  for (const path of Object.keys(beforeHashes)) {
    if (path in after.hashes) continue;
    if (isIntentionalEvidenceWrite(path)) continue;
    problems.push(`ランが消した（または HEAD へ戻した）: ${path}`);
  }

  if (problems.length > 0) {
    console.error(`check-worktree-dirt: テストランが作業ツリーを ${problems.length} 件汚した:`);
    for (const line of problems.slice(0, 50)) console.error(`  ${line}`);
    if (problems.length > 50) console.error(`  ... 他 ${problems.length - 50} 件`);
    console.error(
      '\n成果物はリポジトリ外（または .gitignore 対象）へ出すこと。残骸を残すテストは afterEach で片付けること。',
    );
    process.exit(1);
  }
  console.log('check-worktree-dirt: OK（テストランによる新規の差分・上書きなし）');
  process.exit(0);
}

console.error('usage: check-worktree-dirt.mjs snapshot|verify');
process.exit(2);
