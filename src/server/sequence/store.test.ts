import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SequenceDocument } from '../../core/sequence/model';
import { SequenceStore } from './store';
import { SequenceService } from './service';
import * as validation from '../../core/sequence/validate';

const failure = vi.hoisted(() => ({ rename: false }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (failure.rename) throw new Error('simulated disk failure before commit');
    return fs.renameSync(...args);
  } };
});
function document(revision = 0, name = '編集'): SequenceDocument {
  return { schemaVersion: 2, id: 'project', name, revision, fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 },
    sequenceEndFrame: 0, background: '#000000', assets: [], tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
}
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'harness-sequence-store-')); failure.rename = false; });
afterEach(() => { failure.rename = false; rmSync(directory, { recursive: true, force: true }); });

describe('v2 atomic save boundary', () => {
  it('stores and loads one authoritative document, leaving legacy files untouched', () => {
    writeFileSync(join(directory, 'legacy.ts'), 'do not change');
    const store = new SequenceStore(directory);
    expect(store.load()).toBeNull();
    const saved = store.save({ expectedSavedRevision: null, executionId: 'create', document: document() });
    expect(store.load()).toEqual({ document: document(), contentHash: saved.contentHash, savedRevision: 0 });
    expect(readFileSync(join(directory, 'legacy.ts'), 'utf8')).toBe('do not change');
    expect(readdirSync(join(directory, '.harness'))).toEqual(['project.v2.json']);
  });
  it('compares the last SAVED revision, independently of multiple unsaved edit revisions', () => {
    const store = new SequenceStore(directory);
    store.save({ expectedSavedRevision: null, executionId: 'create', document: document() });
    const saved = store.save({ expectedSavedRevision: 0, executionId: 'edit-six', document: document(6, '6回編集') });
    expect(saved.savedRevision).toBe(6);
    expect(() => store.save({ expectedSavedRevision: 0, executionId: 'stale', document: document(7, '古いタブ') })).toThrow(/更新/);
    expect(store.load()!.document.name).toBe('6回編集');
  });
  it('persists a newer undo revision even when content hash returns to its original value', () => {
    const store = new SequenceStore(directory);
    const original = store.save({ expectedSavedRevision: null, executionId: 'create', document: document() });
    store.save({ expectedSavedRevision: 0, executionId: 'edit', document: document(1, '変更') });
    const undo = store.save({ expectedSavedRevision: 1, executionId: 'undo', document: document(2) });
    expect(undo.contentHash).toBe(original.contentHash); expect(store.load()!.savedRevision).toBe(2);
  });
  it('recovers a lost response after reopening and does not overwrite a subsequent save', () => {
    const request = { expectedSavedRevision: null, executionId: 'create', document: document() };
    new SequenceStore(directory).save(request);
    const reopened = new SequenceStore(directory);
    reopened.save({ expectedSavedRevision: 0, executionId: 'later', document: document(1, 'その後') });
    const replay = reopened.save(request);
    expect(replay.replayed).toBe(true); expect(replay.appliedRevision).toBe(0);
    expect(replay.savedRevision).toBe(1); expect(replay.document.name).toBe('その後');
    expect(() => reopened.save({ ...request, document: document(0, '同じIDで改変') })).toThrow(/保存ID/);
  });
  it('rejects changing content without advancing the edit revision', () => {
    const store = new SequenceStore(directory);
    store.save({ expectedSavedRevision: null, executionId: 'create', document: document() });
    expect(() => store.save({ expectedSavedRevision: 0, executionId: 'wrong', document: document(0, '改変') })).toThrow(/編集版/);
    const noOp = store.save({ expectedSavedRevision: 0, executionId: 'save-again', document: document() });
    expect(noOp.savedRevision).toBe(0);
  });
  it('keeps the complete previous document and cleans the temporary file if atomic replacement fails', () => {
    const store = new SequenceStore(directory);
    store.save({ expectedSavedRevision: null, executionId: 'create', document: document() });
    const before = readFileSync(store.file, 'utf8');
    failure.rename = true;
    expect(() => store.save({ expectedSavedRevision: 0, executionId: 'fail', document: document(1, '変更') })).toThrow(/disk failure/);
    expect(readFileSync(store.file, 'utf8')).toBe(before);
    expect(readdirSync(join(directory, '.harness'))).toEqual(['project.v2.json']);
    failure.rename = false;
    expect(store.save({ expectedSavedRevision: 0, executionId: 'fail', document: document(1, '変更') }).replayed).toBe(false);
  });
  it('does not bypass an existing cross-process save lock', () => {
    const store = new SequenceStore(directory);
    store.save({ expectedSavedRevision: null, executionId: 'create', document: document() });
    writeFileSync(join(directory, '.harness', 'sequence.save.lock'), JSON.stringify({ pid: process.pid }));
    expect(() => store.save({ expectedSavedRevision: 0, executionId: 'other-process', document: document(1) })).toThrow(/進行中/);
    expect(store.load()!.savedRevision).toBe(0);
  });
});

