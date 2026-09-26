import { createHash, type Hash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installNativeDataPack, isNativeDataPackId, nativeDataPackVersion, readNativeDataPackState } from './nativeDataPacks';
import { SequenceStore } from './sequence/store';
import { countProjectTelopClipsGainingAnimation } from './telopPackUpdate';

export type PackId = 'videoInsert' | 'telopPack' | 'bgm' | 'shape' | 'transition' | 'speed' | 'mainLayout';

export interface PackDescriptor {
  id: PackId;
  /** プロジェクト src/ 配下のパックフォルダ名。 */
  packDir: string;
  /** marker ファイル名。 */
  markerName: string;
  /** Component source only; native data packs have no runtime payload directory. */
  payloadDir?: string;
  /** 上書きしない＝版にも含めないデータファイル名。 */
  dataFiles: string[];
  /** 版・コピー対象を明示する場合（telop）。未指定なら payload 全エントリ −dataFiles −*.test.*。 */
  componentEntries?: string[];
  /** 更新すると**描画が変わる**パック。画面は更新の前に必ず説明を出す。 */
  drawingChanges?: boolean;
  /** 説明文（利用者向け。1 文）。 */
  changeNote?: string;
}

export const PACK_DESCRIPTORS: PackDescriptor[] = [
  { id: 'videoInsert', packDir: 'InsertVideo', markerName: 'insert-video.json', dataFiles: ['insertVideoData.ts'] },
  { id: 'bgm', packDir: 'Bgm', markerName: 'bgm-track.json', dataFiles: ['bgmData.ts'] },
  { id: 'shape', packDir: 'InsertShape', markerName: 'insert-shape.json', dataFiles: ['shapeData.ts'] },
  { id: 'transition', packDir: 'Transition', markerName: 'transition.json', dataFiles: ['transitionData.ts'] },
  { id: 'telopPack', packDir: 'テロップテンプレート', markerName: 'telop-pack.json', payloadDir: join(import.meta.dirname, 'telopPack'), dataFiles: [], componentEntries: ['Telop.tsx', 'styles', 'telopLegacyAnimation.ts'],
    drawingChanges: true, changeNote: 'このパックは描画が変わります（テロップに動きが付きます）。' },
  { id: 'speed', packDir: 'Speed', markerName: 'speed.json', dataFiles: [] },
  { id: 'mainLayout', packDir: 'MainLayout', markerName: 'main-layout.json', dataFiles: [] },
];

export function findDescriptor(id: PackId): PackDescriptor {
  const d = PACK_DESCRIPTORS.find((x) => x.id === id);
  if (d === undefined) throw new Error(`unknown pack id: ${id}`);
  return d;
}

/** テスト・データを除いた、版/コピー対象のトップレベルエントリ名（ソート済み）。 */
function componentPayloadDirectory(d: PackDescriptor): string {
  if (!d.payloadDir) throw new Error(`No component payload for ${d.id}`);
  return d.payloadDir;
}

function resolveComponentEntries(d: PackDescriptor): string[] {
  if (d.componentEntries !== undefined) return [...d.componentEntries].sort();
  return readdirSync(componentPayloadDirectory(d))
    .filter((e) => !d.dataFiles.includes(e) && !e.includes('.test.'))
    .sort();
}

/** path（ファイル/ディレクトリ）を決定的にハッシュへ流し込む。dir 内の *.test.* は除外。 */
function hashPath(absPath: string, relPath: string, hash: Hash): void {
  const st = statSync(absPath);
  if (st.isDirectory()) {
    for (const e of readdirSync(absPath).sort()) {
      if (e.includes('.test.')) continue;
      hashPath(join(absPath, e), `${relPath}/${e}`, hash);
    }
    return;
  }
  hash.update(relPath);
  hash.update('\0');
  hash.update(readFileSync(absPath));
  hash.update('\0');
}

/** Native data schema/definitions or, for actual components, shipped source bytes. */
export function payloadHash(d: PackDescriptor): string {
  if (isNativeDataPackId(d.id)) return nativeDataPackVersion(d.id);
  const hash = createHash('sha256');
  for (const entry of resolveComponentEntries(d)) {
    hashPath(join(componentPayloadDirectory(d), entry), entry, hash);
  }
  return hash.digest('hex').slice(0, 16);
}

