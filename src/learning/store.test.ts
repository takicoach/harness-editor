import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStore, saveStore, appendHistory } from './store';
import { emptyTypoDict } from './typoDict';
import type { HistoryRecord, StoreSnapshot } from './types';

let storeHome: string;
let projectRoot: string;
const originalHome = process.env.HARNESS_LEARNING_HOME;

beforeEach(() => {
  storeHome = mkdtempSync(join(tmpdir(), 'sm-store-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'sm-proj-'));
  process.env.HARNESS_LEARNING_HOME = storeHome;
});
afterEach(() => {
  rmSync(storeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HARNESS_LEARNING_HOME;
  else process.env.HARNESS_LEARNING_HOME = originalHome;
});

describe('loadStore', () => {
  it('ストアが無ければ空のスナップショットを返す', () => {
    expect(loadStore()).toEqual({
      typoDict: emptyTypoDict(),
      typoDictMeta: { observations: {}, lastSeen: {} },
    });
  });
});

describe('saveStore / loadStore', () => {
  it('保存した内容を読み戻せる', () => {
    const snapshot: StoreSnapshot = {
      typoDict: { ...emptyTypoDict(), replace: { ゼロ式: '零式' } },
      typoDictMeta: { observations: { ゼロ式: 1 }, lastSeen: { ゼロ式: 'drill-01' } },
    };
    saveStore(snapshot);
    expect(loadStore()).toEqual(snapshot);
  });

  it('既存ストアがあれば保存前に backups/ へ退避する', () => {
    saveStore({ typoDict: emptyTypoDict(), typoDictMeta: { observations: {}, lastSeen: {} } });
    saveStore({
      typoDict: { ...emptyTypoDict(), replace: { a: 'b' } },
      typoDictMeta: { observations: {}, lastSeen: {} },
    });
    const backups = readdirSync(join(storeHome, 'backups'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('連続 saveStore でバックアップが衝突しない', () => {
    const snap = (r: Record<string, string>) => ({
      typoDict: { ...emptyTypoDict(), replace: r },
      typoDictMeta: { observations: {}, lastSeen: {} },
    });
    saveStore(snap({ a: '1' }));
    saveStore(snap({ a: '2' }));
    saveStore(snap({ a: '3' }));
    expect(new Set(readdirSync(join(storeHome, 'backups'))).size).toBe(3);
  });

  it('初回 saveStore でも backups/ に空ストアのバックアップが作られる', () => {
    saveStore({ typoDict: emptyTypoDict(), typoDictMeta: { observations: {}, lastSeen: {} } });
    const backupDirs = readdirSync(join(storeHome, 'backups'));
    expect(backupDirs).toHaveLength(1);
    const backupDict = join(storeHome, 'backups', backupDirs[0]!, 'typo_dict.json');
    expect(() => readFileSync(backupDict, 'utf8')).not.toThrow();
  });
});

describe('appendHistory', () => {
  it('修正履歴を .learning/history へ JSON で追記する', () => {
    const record: HistoryRecord = {
      videoId: 'drill-01',
      timestamp: '2026-05-17T00:00:00.000Z',
      diffs: [{ stage: 'transcript-fix', wordReplacements: [{ before: 'ゼロ', after: '零' }] }],
    };
    appendHistory(projectRoot, record);
    const files = readdirSync(join(projectRoot, '.learning/history'));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(projectRoot, '.learning/history', files[0]!), 'utf8'))).toEqual(
      record,
    );
  });
});
