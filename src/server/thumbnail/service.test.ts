import { vi, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SequenceDocument } from '../../core/sequence/model';
import { textLayer } from '../../core/thumbnail/fixtures';
import { SequenceStore } from '../sequence/store';
import { ThumbnailBrokenError, ThumbnailConflictError, ThumbnailService, type ThumbnailEvent } from './service';
import { ThumbnailStore } from './store';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function videoProject(resolution = { width: 1920, height: 1080 }): string {
  const directory = mkdtempSync(join(tmpdir(), 'thumb-service-')); directories.push(directory);
  const document: SequenceDocument = { schemaVersion: 2, id: 'video', name: '動画', revision: 0, fps: { num: 30, den: 1 }, resolution, sequenceEndFrame: 30,
    background: '#000000', assets: [], tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
  new SequenceStore(directory).save({ expectedSavedRevision: null, executionId: 'video', document });
  return directory;
}

describe('ThumbnailService', () => {
  it('作成は動画の形式からキャンバスを決め、編集・保存しても動画の文書は 1 バイトも変えない（受け入れ 1）', () => {
    const directory = videoProject(), videoFile = join(directory, '.harness', 'project.v2.json'), before = readFileSync(videoFile);
    const service = new ThumbnailService(), state = service.create(directory, 'create-1'), pageId = state.document.pages[0]!.id;
    expect(state.document.canvas).toEqual({ width: 1280, height: 720 });
    service.execute(directory, { sessionId: state.sessionId, expectedRevision: 0, executionId: 'e1', command: { type: 'add-layer', pageId, layer: textLayer('t') } });
    expect(service.save(directory, { sessionId: state.sessionId, expectedRevision: 1, expectedSavedRevision: 0, executionId: 's1' })).toMatchObject({ dirty: false, savedRevision: 1 });
    expect(readFileSync(videoFile).equals(before)).toBe(true);
    expect(service.create(directory, 'create-1').document.revision).toBe(1);
  });
  it('縦と正方の案件', () => {
    expect(new ThumbnailService().create(videoProject({ width: 1080, height: 1920 }), 'c').document.canvas).toEqual({ width: 1080, height: 1920 });
    expect(new ThumbnailService().create(videoProject({ width: 720, height: 720 }), 'c').document.canvas).toEqual({ width: 1080, height: 1080 });
  });
  it('動画の編集データが無い案件では作れない', () => {
    const directory = mkdtempSync(join(tmpdir(), 'thumb-service-')); directories.push(directory);
    expect(() => new ThumbnailService().create(directory, 'c')).toThrow('先に動画の編集を始めてください');
  });
  it('案ごとの指紋は、編集した案だけが変わる', () => {
    const directory = videoProject(), service = new ThumbnailService(), state = service.create(directory, 'c'), pageA = state.document.pages[0]!.id;
    const two = service.execute(directory, { sessionId: state.sessionId, expectedRevision: 0, executionId: 'p', command: { type: 'add-page', pageId: 'page-b', name: '案B' } });
    const edited = service.execute(directory, { sessionId: state.sessionId, expectedRevision: 1, executionId: 'l', command: { type: 'add-layer', pageId: pageA, layer: textLayer('t') } });
    expect(edited.pageHashes['page-b']).toBe(two.pageHashes['page-b']);
    expect(edited.pageHashes[pageA]).not.toBe(two.pageHashes[pageA]);
  });
  it('保存済みが別の場所で変わっていたら、未保存の内容を退避して例外にする', () => {
    const directory = videoProject(), service = new ThumbnailService(), state = service.create(directory, 'c'), pageId = state.document.pages[0]!.id;
    service.execute(directory, { sessionId: state.sessionId, expectedRevision: 0, executionId: 'e', command: { type: 'add-layer', pageId, layer: textLayer('mine') } });
    const store = new ThumbnailStore(directory), outside = structuredClone(state.document);
    outside.revision = 1; outside.pages[0]!.name = '外で変更';
    store.save({ expectedSavedRevision: 0, executionId: 'outside', document: outside });
    let caught: unknown;
    try { service.save(directory, { sessionId: state.sessionId, expectedRevision: 1, expectedSavedRevision: 0, executionId: 's' }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ThumbnailConflictError);
    const evacuated = (caught as ThumbnailConflictError).evacuatedFile!;
    expect(JSON.parse(readFileSync(join(directory, '.harness', evacuated), 'utf8')).document.pages[0].layers[0].id).toBe('mine');
    expect(service.open(directory).document.pages[0]!.name).toBe('外で変更');
  });
  it('退避に失敗したら編集中のセッションを捨てない', () => {
    const directory = videoProject(), service = new ThumbnailService(), state = service.create(directory, 'c'), pageId = state.document.pages[0]!.id;
    service.execute(directory, { sessionId: state.sessionId, expectedRevision: 0, executionId: 'e', command: { type: 'add-layer', pageId, layer: textLayer('mine') } });
    const outside = structuredClone(state.document); outside.revision = 1; outside.pages[0]!.name = '外で変更';
    new ThumbnailStore(directory).save({ expectedSavedRevision: 0, executionId: 'outside', document: outside });
    const spy = vi.spyOn(ThumbnailStore.prototype, 'evacuate').mockImplementation(() => { throw new Error('disk full'); });
    try { expect(() => service.save(directory, { sessionId: state.sessionId, expectedRevision: 1, expectedSavedRevision: 0, executionId: 's' })).toThrow('disk full'); }
    finally { spy.mockRestore(); }
    expect(service.inspect(directory, state.sessionId).document.pages[0]!.layers[0]!.id).toBe('mine');
  });
  it('壊れたファイルは保全し、控えからでも新規でも再開できる', () => {
    const directory = videoProject(), service = new ThumbnailService(), state = service.create(directory, 'c'), pageId = state.document.pages[0]!.id;
    service.execute(directory, { sessionId: state.sessionId, expectedRevision: 0, executionId: 'e', command: { type: 'add-layer', pageId, layer: textLayer('t') } });
    service.save(directory, { sessionId: state.sessionId, expectedRevision: 1, expectedSavedRevision: 0, executionId: 's' });
    const file = new ThumbnailStore(directory).file;
    writeFileSync(file, 'broken');
    expect(() => service.open(directory)).toThrow(ThumbnailBrokenError);
    expect(service.status(directory)).toMatchObject({ status: 'broken', backupAvailable: true });
    expect(service.recover(directory, 'backup', 'r1').document.pages[0]!.layers).toEqual([]);
    writeFileSync(file, 'broken again');
    expect(() => service.open(directory)).toThrow(ThumbnailBrokenError);
    expect(service.recover(directory, 'new', 'r2').document.revision).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
  it('編集と保存を通知する', () => {
    const directory = videoProject(), service = new ThumbnailService(), state = service.create(directory, 'c'), events: ThumbnailEvent[] = [];
    const stop = service.subscribe(directory, event => events.push(event));
    service.execute(directory, { sessionId: state.sessionId, expectedRevision: 0, executionId: 'e', command: { type: 'add-layer', pageId: state.document.pages[0]!.id, layer: textLayer('t') } });
    service.save(directory, { sessionId: state.sessionId, expectedRevision: 1, expectedSavedRevision: 0, executionId: 's' });
    stop();
    expect(events).toEqual([{ type: 'change' }, { type: 'change' }]);
  });
});
