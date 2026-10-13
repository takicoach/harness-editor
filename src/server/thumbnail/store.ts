import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SequenceError } from '../../core/sequence/errors';
import type { ThumbnailDocument } from '../../core/thumbnail/model';
import { parseThumbnail, serializeThumbnail, thumbnailContentBytes } from '../../core/thumbnail/validate';

export const THUMBNAIL_FILE = 'thumbnail.v1.json';
export const THUMBNAIL_BACKUP_FILE = 'thumbnail.v1.bak.json';
export const THUMBNAIL_LOCK_FILE = 'thumbnail.save.lock';
/** 保存は数十ミリ秒。pid が生きていてもこれより古いロックは持ち主不在とみなす。 */
const LOCK_MAX_AGE_MS = 5 * 60_000;
interface SavedReceipt { executionId: string; requestHash: string; savedRevision: number; contentHash: string }
interface StoredThumbnail { format: 'harness-thumbnail'; version: 1; document: ThumbnailDocument; receipts: SavedReceipt[] }
export interface SaveThumbnailRequest { expectedSavedRevision: number | null; executionId: string; document: ThumbnailDocument }
export interface SavedThumbnail { document: ThumbnailDocument; contentHash: string; savedRevision: number }
export interface SaveThumbnailResult extends SavedThumbnail { replayed: boolean; appliedRevision: number }
export type ThumbnailLoad = { kind: 'missing' } | { kind: 'ok'; saved: SavedThumbnail } | { kind: 'broken'; preservedFile: string };
type RawRead = { kind: 'missing' } | { kind: 'ok'; stored: StoredThumbnail; raw: string } | { kind: 'broken'; preservedFile: string };

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export const thumbnailContentHash = (document: ThumbnailDocument): string => hash(thumbnailContentBytes(document));
const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');
function conflict(message: string): never { throw new SequenceError('REVISION_CONFLICT', message); }
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
function parseStored(raw: string): StoredThumbnail {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('サムネの保存形式が不正です');
  const data = value as Partial<StoredThumbnail>;
  if (data.format !== 'harness-thumbnail' || data.version !== 1 || !Array.isArray(data.receipts)) throw new Error('サムネの保存形式が不正です');
  const document = parseThumbnail(JSON.stringify(data.document));
  if (data.receipts.length > 64 || data.receipts.some(receipt => !receipt || typeof receipt !== 'object' || typeof receipt.executionId !== 'string'
    || !/^[a-f0-9]{64}$/.test(String(receipt.requestHash)) || !/^[a-f0-9]{64}$/.test(String(receipt.contentHash))
    || !Number.isSafeInteger(receipt.savedRevision) || receipt.savedRevision < 0 || receipt.savedRevision > document.revision)
    || new Set(data.receipts.map(receipt => receipt.executionId)).size !== data.receipts.length) throw new Error('保存処理の記録が不正です');
  return { format: 'harness-thumbnail', version: 1, document, receipts: data.receipts };
}

