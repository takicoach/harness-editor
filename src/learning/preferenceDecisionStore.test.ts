import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { PreferenceDecisionStore } from './preferenceDecisionStore';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, renameSync: vi.fn(original.renameSync) };
});

const directories: string[] = [];
function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'preference-store-'));
  directories.push(directory);
  return new PreferenceDecisionStore(directory);
}
function event(id = 'a') {
  return { schemaVersion: 1, type: 'judgment', editKind: 'telop_text', id, operationId: `op-${id}`, createdAt: '2026-09-07T00:00:00Z',
    actor: { kind: 'human', id: 'local' }, projectId: 'video-a', projectRevision: 'r1', elementId: 't1',
    sourceFrameRange: { start: 0, end: 30 }, before: '元の本文', proposedAfter: '修正文', actualAfter: '修正文',
    decision: 'accepted', reasonCode: 'wording', note: '', scope: { kind: 'project', id: 'video-a' },
    learningConsent: false, provenance: { kind: 'human' } };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('判断実例の永続化', () => {
  it('新しいストアインスタンスでも内容が残り、再送は重複しない', () => {
    const store = setup();
    store.append(event());
    const reopened = new PreferenceDecisionStore(store.directory);
    expect(reopened.read().events).toHaveLength(1);
    expect(reopened.append(event()).events).toHaveLength(1);
    expect(readdirSync(store.directory)).toEqual(['preference-decisions.v1.json']);
  });

  it('export/import で撤回を含めて戻せる', () => {
    const source = setup();
    source.append(event());
    source.append({ schemaVersion: 1, type: 'withdrawal', id: 'w1', operationId: 'op-w1',
      createdAt: '2026-09-07T00:01:00Z', actor: { kind: 'human', id: 'local' }, targetId: 'a', reason: '今回だけ' });
    const target = setup();
    target.import(JSON.parse(source.export()));
    expect(target.export()).toBe(source.export());
  });

  it('書込みが失敗したら旧記録を保ち、成功を返さず、一時ファイルとロックを解放する', () => {
    const store = setup();
    store.append(event());
    const original = readFileSync(store.file, 'utf8');
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }); });
    expect(() => store.append(event('b'))).toThrow('disk failure');
    expect(readFileSync(store.file, 'utf8')).toBe(original);
    expect(readdirSync(store.directory)).toEqual(['preference-decisions.v1.json']);
    expect(store.append(event('b')).events).toHaveLength(2);
  });

  it('ID衝突を含むインポートを途中まで保存しない', () => {
    const store = setup();
    store.append(event());
    const incoming = { schemaVersion: 1, events: [event('b'), { ...event(), note: '衝突' }] };
    expect(() => store.import(incoming)).toThrow(/OPERATION_CONFLICT/);
    expect(store.read().events.map((e) => e.id)).toEqual(['a']);
  });

  it('未知版・破損データを空として上書きしない', () => {
    const store = setup();
    const newer = JSON.stringify({ schemaVersion: 2, events: [] });
    writeFileSync(store.file, newer);
    expect(() => store.append(event())).toThrow();
    expect(readFileSync(store.file, 'utf8')).toBe(newer);
    writeFileSync(store.file, '{broken');
    expect(() => store.read()).toThrow();
  });

  it('別プロセスのロックを勝手に奪わない', () => {
    const store = setup();
    mkdirSync(`${store.file}.lock`);
    expect(() => store.append(event())).toThrow(/STORE_BUSY/);
    expect(store.read().events).toEqual([]);
  });
});
