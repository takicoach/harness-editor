// src/server/trashStore.ts
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './http';
import { isContained } from './projectRoot';

/**
 * ゴミ箱方式の削除（設計書 Phase 1 ④）。
 * - 素材: <project>/.trash/、プロジェクト: <root>/.trash/ に UUID tombstone として保持
 * - trash-manifest.json に元パス・種別・削除日時を記録（復元可能性の正本）
 * - 移動は renameSync（同一ボリューム内の原子的 rename。アップロード一時ファイルと同方式）
 * - symlink は削除対象外（外部実体の誤削除防止 — Codex レビュー P1 対応）
 */
export const TRASH_DIR = '.trash';
const MANIFEST = 'trash-manifest.json';

/** manifest の読み取り上限（巨大ファイルによる DoS 防止）。 */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export interface TrashEntry {
  /** UUID。tombstone ディレクトリ名。 */
  id: string;
  /** 'se' | 'image' | 'bgm' | 'video' | 'project'。 */
  kind: string;
  /** 表示名（元のベース名）。 */
  name: string;
  /** baseDir からの相対の元パス（復元先）。 */
  originalPath: string;
  /** ISO 8601 削除日時。 */
  deletedAt: string;
}

interface TrashManifest {
  version: 1;
  entries: TrashEntry[];
}

function manifestPath(baseDir: string): string {
  return join(baseDir, TRASH_DIR, MANIFEST);
}

/** tombstone ディレクトリ名に使える id（randomUUID の形）だけを許す。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * クライアントから来た entryId が tombstone 名として扱える形か。
 * 検証は manifest を引く前段で使う（他経路が UUID 判定を再実装しないための正本）。
 */
export function isTrashEntryId(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * manifest の 1 entry を検証する。manifest は .trash 配下の JSON で、
 * 手で編集される・別プロセスに書かれる・バックアップから戻される可能性がある。
 * その値をそのまま rmSync(recursive) / renameSync のパスに使うと baseDir 外を
 * 壊せてしまうため、読み込み時点で「安全に扱える形」だけを通す
 * （通らない entry は例外にせず一覧から落とす — 1 件の破損でゴミ箱全体を使えなくしない）。
 */
export function isValidTrashEntry(baseDir: string, value: unknown): value is TrashEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e['id'] !== 'string' || !UUID_RE.test(e['id'])) return false;
  if (typeof e['kind'] !== 'string' || e['kind'] === '') return false;
  // name は tombstone 直下のファイル名。パス区切りを含めば別階層へ書き出せてしまう。
  if (typeof e['name'] !== 'string' || e['name'] === '' || basename(e['name']) !== e['name']) {
    return false;
  }
  const orig = e['originalPath'];
  if (typeof orig !== 'string' || orig === '' || isAbsolute(orig)) return false;
  if (orig.split(/[\\/]/).includes('..')) return false;
  if (!isContained(resolve(baseDir, orig), resolve(baseDir))) return false;
  if (typeof e['deletedAt'] !== 'string' || Number.isNaN(Date.parse(e['deletedAt']))) return false;
  return true;
}

function readManifest(baseDir: string): TrashManifest {
  try {
    const path = manifestPath(baseDir);
    // FIFO・ディレクトリ・巨大ファイルを readFileSync に渡すと恒久ブロック / DoS になる。
    // 姉妹経路（projectSteps・scanProjects・materialUsage）と同じガードをここにも一貫適用する。
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return { version: 1, entries: [] };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as TrashManifest).entries)
    ) {
      const raw = (parsed as { entries: unknown[] }).entries;
      const entries = raw.filter((e): e is TrashEntry => isValidTrashEntry(baseDir, e));
      // 検証落ちは一覧から黙って消える（実体は .trash に残る）。原因調査の手掛かりが
      // 何も無いと「削除したはずの素材がゴミ箱にも無い」の切り分けができないので件数を出す。
      // 正常時は鳴らさない（正常時に鳴る警告は本当の異常のとき無視される）。
      if (entries.length < raw.length) {
        console.warn(
          `[sme] ゴミ箱の記録 ${raw.length - entries.length} 件を検証で除外しました（${manifestPath(baseDir)}）`,
        );
      }
      return { version: 1, entries };
    }
  } catch {
    // 不在・破損は空 manifest 扱い（エディタは落とさない）。
  }
  return { version: 1, entries: [] };
}

