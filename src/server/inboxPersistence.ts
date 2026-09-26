import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { InstructionContext, InstructionRecord, InstructionStatus } from '../shared/types';

/** 受け箱ファイルのスキーマバージョン（不一致は復元しない）。 */
const SCHEMA_VERSION = 1;

/** done/failed レコードを復元対象から外す経過時間（7日）。 */
const STALE_TERMINAL_MS = 7 * 24 * 60 * 60 * 1000;

const STATUSES: readonly InstructionStatus[] = ['pending', 'processing', 'done', 'failed'];

/** レコードがどちらの経路（専属 / グローバル）で取得されたかの内部区分。 */
export type TakenVia = 'dedicated' | 'global';

/** ディスクへ書く 1 レコード（内部 claim 情報を任意で含む）。 */
type PersistedRecord = InstructionRecord & { takenVia?: TakenVia };

/**
 * 受け箱の現在状態を `.sme-inbox.json` 形式の JSON 文字列へシリアライズする。
 * claims の takenVia は該当レコードにのみ埋め込む（processing 以外は通常持たない）。
 */
export function serializeInbox(
  records: InstructionRecord[],
  claims: ReadonlyMap<string, { takenVia: TakenVia }>,
  seq: number,
): string {
  const enriched: PersistedRecord[] = records.map((record) => {
    const claim = claims.get(record.id);
    return claim === undefined ? { ...record } : { ...record, takenVia: claim.takenVia };
  });
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, seq, records: enriched }, null, 2);
}

function isValidContext(value: unknown): value is InstructionContext {
  if (typeof value !== 'object' || value === null) return false;
  const ctx = value as Record<string, unknown>;
  if (typeof ctx.frame !== 'number' || typeof ctx.timeSec !== 'number') return false;
  if (ctx.selection === null) return true;
  if (typeof ctx.selection !== 'object' || ctx.selection === null) return false;
  const sel = ctx.selection as Record<string, unknown>;
  return typeof sel.kind === 'string' && typeof sel.id === 'string';
}

/** レコード 1 件分の構造検証。壊れているものは復元対象から静かに除外する。 */
function isValidPersistedRecord(value: unknown): value is PersistedRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '') return false;
  if (typeof r.projectId !== 'string' || r.projectId === '') return false;
  if (typeof r.projectDir !== 'string') return false;
  if (typeof r.text !== 'string') return false;
  if ((r.requestId !== undefined || r.requestCreatedAt !== undefined)
    && (typeof r.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(r.requestId)
      || !Number.isSafeInteger(r.requestCreatedAt))) return false;
  if (typeof r.status !== 'string' || !STATUSES.includes(r.status as InstructionStatus)) return false;
  if (r.reply !== null && typeof r.reply !== 'string') return false;
  if (typeof r.createdAt !== 'number' || typeof r.updatedAt !== 'number') return false;
  if (!isValidContext(r.context)) return false;
  if (r.takenVia !== undefined && r.takenVia !== 'dedicated' && r.takenVia !== 'global') return false;
  return true;
}

/**
 * `.sme-inbox.json` の内容をパースする。壊れた入力でも決して throw しない。
 * - JSON として読めない/オブジェクトでない/schemaVersion 不一致 → null（復元 0 件）。
 * - records 配列中の壊れたレコードは個別にスキップ（正常分のみ復元）。
 * - done/failed で updatedAt が nowMs から 7 日超のレコードは復元対象から除外する。
 */
export function parseInboxFile(
  text: string,
  nowMs: number,
): { seq: number; records: Array<{ record: InstructionRecord; takenVia?: TakenVia }> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== SCHEMA_VERSION) return null;
  const seq = typeof obj.seq === 'number' ? obj.seq : 0;
  const rawRecords = Array.isArray(obj.records) ? obj.records : [];

  const out: Array<{ record: InstructionRecord; takenVia?: TakenVia }> = [];
  for (const raw of rawRecords) {
    if (!isValidPersistedRecord(raw)) continue;
    if ((raw.status === 'done' || raw.status === 'failed') && nowMs - raw.updatedAt > STALE_TERMINAL_MS) {
      continue;
    }
    const { takenVia, ...record } = raw;
    out.push(takenVia === undefined ? { record } : { record, takenVia });
  }
  return { seq, records: out };
}

/**
 * pidfile ロックを取得する。既存ロックの pid が生存していれば false。
 * 生存していない（stale）場合は上書きして奪う。
 */
export function acquireInboxLock(lockPath: string): boolean {
  if (existsSync(lockPath)) {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false; // 生存中 → ロック保持中
      } catch {
        // stale lock。奪って続行。
      }
    }
  }
  writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
  return true;
}

/** pidfile ロックを解放する。存在しなくてもエラーにしない。 */
export function releaseInboxLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // 既に無い場合は無視。
  }
}