/** 呼び出し側が許可済みの案件フォルダーを渡す。クライアントのパスは受け取らない。 */
export class ThumbnailStore {
  readonly projectDirectory: string;
  readonly directory: string;
  readonly file: string;
  readonly backupFile: string;
  readonly lockFile: string;
  constructor(projectDirectory: string) {
    this.projectDirectory = realpathSync(projectDirectory);
    this.directory = join(this.projectDirectory, '.harness');
    this.file = join(this.directory, THUMBNAIL_FILE);
    this.backupFile = join(this.directory, THUMBNAIL_BACKUP_FILE);
    this.lockFile = join(this.directory, THUMBNAIL_LOCK_FILE);
    this.assertDirectory();
  }
  private assertDirectory(): void {
    if (!existsSync(this.directory)) return;
    const info = lstatSync(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('サムネの保存先が通常のフォルダーではありません');
  }
  /** 壊れていたら thumbnail.v1.broken-<日時>.json に改名して保全する（消さない・上書きしない）。 */
  private read(): RawRead {
    this.assertDirectory();
    if (!existsSync(this.file)) return { kind: 'missing' };
    const info = lstatSync(this.file);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 * 1024) {
      const raw = readFileSync(this.file, 'utf8');
      try { return { kind: 'ok', stored: parseStored(raw), raw }; } catch { /* 下で保全する */ }
    }
    const preservedFile = `thumbnail.v1.broken-${stamp()}.json`;
    renameSync(this.file, join(this.directory, preservedFile));
    return { kind: 'broken', preservedFile };
  }
  load(): ThumbnailLoad {
    const current = this.read();
    if (current.kind !== 'ok') return current;
    const document = current.stored.document;
    return { kind: 'ok', saved: { document, savedRevision: document.revision, contentHash: thumbnailContentHash(document) } };
  }
  brokenFiles(): string[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter(name => /^thumbnail\.v1\.broken-.+\.json$/.test(name)).sort();
  }
  hasBackup(): boolean {
    try { parseStored(readFileSync(this.backupFile, 'utf8')); return true; } catch { return false; }
  }
  save(request: SaveThumbnailRequest): SaveThumbnailResult {
    // ロックを取る前に検証・複製する。不正な要求で保存済みの状態を変えない。
    const document = parseThumbnail(serializeThumbnail(request.document));
    if (typeof request.executionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.executionId)
      || (request.expectedSavedRevision !== null && (!Number.isSafeInteger(request.expectedSavedRevision) || request.expectedSavedRevision < 0))) conflict('保存要求の版または実行IDが不正です');
    const contentHash = thumbnailContentHash(document), requestHash = hash(JSON.stringify([request.expectedSavedRevision, document.revision, contentHash]));
    this.assertDirectory(); mkdirSync(this.directory, { recursive: true });
    const lock = this.acquireLock();
    let temporary: string | undefined;
    try {
      const previous = this.read();
      if (previous.kind === 'broken') conflict(`保存済みのサムネが壊れていたため ${previous.preservedFile} として保全しました。読み直してください`);
      const stored = previous.kind === 'ok' ? previous.stored : null;
      const replay = stored?.receipts.find(receipt => receipt.executionId === request.executionId);
      if (replay) {
        if (replay.requestHash !== requestHash) conflict('同じ保存IDに異なる内容があります');
        return { document: structuredClone(stored!.document), contentHash: thumbnailContentHash(stored!.document), savedRevision: stored!.document.revision,
          appliedRevision: replay.savedRevision, replayed: true };
      }
      if (request.expectedSavedRevision !== (stored?.document.revision ?? null)) conflict('保存済みのサムネが更新されています。読み直してください');
      if (stored && (document.revision < stored.document.revision
        || (document.revision === stored.document.revision && contentHash !== thumbnailContentHash(stored.document)))) conflict('編集版を進めずに別の内容を保存することはできません');
      const data: StoredThumbnail = { format: 'harness-thumbnail', version: 1, document,
        receipts: [...(stored?.receipts ?? []), { executionId: request.executionId, requestHash, savedRevision: document.revision, contentHash }].slice(-64) };
      if (previous.kind === 'ok') this.writeAtomic(this.backupFile, previous.raw);
      temporary = this.writeTemporary(JSON.stringify(data) + '\n');
      if (!this.ownsLock(lock.nonce)) conflict('保存の排他が失われました。読み直してから保存してください');
      renameSync(temporary, this.file); temporary = undefined;
      // rename の後の失敗は「結果不明」。再送は受領記録で照合する。
      this.syncDirectory();
      return { document, contentHash, savedRevision: document.revision, appliedRevision: document.revision, replayed: false };
    } finally {
      if (temporary) { try { unlinkSync(temporary); } catch { /* 元の文書は無傷 */ } }
      closeSync(lock.fd);
      this.releaseLock(lock.nonce);
    }
  }
  recoverFromBackup(executionId: string): SaveThumbnailResult {
    let backup: StoredThumbnail;
    try { backup = parseStored(readFileSync(this.backupFile, 'utf8')); }
    catch { throw new SequenceError('MISSING_TARGET', '使える控えがありません'); }
    return this.save({ expectedSavedRevision: null, executionId, document: backup.document });
  }
  /** 衝突時に未保存の内容を退避する。既存のファイルは上書きしない。 */
  evacuate(document: ThumbnailDocument): string {
    mkdirSync(this.directory, { recursive: true });
    const name = `thumbnail.v1.unsaved-${stamp()}-${randomUUID().slice(0, 8)}.json`, fd = openSync(join(this.directory, name), 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ format: 'harness-thumbnail', version: 1, document, receipts: [] }) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    return name;
  }
  /** ロックには pid・時刻・nonce を書く。解除と回収は nonce で持ち主を確かめる。 */
  private acquireLock(): { fd: number; nonce: string } {
    for (let attempt = 0; attempt < 2; attempt++) {
      const nonce = randomUUID();
      try {
        const fd = openSync(this.lockFile, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), nonce }));
        return { fd, nonce };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (attempt > 0 || !this.reclaimStaleLock()) break;
      }
    }
    return conflict('別の保存処理が進行中です。少し待ってから保存してください');
  }
  private readLock(file = this.lockFile): { pid: number | null; startedAt: number | null; nonce: string | null } | 'missing' {
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; return { pid: null, startedAt: null, nonce: null }; }
    try {
      const value = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown; nonce?: unknown } | null;
      const started = typeof value?.startedAt === 'string' ? Date.parse(value.startedAt) : NaN;
      return { pid: Number.isSafeInteger(value?.pid) ? (value!.pid as number) : null, startedAt: Number.isFinite(started) ? started : null,
        nonce: typeof value?.nonce === 'string' ? value.nonce : null };
    } catch { return { pid: null, startedAt: null, nonce: null }; }
  }
  private ownsLock(nonce: string): boolean { const lock = this.readLock(); return lock !== 'missing' && lock.nonce === nonce; }
  /** 自分の nonce のときだけ消す。回収されて他者の新しいロックになっていたら触らない。 */
  private releaseLock(nonce: string): void {
    if (!this.ownsLock(nonce)) return;
    try { unlinkSync(this.lockFile); } catch { /* 既に無い */ }
  }
  /** pid が死んでいるか、生きていても保存1回の想定を大きく超えて古いロックだけを回収する（pid の再利用・EPERM 対策）。 */
  private reclaimStaleLock(): boolean {
    const judged = this.readLock();
    if (judged === 'missing') return true;
    if (judged.pid !== null && judged.pid > 0) {
      // pid が生きていても古すぎれば持ち主不在（再利用・EPERM）。時刻が読めなければ mtime で見る。
      const age = judged.startedAt === null ? this.mtimeAge() : Date.now() - judged.startedAt;
      if (processAlive(judged.pid) && age !== null && age < LOCK_MAX_AGE_MS) return false;
    } else {
      const age = this.mtimeAge();
      if (age !== null && age < 30_000) return false;
    }
    const moved = `${this.lockFile}.stale-${randomUUID()}`;
    try { renameSync(this.lockFile, moved); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
    // 判定から rename までに他者が新しいロックを作っていたら、動かしてしまったので元へ戻す（link は上書きしない）。
    const taken = this.readLock(moved);
    if (taken !== 'missing' && taken.nonce !== judged.nonce) {
      try { linkSync(moved, this.lockFile); } catch { /* 別のロックが既にある */ }
      try { unlinkSync(moved); } catch { /* 無視 */ }
      return false;
    }
    try { unlinkSync(moved); } catch { /* 無視 */ }
    return true;
  }
  private mtimeAge(): number | null { try { return Date.now() - statSync(this.lockFile).mtimeMs; } catch { return null; } }
  private writeTemporary(content: string): string {
    const temporary = join(this.directory, `thumbnail.v1.${randomUUID()}.tmp`), fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    return temporary;
  }
  private writeAtomic(target: string, content: string): void {
    const temporary = this.writeTemporary(content);
    try { renameSync(temporary, target); }
    catch (error) { try { unlinkSync(temporary); } catch { /* 無視 */ } throw error; }
  }
  private syncDirectory(): void {
    if (process.platform === 'win32') return;
    const directory = openSync(this.directory, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
