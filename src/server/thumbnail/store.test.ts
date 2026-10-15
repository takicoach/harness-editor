import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SequenceDocument } from '../../core/sequence/model';
import { thumbnailFixture } from '../../core/thumbnail/fixtures';
import { SequenceStore } from '../sequence/store';
import { processAlive, ThumbnailStore } from './store';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function project(): string {
  const directory = mkdtempSync(join(tmpdir(), 'thumb-store-'));
  directories.push(directory); mkdirSync(join(directory, '.harness'));
  return directory;
}
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;
const videoDocument = (): SequenceDocument => ({ schemaVersion: 2, id: 'video', name: '動画', revision: 0, fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 },
  sequenceEndFrame: 30, background: '#000000', assets: [], tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } });
const renamed = (revision: number, name: string) => { const document = thumbnailFixture(); document.revision = revision; document.pages[0]!.name = name; return document; };

describe('ThumbnailStore', () => {
  it('案件フォルダが消えた後の退避と保存は、フォルダを作り直さずに失敗する（消した案件の名前で中身の無いフォルダが残らない）', () => {
    const directory = project(), store = new ThumbnailStore(directory);
    rmSync(directory, { recursive: true, force: true });
    expect(() => store.evacuate(thumbnailFixture())).toThrow();
    expect(existsSync(directory)).toBe(false);
    expect(() => store.save({ expectedSavedRevision: null, executionId: 'after-delete', document: thumbnailFixture() })).toThrow();
    expect(existsSync(directory)).toBe(false);
  });
  it('同じ実行 ID の再送は二重に書かない（受け入れ 10）', () => {
    const store = new ThumbnailStore(project()), document = thumbnailFixture();
    expect(store.save({ expectedSavedRevision: null, executionId: 'save-1', document })).toMatchObject({ replayed: false, savedRevision: 0 });
    const bytes = readFileSync(store.file, 'utf8');
    expect(store.save({ expectedSavedRevision: null, executionId: 'save-1', document })).toMatchObject({ replayed: true, appliedRevision: 0 });
    expect(readFileSync(store.file, 'utf8')).toBe(bytes);
    expect(JSON.parse(bytes).receipts).toHaveLength(1);
    expect(JSON.parse(bytes)).toMatchObject({ format: 'harness-thumbnail', version: 1 });
    expect(() => store.save({ expectedSavedRevision: null, executionId: 'save-1', document: renamed(1, '別') })).toThrow('同じ保存IDに異なる内容があります');
  });
  it('保存のたびに直前の正常版を控えに残す', () => {
    const store = new ThumbnailStore(project());
    store.save({ expectedSavedRevision: null, executionId: 'a', document: thumbnailFixture() });
    store.save({ expectedSavedRevision: 0, executionId: 'b', document: renamed(1, '変更後') });
    expect(JSON.parse(readFileSync(store.backupFile, 'utf8')).document.pages[0].name).toBe('案A');
    expect(() => store.save({ expectedSavedRevision: 0, executionId: 'c', document: renamed(2, '古い版から') })).toThrow('保存済みのサムネが更新されています');
  });
  it('持ち主のプロセスが無いロックは回収し、使用中のロックは奪わない', () => {
    const store = new ThumbnailStore(project()), pid = deadPid();
    expect(processAlive(pid)).toBe(false);
    writeFileSync(store.lockFile, JSON.stringify({ pid, startedAt: '2026-10-03T00:00:00.000Z' }));
    store.save({ expectedSavedRevision: null, executionId: 'a', document: thumbnailFixture() });
    expect(existsSync(store.lockFile)).toBe(false);
    writeFileSync(store.lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    expect(() => store.save({ expectedSavedRevision: 0, executionId: 'b', document: renamed(1, 'x') })).toThrow('別の保存処理が進行中です');
    expect(JSON.parse(readFileSync(store.lockFile, 'utf8')).pid).toBe(process.pid);
  });
  it('読めないロックは書きかけかもしれないので、30 秒を過ぎるまで奪わない', () => {
    const store = new ThumbnailStore(project());
    writeFileSync(store.lockFile, '');
    expect(() => store.save({ expectedSavedRevision: null, executionId: 'a', document: thumbnailFixture() })).toThrow('別の保存処理が進行中です');
    const old = new Date(Date.now() - 60_000); utimesSync(store.lockFile, old, old);
    expect(() => store.save({ expectedSavedRevision: null, executionId: 'a', document: thumbnailFixture() })).not.toThrow();
  });
  it('pid が生きていても古いロックは回収し、解除は持ち主の nonce のときだけ', () => {
    const store = new ThumbnailStore(project());
    writeFileSync(store.lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 10 * 60_000).toISOString(), nonce: 'old' }));
    store.save({ expectedSavedRevision: null, executionId: 'a', document: thumbnailFixture() });
    expect(existsSync(store.lockFile)).toBe(false);
    const other = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), nonce: 'other' });
    (store as unknown as { releaseLock(n: string): void }).releaseLock('mine');
    expect(existsSync(store.lockFile)).toBe(false);
    writeFileSync(store.lockFile, other);
    (store as unknown as { releaseLock(n: string): void }).releaseLock('mine');
    expect(readFileSync(store.lockFile, 'utf8')).toBe(other);
  });
  it('壊れたファイルは改名して保全し、控えから復旧できる', () => {
    const directory = project(), store = new ThumbnailStore(directory);
    store.save({ expectedSavedRevision: null, executionId: 'a', document: thumbnailFixture() });
    store.save({ expectedSavedRevision: 0, executionId: 'b', document: renamed(1, '最新') });
    writeFileSync(store.file, '{壊れた');
    const result = store.load();
    expect(result.kind).toBe('broken');
    if (result.kind !== 'broken') return;
    expect(result.preservedFile).toMatch(/^thumbnail\.v1\.broken-.+\.json$/);
    expect(readFileSync(join(directory, '.harness', result.preservedFile), 'utf8')).toBe('{壊れた');
    expect(existsSync(store.file)).toBe(false);
    expect([store.brokenFiles(), store.hasBackup()]).toEqual([[result.preservedFile], true]);
    expect(store.recoverFromBackup('recover-1').document.pages[0]!.name).toBe('案A');
  });
  it('衝突時の退避ファイルを作る', () => {
    const directory = project(), name = new ThumbnailStore(directory).evacuate(renamed(3, '退避'));
    expect(name).toMatch(/^thumbnail\.v1\.unsaved-.+\.json$/);
    expect(JSON.parse(readFileSync(join(directory, '.harness', name), 'utf8')).document.pages[0].name).toBe('退避');
  });
  it('動画とサムネのロックは別なので、片方の保存中でももう片方は保存できる（受け入れ 2）', () => {
    const directory = project(), videoLock = join(directory, '.harness', 'sequence.save.lock');
    writeFileSync(videoLock, JSON.stringify({ pid: process.pid, nonce: 'video' }));
    expect(() => new ThumbnailStore(directory).save({ expectedSavedRevision: null, executionId: 'a', document: thumbnailFixture() })).not.toThrow();
    unlinkSync(videoLock);
    const thumbnail = new ThumbnailStore(directory);
    writeFileSync(thumbnail.lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    expect(() => new SequenceStore(directory).save({ expectedSavedRevision: null, executionId: 'video-1', document: videoDocument() })).not.toThrow();
  });
});