/**
 * 契約: readManifest → 変更 → writeManifest の間に await を挟んではならない。
 * これらは同期 API のみで組んであり、「読んだ後に他のリクエストが書いた分」を
 * 取りこぼさないのは「読み書きの間に他のタスクへ制御が渡らない」ことに依存している。
 * 途中に await（fs/promises・fetch 等）を入れると Node のイベントループが他の
 * ハンドラを走らせ、後勝ちで entry が消える（削除したはずの素材がゴミ箱に無い）。
 */
function writeManifest(baseDir: string, m: TrashManifest): void {
  mkdirSync(join(baseDir, TRASH_DIR), { recursive: true });
  // 書き込み途中のクラッシュで manifest を壊さないよう tmp → rename（原子的）。
  const tmp = manifestPath(baseDir) + '.tmp';
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, manifestPath(baseDir));
  } catch (e) {
    // 差し替えに失敗したら書きかけの .tmp を残さない（次回の書き込みで混乱させない）。
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** ゴミ箱一覧（削除日時降順）。 */
export function listTrash(baseDir: string): TrashEntry[] {
  return [...readManifest(baseDir).entries].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/** 封じ込め違反のメッセージに使う操作名。経路ごとに文言を分ける（再レビュー M-1）。 */
type ContainmentVerb = '削除' | '復元';

/**
 * 対象の親ディレクトリ（実体）が baseDir（実体）配下にあることを確かめる。
 * verb は利用者へ返す文言だけを切り替える（削除経路で「復元できません」と出さない）。
 */
function assertParentContained(
  baseDir: string,
  abs: string,
  relPath: string,
  verb: ContainmentVerb,
): void {
  let realParent: string;
  let realBase: string;
  try {
    realParent = realpathSync(dirname(abs));
    realBase = realpathSync(baseDir);
  } catch {
    throw new HttpError(400, `不正なパスです: ${relPath}`);
  }
  if (!isContained(realParent, realBase)) {
    throw new HttpError(400, `プロジェクトの外を指すパスは${verb}できません: ${relPath}`);
  }
}

/**
 * destDir の「実在する最上位の祖先」の実体が baseDir 配下かを確かめる（再レビュー M-2）。
 * 復元先が未作成のとき、封じ込め検査を mkdirSync より後ろに置くと「弾いたのに
 * 外部 symlink の先へ空ディレクトリが生えている」状態になる。realpath は実在する
 * パスにしか掛けられないので、実在する所まで遡って検査する
 * （その祖先が baseDir 配下なら、そこから下へ普通のディレクトリを作る限り外へは出ない）。
 */
function assertNewDirContained(baseDir: string, destDir: string, relPath: string): void {
  let cur = resolve(destDir);
  for (;;) {
    if (existsSync(cur)) break;
    const parent = dirname(cur);
    if (parent === cur) break; // ルートまで遡っても実在しない（通常は起きない）
    cur = parent;
  }
  let realCur: string;
  let realBase: string;
  try {
    realCur = realpathSync(cur);
    realBase = realpathSync(baseDir);
  } catch {
    throw new HttpError(400, `不正なパスです: ${relPath}`);
  }
  if (!isContained(realCur, realBase)) {
    throw new HttpError(400, `プロジェクトの外を指すパスは復元できません: ${relPath}`);
  }
}

/** baseDir/relPath を .trash/<uuid>/<basename> へ原子的 rename で移動する。 */
export function moveToTrash(baseDir: string, relPath: string, kind: string): TrashEntry {
  const abs = join(baseDir, relPath);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new HttpError(404, `対象が見つかりません: ${relPath}`);
  }
  if (st.isSymbolicLink()) {
    throw new HttpError(400, 'リンク取り込みされた素材は削除できません（外部の実体を守るため）');
  }
  // 末端の lstat だけでは「親ディレクトリが symlink」を検出できない
  // （例: public/BGM が外部フォルダへの symlink なら public/BGM/x.mp3 は symlink ではない）。
  // 親の実体が baseDir 配下にあることを rename 前に確かめる（HTTP 層の
  // resolvePublicAsset と同じ realpath 封じ込めの二重防御）。
  assertParentContained(baseDir, abs, relPath, '削除');
  // 移動先（.trash）自体が外部への symlink だと、下の mkdirSync + renameSync が
  // **データをプロジェクト外へ持ち出す**。削除（emptyTrash）・掃除（sweep）と同じ
  // 入口ガードを移動経路にも通す（ガードの 3 経路目・Codex レビュー P1）。
  assertTrashDirNotSymlink(baseDir);
  const id = randomUUID();
  const tombstone = join(baseDir, TRASH_DIR, id);
  mkdirSync(tombstone, { recursive: true });
  try {
    renameSync(abs, join(tombstone, basename(relPath)));
  } catch (e) {
    // rename が失敗（自分自身への移動・別ボリューム・権限）した場合、作りかけの
    // tombstone を残すとゴミ箱に空ディレクトリが溜まり続ける。作った分だけ巻き戻す。
    rmSync(tombstone, { recursive: true, force: true });
    throw new HttpError(500, `削除に失敗しました: ${relPath}（${(e as Error).message}）`);
  }
  const entry: TrashEntry = {
    id,
    kind,
    name: basename(relPath),
    originalPath: relPath,
    deletedAt: new Date().toISOString(),
  };
  const m = readManifest(baseDir);
  m.entries.push(entry);
  try {
    writeManifest(baseDir, m);
  } catch (e) {
    // 逆側の部分失敗: 実体は移動済みなのに記録が残らない状態（＝ゴミ箱にも元の場所にも
    // 見えない素材）を作らない。rename を巻き戻してから失敗を返す。
    try {
      renameSync(join(tombstone, basename(relPath)), abs);
      rmSync(tombstone, { recursive: true, force: true });
    } catch {
      // 巻き戻し自体が失敗した場合は tombstone に実体が残る（ゴミ箱一覧には出ないが
      // ファイルは消えていない）。利用者に伝えるため下でエラーにする。
    }
    throw new HttpError(500, `削除の記録に失敗しました: ${relPath}（${(e as Error).message}）`);
  }
  return entry;
}

/** 同名衝突時に name-2.ext, name-3.ext … を選ぶ（uploadMaterial の連番規則と同一）。 */
function uniqueRestoreName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  throw new HttpError(409, `同名ファイルが多すぎて復元できません: ${name}`);
}

