import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slidesFixture } from '../../core/slides/fixtures';
import { SequenceStore } from '../sequence/store';
import { createSlidesProject, isSlidesProject, listSlidesProjects } from './projects';
import { SlidesBrokenError, SlidesConflictError, SlidesService, slidesPageHash } from './service';
import { SlidesStore } from './store';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string { const directory = mkdtempSync(join(tmpdir(), 'slides-service-')); roots.push(directory); return directory; }
function project(): string {
  const directory = join(root(), 'セミナー'); mkdirSync(directory);
  new SlidesStore(directory).save({ expectedSavedRevision: null, executionId: 'seed', document: slidesFixture() });
  return directory;
}

describe('スライド案件', () => {
  it('作ると空のスライドができ、一覧に出る。動画の案件や空のフォルダーは出ない。名前は案件と同じ規則', () => {
    const base = root();
    expect(createSlidesProject(base, ' 10月セミナー ')).toEqual({ id: '10月セミナー' });
    mkdirSync(join(base, 'empty'));
    const video = join(base, 'video'); mkdirSync(video);
    new SequenceStore(video).save({ expectedSavedRevision: null, executionId: 'v', document: { schemaVersion: 2, id: 'video', name: '動画', revision: 0, fps: { num: 30, den: 1 },
      resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 30, background: '#000000', assets: [], tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } } });
    expect(listSlidesProjects(base)).toEqual([{ id: '10月セミナー', name: '10月セミナー', status: 'ok', pages: 0, updatedAt: expect.any(String) }]);
    expect([isSlidesProject(join(base, '10月セミナー')), isSlidesProject(video), isSlidesProject(join(base, 'empty'))]).toEqual([true, false, false]);
    expect(() => createSlidesProject(base, '10月セミナー')).toThrow('同じ名前のプロジェクトがすでにあります');
    expect(() => createSlidesProject(base, '../外')).toThrow('使えない文字');
  });
});

describe('SlidesService', () => {
  it('開く・編集する・保存する。描画の指紋はページごと', () => {
    const service = new SlidesService(), directory = project(), events: string[] = [];
    service.subscribe(directory, event => events.push(event.type));
    let state = service.open(directory);
    expect(Object.keys(state.pageHashes)).toEqual(['page-1', 'page-2']);
    expect(state.pageHashes['page-1']).toBe(slidesPageHash(state.document, 'page-1'));
    expect(state.pageHashes['page-1']).not.toBe(state.pageHashes['page-2']);
    state = service.execute(directory, { sessionId: state.sessionId, expectedRevision: 0, executionId: 'e1', command: { type: 'set-notes', pageId: 'page-1', notes: '挨拶' } });
    expect([state.dirty, events]).toEqual([true, ['change']]);
    state = service.save(directory, { sessionId: state.sessionId, expectedRevision: 1, expectedSavedRevision: 0, executionId: 's1' });
    expect(state.dirty).toBe(false);
    expect(new SlidesStore(directory).load()).toMatchObject({ kind: 'ok', saved: { savedRevision: 1 } });
  });
  it('AI の適用は 1 回の Undo で、すぐ保存する。同じ実行 ID の再送は再実行しない', () => {
    const service = new SlidesService(), directory = project(), opened = service.open(directory);
    const request = { sessionId: opened.sessionId, expectedRevision: 0, executionId: 'agent-op1', command: { type: 'set-notes' as const, pageId: 'page-2', notes: 'AI のメモ' } };
    const state = service.agentApply(directory, request);
    expect([state.dirty, state.canUndo, state.savedRevision]).toEqual([false, true, 1]);
    const load = new SlidesStore(directory).load();
    expect(load.kind === 'ok' && load.saved.document.pages[1]!.notes).toBe('AI のメモ');
    expect(service.agentApply(directory, request)).toMatchObject({ replayed: true, savedRevision: 1 });
  });
  it('保存済みのファイルが外で変わっていたら、未保存の内容を退避して読み直す', () => {
    const service = new SlidesService(), directory = project();
    let state = service.open(directory);
    state = service.execute(directory, { sessionId: state.sessionId, expectedRevision: 0, executionId: 'e1', command: { type: 'set-notes', pageId: 'page-1', notes: '未保存' } });
    const outside = slidesFixture(); outside.revision = 1; outside.pages[0]!.notes = '外の変更';
    new SlidesStore(directory).save({ expectedSavedRevision: 0, executionId: 'outside', document: outside });
    let error: unknown;
    try { service.save(directory, { sessionId: state.sessionId, expectedRevision: 1, expectedSavedRevision: 0, executionId: 's1' }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SlidesConflictError);
    const evacuated = (error as SlidesConflictError).evacuatedFile!;
    expect(JSON.parse(readFileSync(join(directory, '.harness', evacuated), 'utf8')).document.pages[0].notes).toBe('未保存');
    expect(service.open(directory).document.pages[0]!.notes).toBe('外の変更');
  });
  it('壊れたファイルは保全し、控えから戻すか新しく始めるかを選べる', () => {
    const service = new SlidesService(), directory = project(), store = new SlidesStore(directory);
    store.save({ expectedSavedRevision: 0, executionId: 'second', document: { ...slidesFixture(), revision: 1 } });
    writeFileSync(store.file, '{壊れた');
    expect(() => service.open(directory)).toThrow(SlidesBrokenError);
    expect(service.status(directory)).toMatchObject({ status: 'broken', backupAvailable: true });
    expect(service.recover(directory, 'backup', 'r1').document.pages).toHaveLength(2);
    writeFileSync(store.file, '{壊れた');
    expect(service.recover(directory, 'new', 'r2').document.pages).toEqual([]);
  });
});