export function currentPackVersion(id: PackId): string {
  return payloadHash(findDescriptor(id));
}

function markerPath(d: PackDescriptor, projectDir: string): string {
  return join(projectDir, 'src', d.packDir, d.markerName);
}

export function isPackInstalled(d: PackDescriptor, projectDir: string): boolean {
  if (isNativeDataPackId(d.id)) return ['legacy', 'stale', 'ready'].includes(readNativeDataPackState(d.id, projectDir).status);
  return existsSync(markerPath(d, projectDir));
}

function readMarkerVersion(mp: string): string | null {
  if (!existsSync(mp)) return null;
  try {
    const j = JSON.parse(readFileSync(mp, 'utf8')) as { version?: unknown };
    return typeof j.version === 'string' ? j.version : null;
  } catch {
    return null;
  }
}

export function isPackStale(d: PackDescriptor, projectDir: string): boolean {
  if (isNativeDataPackId(d.id)) {
    const state = readNativeDataPackState(d.id, projectDir);
    return state.status !== 'absent' && state.status !== 'ready';
  }
  if (!isPackInstalled(d, projectDir)) return false;
  return readMarkerVersion(markerPath(d, projectDir)) !== payloadHash(d);
}

/** Native packs preserve data/runtime sources; the telop pack refreshes actual components. */
export function upgradePack(d: PackDescriptor, projectDir: string): void {
  // stale でないなら何もしない。ここが無いと同じ id を 2 回渡されたときに 2 回目の退避が
  // **更新後の姿**で控えを作り直し、本物の「更新前」が消える（レビュー I1・再現②-b）。
  // 守りを `/api/pack-upgrade` の `checkStalePacks` だけに置かず、関数単体で閉じる。
  if (!isPackStale(d, projectDir)) return;
  if (isNativeDataPackId(d.id)) { installNativeDataPack(d.id, projectDir); return; }
  const destDir = join(projectDir, 'src', d.packDir);
  // 上書きの前に控える。`cpSync` は元へ戻せないので、ここを飛ばすと「更新前に戻す」が成立しない。
  backupPackComponents(d, projectDir, readMarkerVersion(markerPath(d, projectDir)) ?? 'unknown');
  for (const entry of resolveComponentEntries(d)) {
    cpSync(join(componentPayloadDirectory(d), entry), join(destDir, entry), { recursive: true });
  }
  const mp = markerPath(d, projectDir);
  let marker: Record<string, unknown> = {};
  if (existsSync(mp)) {
    try {
      marker = JSON.parse(readFileSync(mp, 'utf8')) as Record<string, unknown>;
    } catch {
      marker = {};
    }
  }
  marker.version = payloadHash(d);
  writeFileSync(mp, JSON.stringify(marker, null, 2), 'utf8');
}

export function checkStalePacks(projectDir: string): PackId[] {
  return PACK_DESCRIPTORS.filter((d) => isPackStale(d, projectDir)).map((d) => d.id);
}

export function upgradePacks(projectDir: string, ids: PackId[]): { upgraded: PackId[]; backups: Partial<Record<PackId, string>> } {
  const upgraded: PackId[] = [];
  const backups: Partial<Record<PackId, string>> = {};
  for (const d of PACK_DESCRIPTORS) {
    if (ids.includes(d.id) && existsSync(markerPath(d, projectDir))) {
      upgradePack(d, projectDir);
      upgraded.push(d.id);
      // **戻れる先**（＝控えの版＝更新前の版）。`payloadHash(d)` は更新**後**の版で、画面が「戻す」を
      // 出す材料にはならない（事前検査 B の F10-1）。
      const version = latestPackBackupVersion(d, projectDir);
      if (version !== null) backups[d.id] = version;
    }
  }
  return { upgraded, backups };
}

/** 案件の中のエディタ管理領域。`telop-template-backup`（telopTemplateUpdate.ts:21）と同じ場所の考え方。
 *  **常に `<root>/<packId>/<version>/` の 3 段**にする（telopPack だけ 2 段にすると、
 *  「1 世代だけ」を root 直下の件数で判定するテストが、将来 payloadDir を持つパックが増えた瞬間に
 *  誤検知で赤になる。事前検査 B の F10-2）。 */