/**
 * 復元先が symlink なら外す（実体ではなくリンクだけを消す）。
 * 外したときは**リンク先を返す** — 復元を巻き戻すとき同じリンクを張り直すため。
 * リンクでない・何も無い場合は null（既存ファイルは絶対に消さない — 連番で逃げる）。
 */
function removeLinkAtRestorePath(destDir: string, name: string): string | null {
  const dest = join(destDir, name);
  let target: string;
  try {
    if (!lstatSync(dest).isSymbolicLink()) return null;
    target = readlinkSync(dest);
  } catch {
    return null; // 何も無い＝そのまま元の名前で戻せる
  }
  rmSync(dest, { force: true });
  return target;
}

/** tombstone から元パスへ復元する。同名衝突は -2 連番、復元先ディレクトリ消失は再作成。 */
export function restoreFromTrash(baseDir: string, entryId: string): { restoredPath: string } {
  const m = readManifest(baseDir);
  const entry = m.entries.find((e) => e.id === entryId);
  if (entry === undefined) throw new HttpError(404, `ゴミ箱に見つかりません: ${entryId}`);
  const stored = join(baseDir, TRASH_DIR, entry.id, entry.name);
  if (!existsSync(stored)) throw new HttpError(404, `ゴミ箱の実体が見つかりません: ${entry.name}`);
  const destDirRel = dirname(entry.originalPath);
  const destDir = join(baseDir, destDirRel);
  // readManifest の検証を通った entry のみが手に入るはずだが、復元は「書き込み先を
  // 決める」操作なので、実際に mkdir/rename する直前にもう一度封じ込めを確かめる
  // （検証と使用の間に条件が変わらないことを、検証側の実装に依存せず担保する）。
  if (!isContained(resolve(destDir), resolve(baseDir))) {
    throw new HttpError(400, `復元先が不正です: ${entry.originalPath}`);
  }
  // 字面（resolve）の包含検査は「途中のディレクトリが外を指す symlink」を見抜けない。
  // 削除後に元の場所が symlink へすり替えられていると、rename が baseDir 外へ着地する。
  // realpath 検査を二段で掛ける（再レビュー M-2）:
  //   ① mkdir の前 — 実在する最上位の祖先で検査する。後段だけだと、弾く前に mkdirSync が
  //      外部 symlink の先へ空ディレクトリを作ってしまう（弾いたのに副作用が残る）。
  //   ② mkdir の後 — **削除側と同じヘルパー**で復元先そのものを検査する（破壊的な
  //      書き込み経路ごとに検査を再実装しない・再レビュー M-1）。①が通っても、その後に
  //      destDir 自身が symlink として実在していた場合はここで落ちる。
  assertNewDirContained(baseDir, destDir, entry.originalPath);
  mkdirSync(destDir, { recursive: true });
  assertParentContained(baseDir, join(baseDir, entry.originalPath), entry.originalPath, '復元');
  // 動画の復元先に symlink が居座っている＝リンク化のあとで元のコピーを戻す操作（I-2）。
  // 連番で逃げると main-2.mp4 になり videoConfig.ts と食い違って**リンク切れが直らない**。
  // symlink を外して元の名前で戻し、リンク記録も消して「コピー実体のプロジェクト」へ揃える。
  // 消すのはリンク（実体ではない）だけ。外付けの原本には触れない。
  const replacedLinkTarget =
    entry.kind === 'video' ? removeLinkAtRestorePath(destDir, entry.name) : null;
  const name = uniqueRestoreName(destDir, entry.name);
  const restoredAbs = join(destDir, name);
  renameSync(stored, restoredAbs);

  // **manifest を先にコミットする**（Codex レビュー P2）。tombstone の削除を先に済ませて
  // しまうと、その後の writeManifest が失敗したときに「実体は復元済みなのに manifest には
  // 古い entry が残る」状態が固定される。以後の復元試行は tombstone を見に行って
  // 「ゴミ箱の実体が見つかりません」となり、一覧から消すこともできず**恒久に壊れる**。
  // 記録を先に確定させ、失敗したら rename を巻き戻して「無かったこと」にする。
  try {
    writeManifest(baseDir, { ...m, entries: m.entries.filter((e) => e.id !== entryId) });
  } catch (e) {
    try {
      renameSync(restoredAbs, stored);
      // 外したリンクも張り直す（巻き戻し後の状態を呼び出し前と同じにする）。
      if (replacedLinkTarget !== null) symlinkSync(replacedLinkTarget, join(destDir, entry.name));
    } catch {
      // 巻き戻し自体が失敗した場合は実体が復元先に残る（記録も残るので一覧には
      // 出たままになるが、ファイルは失われていない）。下のエラーで利用者へ伝える。
    }
    throw new HttpError(
      500,
      `復元の記録に失敗しました: ${entry.originalPath}（${(e as Error).message}）`,
    );
  }

  // ここから先は後片付け。記録は確定済みなので、失敗しても復元は成立している。
  // 残った tombstone は孤児として sweepOrphanTombstones（「空にする」）が回収する。
  if (replacedLinkTarget !== null) rmSync(join(baseDir, '.sme', 'videoLink.json'), { force: true });
  try {
    rmSync(join(baseDir, TRASH_DIR, entry.id), { recursive: true, force: true });
  } catch (e) {
    console.warn(`[sme] 復元後のゴミ箱の残骸を削除できませんでした: ${entry.id}`, e);
  }
  return { restoredPath: destDirRel === '.' ? name : join(destDirRel, name) };
}

