import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SequenceError } from '../../core/sequence/errors';
import type { SequenceDocument } from '../../core/sequence/model';
import { parseSequence, sequenceContentBytes, serializeSequence } from '../../core/sequence/validate';

interface SavedReceipt { executionId: string; requestHash: string; savedRevision: number; contentHash: string }
interface StoredSequence {
  format: 'harness-sequence';
  version: 2;
  document: SequenceDocument;
  /** Same atomic file as the document, so acknowledgement cannot precede commit. */
  receipts: SavedReceipt[];
}
export interface SaveSequenceRequest {
  expectedSavedRevision: number | null;
  expectedContentHash?: string;
  executionId: string;
  document: SequenceDocument;
}
export interface SavedSequence {
  document: SequenceDocument;
  contentHash: string;
  savedRevision: number;
}
export interface SaveSequenceResult extends SavedSequence {
  replayed: boolean;
  appliedRevision: number;
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export const sequenceContentHash = (document: SequenceDocument): string => hash(sequenceContentBytes(document));

// Private snapshots never escape this module. Bound retained projects AND bytes.
interface Snapshot { rawHash: string; stored: StoredSequence; contentHash: string; bytes: number }
const snapshots = new Map<string, Snapshot>();
function remember(file: string, snapshot: Snapshot): void {
  snapshots.delete(file); snapshots.set(file, snapshot);
  let bytes = [...snapshots.values()].reduce((sum, item) => sum + item.bytes, 0);
  while (snapshots.size > 8 || bytes > 64 * 1024 * 1024) {
    const key = snapshots.keys().next().value!;
    bytes -= snapshots.get(key)!.bytes; snapshots.delete(key);
  }
}

/** The caller must resolve an allowed project first; this class never accepts a client path. */
export class SequenceStore {
  readonly projectDirectory: string;
  private readonly directory: string;
  readonly file: string;