export const PACK_BACKUP_ROOT = join('.harness', 'pack-backup');

function backupRoot(d: PackDescriptor, projectDir: string): string {
  return join(projectDir, PACK_BACKUP_ROOT, d.id);
}

/**
 * 控えフォルダに使ってよい版名。marker の `version` は案件の `telop-pack.json` の文字列そのままで、
 * 経路文字が混じると `rmSync`/`cpSync` の宛先が**控えの外**を指す（実測: `"../../../victim"` の案件を
 * 更新すると案件直下の `victim/` ごと消えた）。検査に落ちた名前は `'unknown'` に寄せ、
 * **削除・複写の宛先は検査を通った名前だけ**から組む（レビュー C2）。
 */
const SAFE_BACKUP_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function safeBackupName(version: string): string {
  // `.` と `..` は正規表現を通るが親（＝控えの外）を指すので落とす。
  if (version === '.' || version === '..') return 'unknown';
  return SAFE_BACKUP_NAME.test(version) ? version : 'unknown';
}

export function latestPackBackupVersion(d: PackDescriptor, projectDir: string): string | null {
  const root = backupRoot(d, projectDir);
  if (!existsSync(root)) return null;
  // 読み出す側でも検査済みの名前だけを見る（復元は控えの版名を `cpSync` の**元**に使う）。
  const entries = readdirSync(root).filter((name) => safeBackupName(name) === name && statSync(join(root, name)).isDirectory());
  return entries.length === 1 ? entries[0]! : (entries.sort().at(-1) ?? null);
}

/**
 * 上書きの**前に** componentEntries の現物を退避する。触るファイルだけを写し、無かったものは
 * `<name>.absent` で覚える（フォルダ全体を写すと、更新中に増えた無関係ファイルを復元で消す）。
 * 保持は直前の 1 世代だけ（裁定 8）。
 */
export function backupPackComponents(d: PackDescriptor, projectDir: string, version: string): string[] {
  // 宛先を組む前に版名を検査する（C2）。以降 `version` は使わない。
  const name = safeBackupName(version);
  const root = backupRoot(d, projectDir);
  const destination = join(root, name);
  const source = join(projectDir, 'src', d.packDir);
  if (existsSync(root)) for (const entry of readdirSync(root)) if (entry !== name) rmSync(join(root, entry), { recursive: true, force: true });
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const saved: string[] = [];
  for (const entry of resolveComponentEntries(d)) {
    const from = join(source, entry);
    if (existsSync(from)) { cpSync(from, join(destination, entry), { recursive: true }); saved.push(entry); }
    else { writeFileSync(join(destination, `${entry}.absent`), '', 'utf8'); saved.push(`${entry}.absent`); }
  }
  return saved;
}

/**
 * payload（＝更新が持ち込む側）に在って控えに無い子**だけ**を消す。更新の**後**に利用者が足した
 * ファイル（payload にも控えにも無い）は残す（レビュー C1。使い捨て案件で `styles/MyCustom.tsx` が
 * 無警告で消え、控えは更新**前**のバイトなので戻す先も無いことを実測した）。
 * `backup === null` は「控えに無い」＝ `<name>.absent` の経路。
 */
function removeUpdateAdditions(payload: string, backup: string | null, target: string): void {
  if (!existsSync(target) || !existsSync(payload)) return;
  const saved = backup !== null && existsSync(backup) ? backup : null;
  if (!statSync(payload).isDirectory() || !statSync(target).isDirectory()) {
    if (saved === null) rmSync(target, { recursive: true, force: true });
    return;
  }
  // フォルダは中を 1 段ずつ見る。控えに同名の子があるものは `cpSync` が上書きで戻すので消さない。
  for (const child of readdirSync(payload))
    removeUpdateAdditions(join(payload, child), saved === null ? null : join(saved, child), join(target, child));
  // 更新が作ったフォルダは、利用者の足したものが残っていないときだけ畳む。
  if (saved === null && readdirSync(target).length === 0) rmSync(target, { recursive: true, force: true });
}