/**
 * manifest から参照されていない tombstone ディレクトリを掃除する（孤児回収・再レビュー M-3）。
 * 孤児は manifest の保存失敗・手で編集された manifest・検証落ち entry の除外で生まれ、
 * 一覧に出ないため利用者はどう操作しても消せずディスクを食い続ける。
 * 「空にする（全件）」だけの掃除に限定し、消すのは **UUID 形式の名前を持つディレクトリ**
 * のみ（第三者が .trash 直下へ置いたファイル・manifest 自体は触らない）。
 */
/**
 * `.trash` 自体が symlink でないことを確かめる。
 *
 * .trash が外部への symlink だと、その中身は baseDir 外の実体になる。tombstone は
 * 名前が UUID 形式というだけで recursive 削除するので、この検査を通さないと
 * **外部フォルダごと消える**。個々の tombstone の lstat は .trash 自身を見ていないため、
 * 破壊的な経路の入口で必ずここを通す（移動・削除・掃除の 3 経路）。
 *
 * 戻り値: `'ok'`（symlink でない）/ `'missing'`（.trash が無い）/ `'symlink'`（違反）。
 */
function inspectTrashDir(baseDir: string): 'ok' | 'missing' | 'symlink' {
  try {
    return lstatSync(join(baseDir, TRASH_DIR)).isSymbolicLink() ? 'symlink' : 'ok';
  } catch {
    return 'missing';
  }
}

