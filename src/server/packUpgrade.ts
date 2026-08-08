import { createHash, type Hash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TELOP_PACK } from './telopPack/manifest';

export type PackId = 'videoInsert' | 'telopPack' | 'bgm' | 'shape' | 'transition' | 'speed' | 'mainLayout';

export interface PackDescriptor {
  id: PackId;
  /** プロジェクト src/ 配下のパックフォルダ名。 */
  packDir: string;
  /** marker ファイル名。 */
  markerName: string;
  /** エディタ側ペイロードの絶対パス。 */
  payloadDir: string;
  /** 上書きしない＝版にも含めないデータファイル名。 */
  dataFiles: string[];
  /** 版・コピー対象を明示する場合（telop）。未指定なら payload 全エントリ −dataFiles −*.test.*。 */
  componentEntries?: string[];
}

export const PACK_DESCRIPTORS: PackDescriptor[] = [
  { id: 'videoInsert', packDir: 'InsertVideo', markerName: 'insert-video.json', payloadDir: join(import.meta.dirname, 'videoInsertPayload'), dataFiles: ['insertVideoData.ts'] },
  { id: 'bgm', packDir: 'Bgm', markerName: 'bgm-track.json', payloadDir: join(import.meta.dirname, 'bgmPayload'), dataFiles: ['bgmData.ts'] },
  { id: 'shape', packDir: 'InsertShape', markerName: 'insert-shape.json', payloadDir: join(import.meta.dirname, '..', 'shapePayload'), dataFiles: ['shapeData.ts'] },
  { id: 'transition', packDir: 'Transition', markerName: 'transition.json', payloadDir: join(import.meta.dirname, 'transitionPayload'), dataFiles: ['transitionData.ts'] },
  { id: 'telopPack', packDir: 'テロップテンプレート', markerName: 'telop-pack.json', payloadDir: join(import.meta.dirname, 'telopPack'), dataFiles: [], componentEntries: ['Telop.tsx', 'styles'] },
  { id: 'speed', packDir: 'Speed', markerName: 'speed.json', payloadDir: join(import.meta.dirname, 'speedPayload'), dataFiles: [] },
  { id: 'mainLayout', packDir: 'MainLayout', markerName: 'main-layout.json', payloadDir: join(import.meta.dirname, 'mainLayoutPayload'), dataFiles: [] },
];

export function findDescriptor(id: PackId): PackDescriptor {
  const d = PACK_DESCRIPTORS.find((x) => x.id === id);
  if (d === undefined) throw new Error(`unknown pack id: ${id}`);
  return d;
}

/** テスト・データを除いた、版/コピー対象のトップレベルエントリ名（ソート済み）。 */
function resolveComponentEntries(d: PackDescriptor): string[] {
  if (d.componentEntries !== undefined) return [...d.componentEntries].sort();
  return readdirSync(d.payloadDir)
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

export function payloadHash(d: PackDescriptor): string {
  const hash = createHash('sha256');
  for (const entry of resolveComponentEntries(d)) {
    hashPath(join(d.payloadDir, entry), entry, hash);
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

function readMarkerCount(mp: string): number | null {
  if (!existsSync(mp)) return null;
  try {
    const j = JSON.parse(readFileSync(mp, 'utf8')) as { count?: unknown };
    return typeof j.count === 'number' && Number.isFinite(j.count) ? j.count : null;
  } catch {
    return null;
  }
}

/**
 * telopPack で「導入済みスタイル数 > 同梱スタイル数」の縮小方向か。
 *
 * 旧 35 種パックを導入したプロジェクトに現在の同梱 3 種を上書きすると、
 * template 4..35 を指すテロップが描画側のフォールバックで 1 へ潰れる（Undo 不可）。
 * 版ハッシュだけでは「新しい版」と「減った版」を区別できないため、
 * marker が記録した件数が同梱数を上回る間は更新対象から外す。
 * 同数・増加方向（marker の件数 <= 同梱数）は従来どおり版ハッシュで判定する。
 */
function isShrinkingTelopPack(d: PackDescriptor, projectDir: string): boolean {
  if (d.id !== 'telopPack') return false;
  const installedCount = readMarkerCount(markerPath(d, projectDir));
  return installedCount !== null && installedCount > TELOP_PACK.length;
}

export function isPackStale(d: PackDescriptor, projectDir: string): boolean {
  if (!isPackInstalled(d, projectDir)) return false;
  if (isShrinkingTelopPack(d, projectDir)) return false;
  return readMarkerVersion(markerPath(d, projectDir)) !== payloadHash(d);
}

/** 部品のみ再コピー（データ保持・*.test.* 除外）＋ marker version 更新。 */
export function upgradePack(d: PackDescriptor, projectDir: string): void {
  const destDir = join(projectDir, 'src', d.packDir);
  for (const entry of resolveComponentEntries(d)) {
    cpSync(join(d.payloadDir, entry), join(destDir, entry), { recursive: true });
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
  // telopPack は marker の count を縮小判定（isShrinkingTelopPack）の材料に使う。
  // 更新後は実際に導入されている件数＝同梱数なので、ここで揃えないと marker が嘘になる。
  if (d.id === 'telopPack') marker.count = TELOP_PACK.length;
  writeFileSync(mp, JSON.stringify(marker, null, 2), 'utf8');
}

export function checkStalePacks(projectDir: string): PackId[] {
  return PACK_DESCRIPTORS.filter((d) => isPackStale(d, projectDir)).map((d) => d.id);
}

export function upgradePacks(projectDir: string, ids: PackId[]): { upgraded: PackId[] } {
  const upgraded: PackId[] = [];
  for (const d of PACK_DESCRIPTORS) {
    if (ids.includes(d.id) && isPackInstalled(d, projectDir)) {
      upgradePack(d, projectDir);
      upgraded.push(d.id);
    }
  }
  return { upgraded };
}
