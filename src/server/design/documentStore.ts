import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SequenceError } from '../../core/sequence/errors';

// 保存先の .harness だけを作る。案件フォルダそのものは作らない（消えた案件の名前で中身の無いフォルダを残さない・2026-10-15）。
function ensureHarnessDirectory(directory: string): void {
  try { mkdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

/** 文書の種類ごとの違い。保存の流儀（版・受領記録・ロック・控え・破損保全・退避）は共通（サムネの ThumbnailStore と同じ作り）。 */
export interface DesignStoreFormat<D extends { revision: number }> {
  /** 保存形式の名前（例 'harness-slides'）。 */
  format: string;
  /** ファイル名の元（例 'slides.v1' → slides.v1.json・.bak.json・.broken-<日時>.json・.unsaved-<日時>.json）。 */
  fileBase: string;
  /** ロックのファイル名（例 'slides.save.lock'）。中に pid・時刻・nonce を書く。 */
  lockFile: string;
  /** 文言に使う名前（例 'スライド'）。 */
  label: string;
  parse(text: string): D;
  serialize(document: D): string;
  contentBytes(document: D): string;
}
/** 保存は数十ミリ秒。pid が生きていてもこれより古いロックは持ち主不在とみなす。 */
const LOCK_MAX_AGE_MS = 5 * 60_000;
interface SavedReceipt { executionId: string; requestHash: string; savedRevision: number; contentHash: string }
interface StoredDesign<D> { format: string; version: 1; document: D; receipts: SavedReceipt[] }
export interface SaveDesignRequest<D> { expectedSavedRevision: number | null; executionId: string; document: D }
export interface SavedDesign<D> { document: D; contentHash: string; savedRevision: number }
export interface SaveDesignResult<D> extends SavedDesign<D> { replayed: boolean; appliedRevision: number }
export type DesignLoad<D> = { kind: 'missing' } | { kind: 'ok'; saved: SavedDesign<D> } | { kind: 'broken'; preservedFile: string };
type RawRead<D> = { kind: 'missing' } | { kind: 'ok'; stored: StoredDesign<D>; raw: string } | { kind: 'broken'; preservedFile: string };

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function conflict(message: string): never { throw new SequenceError('REVISION_CONFLICT', message); }
export function designProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** 呼び出し側が許可済みの案件フォルダーを渡す。クライアントのパスは受け取らない。 */
export class DesignDocumentStore<D extends { revision: number }> {
  readonly projectDirectory: string;
  readonly directory: string;
  readonly file: string;
  readonly backupFile: string;
  readonly lockFile: string;
  constructor(projectDirectory: string, readonly format: DesignStoreFormat<D>) {
    this.projectDirectory = realpathSync(projectDirectory);
    this.directory = join(this.projectDirectory, '.harness');
    this.file = join(this.directory, `${format.fileBase}.json`);
    this.backupFile = join(this.directory, `${format.fileBase}.bak.json`);
    this.lockFile = join(this.directory, format.lockFile);
    this.assertDirectory();
  }
  contentHash(document: D): string { return hash(this.format.contentBytes(document)); }
  private assertDirectory(): void {
    if (!existsSync(this.directory)) return;
    const info = lstatSync(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${this.format.label}の保存先が通常のフォルダーではありません`);
  }
  private parseStored(raw: string): StoredDesign<D> {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${this.format.label}の保存形式が不正です`);
    const data = value as Partial<StoredDesign<D>>;
    if (data.format !== this.format.format || data.version !== 1 || !Array.isArray(data.receipts)) throw new Error(`${this.format.label}の保存形式が不正です`);
    const document = this.format.parse(JSON.stringify(data.document));
    if (data.receipts.length > 64 || data.receipts.some(receipt => !receipt || typeof receipt !== 'object' || typeof receipt.executionId !== 'string'
      || !/^[a-f0-9]{64}$/.test(String(receipt.requestHash)) || !/^[a-f0-9]{64}$/.test(String(receipt.contentHash))
      || !Number.isSafeInteger(receipt.savedRevision) || receipt.savedRevision < 0 || receipt.savedRevision > document.revision)
      || new Set(data.receipts.map(receipt => receipt.executionId)).size !== data.receipts.length) throw new Error('保存処理の記録が不正です');
    return { format: this.format.format, version: 1, document, receipts: data.receipts };
  }
  /** 壊れていたら <fileBase>.broken-<日時>.json に改名して保全する（消さない・上書きしない）。 */
  private read(): RawRead<D> {
    this.assertDirectory();
    if (!existsSync(this.file)) return { kind: 'missing' };
    const info = lstatSync(this.file);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 32 * 1024 * 1024) {
      const raw = readFileSync(this.file, 'utf8');
      try { return { kind: 'ok', stored: this.parseStored(raw), raw }; } catch { /* 下で保全する */ }
    }
    const preservedFile = `${this.format.fileBase}.broken-${stamp()}.json`;
    renameSync(this.file, join(this.directory, preservedFile));
    return { kind: 'broken', preservedFile };
  }
  load(): DesignLoad<D> {
    const current = this.read();
    if (current.kind !== 'ok') return current;
    const document = current.stored.document;
    return { kind: 'ok', saved: { document, savedRevision: document.revision, contentHash: this.contentHash(document) } };
  }
  brokenFiles(): string[] {
    if (!existsSync(this.directory)) return [];
    const pattern = new RegExp(`^${escapeRegExp(this.format.fileBase)}\\.broken-.+\\.json$`);
    return readdirSync(this.directory).filter(name => pattern.test(name)).sort();
  }
  hasBackup(): boolean {
    try { this.parseStored(readFileSync(this.backupFile, 'utf8')); return true; } catch { return false; }
  }
  save(request: SaveDesignRequest<D>): SaveDesignResult<D> {
    // ロックを取る前に検証・複製する。不正な要求で保存済みの状態を変えない。
    const label = this.format.label, document = this.format.parse(this.format.serialize(request.document));
    if (typeof request.executionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.executionId)
      || (request.expectedSavedRevision !== null && (!Number.isSafeInteger(request.expectedSavedRevision) || request.expectedSavedRevision < 0))) conflict('保存要求の版または実行IDが不正です');
    const contentHash = this.contentHash(document), requestHash = hash(JSON.stringify([request.expectedSavedRevision, document.revision, contentHash]));
    this.assertDirectory(); ensureHarnessDirectory(this.directory);
    const lock = this.acquireLock();
    let temporary: string | undefined;
    try {
      const previous = this.read();
      if (previous.kind === 'broken') conflict(`保存済みの${label}が壊れていたため ${previous.preservedFile} として保全しました。読み直してください`);
      const stored = previous.kind === 'ok' ? previous.stored : null;
      const replay = stored?.receipts.find(receipt => receipt.executionId === request.executionId);
      if (replay) {
        if (replay.requestHash !== requestHash) conflict('同じ保存IDに異なる内容があります');
        return { document: structuredClone(stored!.document), contentHash: this.contentHash(stored!.document), savedRevision: stored!.document.revision,
          appliedRevision: replay.savedRevision, replayed: true };
      }
      if (request.expectedSavedRevision !== (stored?.document.revision ?? null)) conflict(`保存済みの${label}が更新されています。読み直してください`);
      if (stored && (document.revision < stored.document.revision
        || (document.revision === stored.document.revision && contentHash !== this.contentHash(stored.document)))) conflict('編集版を進めずに別の内容を保存することはできません');
      const data: StoredDesign<D> = { format: this.format.format, version: 1, document,
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
  recoverFromBackup(executionId: string): SaveDesignResult<D> {
    let backup: StoredDesign<D>;
    try { backup = this.parseStored(readFileSync(this.backupFile, 'utf8')); }
    catch { throw new SequenceError('MISSING_TARGET', '使える控えがありません'); }
    return this.save({ expectedSavedRevision: null, executionId, document: backup.document });
  }
  /** 衝突時に未保存の内容を退避する。既存のファイルは上書きしない。 */
  evacuate(document: D): string {
    // 保存と同じく、保存先がシンボリックリンク等の通常でないフォルダーなら書かない。
    this.assertDirectory(); ensureHarnessDirectory(this.directory); this.assertDirectory();
    const name = `${this.format.fileBase}.unsaved-${stamp()}-${randomUUID().slice(0, 8)}.json`, fd = openSync(join(this.directory, name), 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ format: this.format.format, version: 1, document, receipts: [] }) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    return name;
  }
  /** ロックには pid・時刻・nonce を書く。解除と回収は nonce で持ち主を確かめる。 */
  private acquireLock(): { fd: number; nonce: string } {
    for (let attempt = 0; attempt < 2; attempt++) {
      const nonce = randomUUID();
      try {
        const fd = openSync(this.lockFile, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), nonce })); }
        catch (error) {
          // 作ったばかりの空のロックを残すと、しばらく他の保存を止める。fd を閉じてロックを片付けてから失敗を返す。
          try { closeSync(fd); } catch { /* 無視 */ }
          try { unlinkSync(this.lockFile); } catch { /* 既に無い */ }
          throw error;
        }
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
  /** pid が死んでいるか、生きていても保存 1 回の想定を大きく超えて古いロックだけを回収する（pid の再利用・EPERM 対策）。 */
  private reclaimStaleLock(): boolean {
    const judged = this.readLock();
    if (judged === 'missing') return true;
    if (judged.pid !== null && judged.pid > 0) {
      const age = judged.startedAt === null ? this.mtimeAge() : Date.now() - judged.startedAt;
      if (designProcessAlive(judged.pid) && age !== null && age < LOCK_MAX_AGE_MS) return false;
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
    const temporary = join(this.directory, `${this.format.fileBase}.${randomUUID()}.tmp`), fd = openSync(temporary, 'wx', 0o600);
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
