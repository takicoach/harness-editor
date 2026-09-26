import { globalStoreDir } from './paths';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStore, saveStore, appendHistory } from './store';
import { emptyTypoDict } from './typoDict';
import type { HistoryRecord, StoreSnapshot } from './types';

let storeHome: string;
let projectRoot: string;
const originalHome = process.env.SUPERMOVIE_LEARNING_HOME;

beforeEach(() => {
  storeHome = mkdtempSync(join(tmpdir(), 'sm-store-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'sm-proj-'));
  process.env.SUPERMOVIE_LEARNING_HOME = storeHome;
});
afterEach(() => {
  rmSync(storeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.SUPERMOVIE_LEARNING_HOME;
  else process.env.SUPERMOVIE_LEARNING_HOME = originalHome;
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

describe('globalStoreDir の解決順（新名を正・旧名を fallback）', () => {
  it('HARNESS_LEARNING_HOME > SUPERMOVIE_LEARNING_HOME > 既存 ~/.video-harness-learning > 既存 ~/.supermovie-learning > 新名既定', () => {
    const home = mkdtempSync(join(tmpdir(), 'lh-'));
    const r = (env: Record<string, string | undefined>) => globalStoreDir(env, home);
    expect(r({ HARNESS_LEARNING_HOME: '/x/new', SUPERMOVIE_LEARNING_HOME: '/x/old' })).toBe('/x/new');
    expect(r({ SUPERMOVIE_LEARNING_HOME: '/x/old' })).toBe('/x/old');
    // どちらのフォルダも無ければ新名が既定（作らない）
    expect(r({})).toBe(join(home, '.video-harness-learning'));
    // 旧名だけがあれば旧名を読む（製品スキルは旧名へ書く）
    mkdirSync(join(home, '.supermovie-learning'));
    expect(r({})).toBe(join(home, '.supermovie-learning'));
    // 新名があれば新名が勝つ
    mkdirSync(join(home, '.video-harness-learning'));
    expect(r({})).toBe(join(home, '.video-harness-learning'));
    rmSync(home, { recursive: true, force: true });
  });
});