  constructor(projectDirectory: string) {
    this.projectDirectory = realpathSync(projectDirectory);
    this.directory = join(this.projectDirectory, '.harness');
    this.file = join(this.directory, 'project.v2.json');
    this.assertDirectory();
  }
  private assertDirectory(): void {
    if (existsSync(this.directory)) {
      const info = lstatSync(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('編集データの保存先が通常のフォルダーではありません');
    }
  }
  private readSnapshot(): Snapshot | null {
    this.assertDirectory();
    if (!existsSync(this.file)) { snapshots.delete(this.file); return null; }
    const info = lstatSync(this.file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error('編集データの保存ファイルが不正です');
    // Read/hash the small editing JSON even on cache hits: revision/mtime alone
    // miss external in-place changes and atomic replacements with preserved times.
    const raw = readFileSync(this.file, 'utf8'), rawHash = hash(raw);
    const cached = snapshots.get(this.file);
    if (cached?.rawHash === rawHash) { remember(this.file, cached); return cached; }
    snapshots.delete(this.file);
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error('編集データの保存形式が不正です');
    const data = value as Partial<StoredSequence>;
    if (data.format !== 'harness-sequence' || data.version !== 2 || !Array.isArray(data.receipts)) throw new Error('編集データの保存形式が不正です');
    const document = parseSequence(JSON.stringify(data.document));
    if (data.receipts.length > 64 || data.receipts.some(receipt => !receipt || typeof receipt.executionId !== 'string'
      || !/^[a-f0-9]{64}$/.test(receipt.requestHash) || !/^[a-f0-9]{64}$/.test(receipt.contentHash)
      || !Number.isSafeInteger(receipt.savedRevision) || receipt.savedRevision < 0 || receipt.savedRevision > document.revision)
      || new Set(data.receipts.map(r => r.executionId)).size !== data.receipts.length) throw new Error('保存処理の記録が不正です');
    const snapshot: Snapshot = { rawHash, stored: { format: 'harness-sequence', version: 2, document, receipts: data.receipts },
      contentHash: sequenceContentHash(document), bytes: Buffer.byteLength(raw) };
    remember(this.file, snapshot); return snapshot;
  }
  load(): SavedSequence | null {
    const snapshot = this.readSnapshot();
    return snapshot ? { document: structuredClone(snapshot.stored.document), savedRevision: snapshot.stored.document.revision, contentHash: snapshot.contentHash } : null;
  }

  hasReceipt(executionId: string, revision: number, contentHash: string): boolean {
    return this.readSnapshot()?.stored.receipts.some(receipt => receipt.executionId === executionId
      && receipt.savedRevision === revision && receipt.contentHash === contentHash) ?? false;
  }

  save(request: SaveSequenceRequest): SaveSequenceResult {
    // Validate/copy before taking the file lock. Never let a malformed request alter saved state.
    const document = parseSequence(serializeSequence(request.document));
    if (typeof request.executionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.executionId)
      || (request.expectedSavedRevision !== null && (!Number.isSafeInteger(request.expectedSavedRevision) || request.expectedSavedRevision < 0))) {
      throw new SequenceError('REVISION_CONFLICT', '保存要求の版または実行IDが不正です');
    }
    const contentHash = sequenceContentHash(document);
    const requestHash = hash(JSON.stringify([request.expectedSavedRevision, document.revision, contentHash, ...(request.expectedContentHash === undefined ? [] : [request.expectedContentHash])]));
    this.assertDirectory(); mkdirSync(this.directory, { recursive: true });
    const lock = join(this.directory, 'sequence.save.lock');
    let descriptor: number;
    try { descriptor = openSync(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SequenceError('REVISION_CONFLICT', '別の保存処理が進行中です。保存状態を再確認してください');
      throw error;
    }
    let temporary: string | undefined;
    try {
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
      const previousSnapshot = this.readSnapshot(), previous = previousSnapshot?.stored;
      const replay = previous?.receipts.find(receipt => receipt.executionId === request.executionId);
      if (replay) {
        if (replay.requestHash !== requestHash) throw new SequenceError('REVISION_CONFLICT', '同じ保存IDに異なる内容があります');
        return { document: structuredClone(previous!.document), contentHash: previousSnapshot!.contentHash, savedRevision: previous!.document.revision,
          appliedRevision: replay.savedRevision, replayed: true };
      }
      if (request.expectedContentHash !== undefined && request.expectedContentHash !== previousSnapshot?.contentHash)
        throw new SequenceError('REVISION_CONFLICT', '保存済みの内容が外部で変更されています');
      const savedRevision = previous?.document.revision ?? null;
      if (request.expectedSavedRevision !== savedRevision) throw new SequenceError('REVISION_CONFLICT', '保存済みの内容が更新されています。現在の保存版を確認してください');
      if (previous && (document.revision < previous.document.revision
        || (document.revision === previous.document.revision && contentHash !== previousSnapshot!.contentHash))) {
        throw new SequenceError('REVISION_CONFLICT', '編集版を進めずに別の内容を保存することはできません');
      }
      const receipt: SavedReceipt = { executionId: request.executionId, requestHash, savedRevision: document.revision, contentHash };
      const data: StoredSequence = { format: 'harness-sequence', version: 2, document, receipts: [...(previous?.receipts ?? []), receipt].slice(-64) };
      temporary = join(this.directory, `project.v2.${randomUUID()}.tmp`);
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(data) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.file); temporary = undefined;
      // On POSIX persist the directory entry too. A failure after rename is an unknown result,
      // resolved by the receipt on retry rather than reporting an uncommitted success.
      if (process.platform !== 'win32') {
        const dir = openSync(this.directory, 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
      }
      return { document, contentHash, savedRevision: document.revision, appliedRevision: document.revision, replayed: false };
    } finally {
      if (temporary) { try { unlinkSync(temporary); } catch { /* Original document remains intact. */ } }
      closeSync(descriptor); unlinkSync(lock);
    }
  }
}
