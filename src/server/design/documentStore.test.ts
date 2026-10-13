import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesignDocumentStore, type DesignStoreFormat } from './documentStore';

/** ロックへの書き込みだけを失敗させ、開いた fd と閉じた fd を数える（ディスクがいっぱい等の再現）。 */
const fsSpy = vi.hoisted(() => ({ failLockWrite: false, opened: new Map<number, string>(), closed: new Set<number>() }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => { const fd = fs.openSync(...args); fsSpy.opened.set(fd, String(args[0])); return fd; },
    closeSync: (fd: number) => { fsSpy.closed.add(fd); return fs.closeSync(fd); },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      const [target, data] = args;
      if (fsSpy.failLockWrite && typeof target === 'number' && fsSpy.opened.get(target)?.endsWith('.save.lock') && String(data).includes('"nonce"'))
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return fs.writeFileSync(...args);
    },
  };
});

interface Note { revision: number; text: string }
const FORMAT: DesignStoreFormat<Note> = {
  format: 'harness-note', fileBase: 'note.v1', lockFile: 'note.save.lock', label: 'メモ',
  parse: text => { const value = JSON.parse(text) as Note; if (!Number.isSafeInteger(value.revision) || typeof value.text !== 'string') throw new Error('不正'); return value; },
  serialize: document => JSON.stringify(document),
  contentBytes: document => JSON.stringify({ text: document.text }),
};
const roots: string[] = [];
afterEach(() => { fsSpy.failLockWrite = false; fsSpy.opened.clear(); fsSpy.closed.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'design-store-')); roots.push(root);
  const project = join(root, 'case'); mkdirSync(project);
  return { root, project, store: new DesignDocumentStore(project, FORMAT) };
}

describe('DesignDocumentStore', () => {
  it('退避（evacuate）は、保存先の .harness がシンボリックリンクなら書かずに断る', () => {
    const { root, project, store } = setup(), elsewhere = join(root, 'elsewhere'); mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(project, '.harness'));
    expect(() => store.evacuate({ revision: 1, text: '未保存' })).toThrow('保存先が通常のフォルダーではありません');
    expect(readdirSync(elsewhere)).toEqual([]);
  });
  it('退避は通常のフォルダーなら書ける', () => {
    const { project, store } = setup();
    const name = store.evacuate({ revision: 1, text: '未保存' });
    expect(existsSync(join(project, '.harness', name))).toBe(true);
  });
  it('ロックを取った直後の書き込みが失敗したら、fd を閉じてロックファイルを片付ける（次の保存を止めない）', () => {
    const { store } = setup();
    fsSpy.failLockWrite = true;
    expect(() => store.save({ expectedSavedRevision: null, executionId: 'first', document: { revision: 1, text: 'a' } })).toThrow('ENOSPC');
    const lockFds = [...fsSpy.opened].filter(([, path]) => path === store.lockFile).map(([fd]) => fd);
    expect(lockFds).toHaveLength(1);
    expect(fsSpy.closed.has(lockFds[0]!)).toBe(true);
    expect(existsSync(store.lockFile)).toBe(false);
    fsSpy.failLockWrite = false;
    expect(store.save({ expectedSavedRevision: null, executionId: 'second', document: { revision: 1, text: 'a' } })).toMatchObject({ savedRevision: 1, replayed: false });
  });
});