/** 控えから戻す。`restoreFromBackup`（telopTemplateUpdate.ts:270-278）と同じ規則。 */
export function restorePackComponents(d: PackDescriptor, projectDir: string): { restored: string[]; version: string } {
  const version = latestPackBackupVersion(d, projectDir);
  if (version === null) throw new Error('backup-missing');
  const backup = join(backupRoot(d, projectDir), version);
  const target = join(projectDir, 'src', d.packDir);
  const restored: string[] = [];
  for (const entry of resolveComponentEntries(d)) {
    const absent = existsSync(join(backup, `${entry}.absent`));
    const saved = join(backup, entry);
    if (!absent && !existsSync(saved)) continue;
    // entry を丸ごと消さない。消すのは**更新が持ち込んだ子**だけで、控えに在る子は次の `cpSync` が
    // 更新前のバイトへ上書きする（`cpSync` は既存フォルダへ混ぜるので、消さずに写すだけでは
    // 更新で増えたスタイルが残り「更新前へ戻した」が嘘になる）。
    removeUpdateAdditions(join(componentPayloadDirectory(d), entry), absent ? null : saved, join(target, entry));
    if (!absent) cpSync(saved, join(target, entry), { recursive: true });
    restored.push(entry);
  }
  const mp = markerPath(d, projectDir);
  if (existsSync(mp)) {
    let marker: Record<string, unknown> = {};
    try {
      marker = JSON.parse(readFileSync(mp, 'utf8')) as Record<string, unknown>;
    } catch {
      marker = {};
    }
    // 控えの版をそのまま書き戻す。旧稿の `version === payloadHash(d) ? 'restored' : version` の
    // `'restored'` 側は**到達しない**（`version` は更新**前**の版なので、現行 payload と一致するのは
    // 「stale でないのに更新した」場合だけ）。死に分岐を置かない（事前検査 B の F10-4）。
    marker.version = version;
    writeFileSync(mp, JSON.stringify(marker, null, 2), 'utf8');
  }
  // 戻し終えたら控えを畳む（レビュー I3）。案件は更新前と同じ姿なので戻る先は要らず、
  // 残すと `revertable` が立ちっぱなしでバッジが恒久的に出る。1 世代規則（裁定 8）とも揃う。
  rmSync(join(backupRoot(d, projectDir), version), { recursive: true, force: true });
  return { restored, version };
}

export interface PackUpgradeNotice { id: PackId; note: string; gainingCount: number | null }

/**
 * 「動きを失う 0 件」ではなく**逆向き**の数（Codex P1-5）。保存済みの新形式文書から数える。
 * 数えられない案件は **null**（不明）— 推定しない。
 *
 * **系統 A（Remotion 案件）では null が既定**（事前検査 B の F10-3）。`/api/pack-upgrade` の対象は
 * `src/テロップテンプレート/` を持つ案件だが、`SequenceStore` が読むのは native の
 * `.harness/project.v2.json` なので、Remotion 運用のままの案件にはほぼ常に無い。画面は
 * 「この案件では数えられません」と**明示**する（黙って 0 を返すと「0 件」と読める報告になる）。
 */
export function packUpgradeNotices(projectDir: string, stale: PackId[]): PackUpgradeNotice[] {
  return stale.flatMap((id) => {
    const d = findDescriptor(id);
    if (d.drawingChanges !== true) return [];
    let gainingCount: number | null = null;
    try {
      // `load(): SavedSequence | null` は `{document, savedRevision, contentHash}` を返す（`store.ts:67-70`）。
      // `document.clips` を直接読むと tsc が落ちる（事前検査 B の B10-1）。
      // コンストラクタも `realpathSync` と `.harness` の形検査で throw しうる（`store.ts:39-49`）ので、
      // ここで捕まえないと `/api/pack-status` が 500 になる。
      // 母集団は **案件テンプレート由来の字幕**（レビュー I-2）。この導線が差し替えるのは
      // `src/テロップテンプレート/` のファイルなので、builtin 凍結資産を参照する字幕は何も変わらない。
      // native 3 段導線（`planTelopPackUpdate`）とは母集団が逆で、共有するのは「動き始める」判定だけ。
      const saved = new SequenceStore(projectDir).load();
      if (saved) gainingCount = countProjectTelopClipsGainingAnimation(saved.document);
    } catch { gainingCount = null; }   // 数えられないなら推定しない
    return [{ id, note: d.changeNote ?? '', gainingCount }];
  });
}