describe('validated saved snapshot reuse', () => {
  it('validates once across stores, while callers cannot mutate the cached document', () => {
    const store = new SequenceStore(directory);
    store.save({ expectedSavedRevision: null, executionId: 'create', document: document() });
    const parse = vi.spyOn(validation, 'parseSequence');
    try {
      store.load(); const count = parse.mock.calls.length;
      const loaded = new SequenceStore(directory).load()!;
      loaded.document.name = 'caller mutation';
      expect(store.load()!.document.name).toBe('編集');
      expect(parse.mock.calls.length).toBe(count);
    } finally { parse.mockRestore(); }
  });
  it('detects same-revision overwrites even with restored mtime, atomic rename and invalid replacements', () => {
    const store = new SequenceStore(directory);
    store.save({ expectedSavedRevision: null, executionId: 'create', document: document() });
    const initial = store.load()!, info = statSync(store.file);
    const raw = JSON.parse(readFileSync(store.file, 'utf8'));
    raw.document.name = '外部'; writeFileSync(store.file, JSON.stringify(raw));
    utimesSync(store.file, info.atime, info.mtime);
    expect(store.load()!.contentHash).not.toBe(initial.contentHash);
    raw.document.name = '置換'; const temp = store.file + '.tmp';
    writeFileSync(temp, JSON.stringify(raw)); renameSync(temp, store.file);
    expect(store.load()!.document.name).toBe('置換');
    raw.document.fps.num = 0; writeFileSync(store.file, JSON.stringify(raw));
    expect(() => store.load()).toThrow();
    rmSync(store.file); expect(store.load()).toBeNull();
  });
});

describe('external save notifications', () => {
  it('refuses automatic adoption if unsaved work appeared after the client status read',()=>{
    const store=new SequenceStore(directory),service=new SequenceService();
    store.save({expectedSavedRevision:null,executionId:'initial',document:document()});
    const initial=service.open(directory);
    const edited=service.execute(directory,{sessionId:initial.sessionId,expectedRevision:0,executionId:'human',command:{type:'add-track',track:{id:'v',name:'human',kind:'visual',enabled:true}}});
    store.save({expectedSavedRevision:0,executionId:'external',document:document(2,'external')});
    const status=service.inspect(directory,initial.sessionId);
    expect(()=>service.reload(directory,initial.sessionId,edited.document.revision,2,status.externalChange!.contentHash,true)).toThrow(/未保存/);
    expect(service.inspect(directory,initial.sessionId).document).toEqual(edited.document);
  });
  it('notifies observers for commands and saves, and lets another viewer follow an adopted session',()=>{
    const store=new SequenceStore(directory),service=new SequenceService();
    store.save({expectedSavedRevision:null,executionId:'initial',document:document()});const initial=service.open(directory);
    const changed=vi.fn(),stop=service.subscribe(directory,changed);
    const edited=service.execute(directory,{sessionId:initial.sessionId,expectedRevision:0,executionId:'edit',command:{type:'add-track',track:{id:'v',name:'AI',kind:'visual',enabled:true}}});
    expect(changed).toHaveBeenCalledOnce();
    service.save(directory,{sessionId:initial.sessionId,expectedRevision:edited.document.revision,expectedSavedRevision:0,executionId:'save'});
    expect(changed).toHaveBeenCalledTimes(2);
    store.save({expectedSavedRevision:1,executionId:'external',document:document(2,'external')});
    const external=service.inspect(directory,initial.sessionId).externalChange!;
    const reloaded=service.reload(directory,initial.sessionId,1,external.savedRevision,external.contentHash,true);
    expect(service.inspect(directory,initial.sessionId,true).sessionId).toBe(reloaded.sessionId);
    stop();service.discard(directory,reloaded.sessionId,2);expect(changed).toHaveBeenCalledTimes(3);
  });
  it.each([false, true])('preserves the open session and undo state (dirty=%s) until explicit reload', dirty => {
    const store = new SequenceStore(directory), service = new SequenceService();
    store.save({expectedSavedRevision:null, executionId:'initial', document:document()});
    const initial = service.open(directory);
    if (dirty) service.execute(directory, {sessionId:initial.sessionId, expectedRevision:0, executionId:'human',
      command:{type:'set-ducking', patch:{enabled:true, strength:'strong'}}});
    const before = service.inspect(directory, initial.sessionId);
    store.save({expectedSavedRevision:0, executionId:'external', document:document(2, '外部')});
    const status = service.inspect(directory, initial.sessionId);
    expect(status.document).toEqual(before.document); expect(status.canUndo).toBe(before.canUndo);
    expect(status.externalChange).toMatchObject({savedRevision:2}); expect(status.dirty).toBe(dirty);
    expect(() => service.reload(directory, initial.sessionId, before.document.revision, 2, 'wrong')).toThrow(/再確認/);
    const reloaded = service.reload(directory, initial.sessionId, before.document.revision, 2, status.externalChange!.contentHash);
    expect(reloaded.document.name).toBe('外部'); expect(reloaded.externalChange).toBeUndefined();
  });
  it('does not report own saves as external writes', () => {
    const store = new SequenceStore(directory), service = new SequenceService();
    store.save({expectedSavedRevision:null, executionId:'initial', document:document()});
    const initial = service.open(directory);
    service.save(directory, {sessionId:initial.sessionId,expectedRevision:0,expectedSavedRevision:0,executionId:'own'});
    expect(service.inspect(directory, initial.sessionId).externalChange).toBeUndefined();
  });
});
