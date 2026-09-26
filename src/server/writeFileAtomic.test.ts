import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileAtomic, writeFilesAtomic } from './writeFileAtomic';

function withTmpDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sme-atomic-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('writeFileAtomic（data-safety-7）', () => {
  it('内容を書き、.tmp を残さない', () => {
    withTmpDir((dir) => {
      const target = join(dir, 'a.ts');
      writeFileAtomic(target, 'new');
      expect(readFileSync(target, 'utf8')).toBe('new');
      expect(existsSync(`${target}.tmp`)).toBe(false);
    });
  });

  it('親ディレクトリが無くても作って書く', () => {
    withTmpDir((dir) => {
      const target = join(dir, 'sub', 'deep', 'b.ts');
      writeFileAtomic(target, 'x');
      expect(readFileSync(target, 'utf8')).toBe('x');
    });
  });
});

describe('writeFilesAtomic（data-safety-7）', () => {
  it('2 件目の書込が失敗したら 1 件目は旧内容のまま・.tmp も残らない', () => {
    withTmpDir((dir) => {
      const first = join(dir, 'first.ts');
      const second = join(dir, 'second.ts');
      writeFileSync(first, 'OLD-1', 'utf8');
      writeFileSync(second, 'OLD-2', 'utf8');
      // 2 件目の tmp 先をディレクトリにして writeFileSync を EISDIR で失敗させる
      // （書込失敗の実体をモックせずに再現する）。
      mkdirSync(`${second}.tmp`);

      expect(() => {
        writeFilesAtomic([
          { path: first, source: 'NEW-1' },
          { path: second, source: 'NEW-2' },
        ]);
      }).toThrow();

      // 1 件目は rename されていない＝旧内容のまま。
      expect(readFileSync(first, 'utf8')).toBe('OLD-1');
      expect(readFileSync(second, 'utf8')).toBe('OLD-2');
      // 1 件目の tmp は後片付けで消えている。
      expect(existsSync(`${first}.tmp`)).toBe(false);
    });
  });

  it('全件成功なら全部が新内容になる', () => {
    withTmpDir((dir) => {
      const a = join(dir, 'a.ts');
      const b = join(dir, 'b.ts');
      writeFilesAtomic([
        { path: a, source: 'A' },
        { path: b, source: 'B' },
      ]);
      expect(readFileSync(a, 'utf8')).toBe('A');
      expect(readFileSync(b, 'utf8')).toBe('B');
      expect(existsSync(`${a}.tmp`)).toBe(false);
      expect(existsSync(`${b}.tmp`)).toBe(false);
    });
  });
});

describe('tmp は rename の前に fsync する（サイクル 2 Minor）', () => {
  it('fsync → rename の順で呼ばれ、内容も正しく残る', async () => {
    const calls: string[] = [];
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        fsyncSync: (fd: number) => {
          calls.push('fsync');
          real.fsyncSync(fd);
        },
        renameSync: (from: string, to: string) => {
          calls.push('rename');
          real.renameSync(from, to);
        },
      };
    });
    try {
      const mod = await import('./writeFileAtomic');
      withTmpDir((dir) => {
        const target = join(dir, 'a.ts');
        mod.writeFilesAtomic([{ path: target, source: 'new' }]);
        expect(readFileSync(target, 'utf8')).toBe('new');
      });
      // 書き切ってディスクへ落としてから差し替える（逆順だと空ファイルが残りうる）。
      expect(calls).toEqual(['fsync', 'rename']);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

describe('部分書込みでも全量が書かれる（サイクル 3 Important）', () => {
  it('writeSync が 1 回目に半分しか書かなくても内容は元の全文と一致する', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      let first = true;
      return {
        ...real,
        // write(2) の「全量書けるとは限らない」挙動を再現する。
        // 文字列渡し（旧実装）・Buffer 渡しの両方の呼び方で 1 回目を半分に切る。
        writeSync: (fd: number, data: string | Buffer, a?: unknown, b?: unknown) => {
          if (typeof data === 'string') {
            const buf = Buffer.from(data, (b as BufferEncoding | undefined) ?? 'utf8');
            const n = first ? Math.floor(buf.length / 2) : buf.length;
            first = false;
            return real.writeSync(fd, buf, 0, n);
          }
          const offset = a as number;
          const length = b as number;
          const n = first ? Math.floor(length / 2) : length;
          first = false;
          return real.writeSync(fd, data, offset, n);
        },
      };
    });
    try {
      const mod = await import('./writeFileAtomic');
      const source = 'あいうえお'.repeat(2000);
      withTmpDir((dir) => {
        const target = join(dir, 'partial.ts');
        mod.writeFileAtomic(target, source);
        expect(readFileSync(target, 'utf8')).toBe(source);
      });
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});