/**
 * 破壊的経路の入口ガード。`.trash` が symlink なら拒否する。
 * `.trash` が無いのは正常（まだ何も捨てていない）なので通す。
 */
function assertTrashDirNotSymlink(baseDir: string): void {
  if (inspectTrashDir(baseDir) === 'symlink') {
    throw new HttpError(400, 'ゴミ箱がプロジェクトの外を指しているため操作できません');
  }
}

function sweepOrphanTombstones(baseDir: string): void {
  const dir = join(baseDir, TRASH_DIR);
  // 掃除は「空にする（全件）」のついでなので、違反や不在では黙って何もしない
  // （呼び出し元の emptyTrash が既に assertTrashDirNotSymlink を通している）。
  if (inspectTrashDir(baseDir) !== 'ok') return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!UUID_RE.test(name)) continue;
    const target = join(dir, name);
    try {
      if (!lstatSync(target).isDirectory()) continue; // symlink・ファイルは触らない
      rmSync(target, { recursive: true, force: true });
    } catch (e) {
      // 1 件の失敗で「空にする」全体を落とさない。ただし黙って握り潰すと
      // 「空にしたのに減らない」の原因が何も残らないので警告だけ出す。
      console.warn(`[sme] ゴミ箱の残骸を削除できませんでした: ${target}`, e);
    }
  }
}

/** 完全削除。entryId 指定で1件、省略で全件。 */
export function emptyTrash(baseDir: string, entryId?: string): { removed: number } {
  // 単件経路（entryId 指定）も全件経路と同じ入口ガードを通す。単件でも削除は
  // `.trash/<uuid>` の recursive rm なので、.trash が外部 symlink なら被害は同じ。
  assertTrashDirNotSymlink(baseDir);
  const m = readManifest(baseDir);
  const targets = entryId === undefined ? m.entries : m.entries.filter((e) => e.id === entryId);
  if (entryId !== undefined && targets.length === 0) {
    throw new HttpError(404, `ゴミ箱に見つかりません: ${entryId}`);
  }
  // **manifest を先にコミットする**（復元と同じ規約）。tombstone を先に消してしまうと、
  // その後 writeManifest が失敗したときに「実体は消えたのに記録だけ残る」ゴースト entry
  // ができる。一覧には出るが復元は必ず「ゴミ箱の実体が見つかりません」で失敗し、
  // 利用者はその行をどうやっても消せない。
  // ここで失敗した場合はまだ何も消していないので、巻き戻しは要らない（そのまま throw）。
  writeManifest(baseDir, {
    ...m,
    entries: entryId === undefined ? [] : m.entries.filter((e) => e.id !== entryId),
  });

  // ここから先は後片付け。記録は確定済みなので、失敗しても「空にした」ことは成立している。
  // 消せなかった tombstone は孤児として次回の sweepOrphanTombstones が回収する。
  for (const e of targets) {
    try {
      rmSync(join(baseDir, TRASH_DIR, e.id), { recursive: true, force: true });
    } catch (err) {
      console.warn(`[sme] ゴミ箱の実体を削除できませんでした: ${e.id}`, err);
    }
  }
  if (entryId === undefined) sweepOrphanTombstones(baseDir);
  // removed は「一覧に出ていた件数」＝利用者が見ていた数。孤児は数に入れない
  // （見えていなかったものを足すと「2 件のはずが 3 件削除」と食い違う）。
  return { removed: targets.length };
}
