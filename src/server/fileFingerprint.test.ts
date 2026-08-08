import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fingerprintFile, fingerprintsMatch } from './fileFingerprint';

function withTempFile(content: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sme-fp-'));
  const path = join(dir, 'data.ts');
  writeFileSync(path, content, 'utf8');
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('fingerprintFile', () => {
  it('存在するファイルの size と mtimeMs を返す', () => {
    withTempFile('hello', (path) => {
      const fp = fingerprintFile(path, 'data.ts');
      expect(fp).not.toBeNull();
      if (fp === null) return;
      expect(fp.relPath).toBe('data.ts');
      expect(fp.size).toBe(5);
      expect(typeof fp.mtimeMs).toBe('number');
    });
  });

  it('存在しないファイルは null を返す', () => {
    expect(fingerprintFile('/no/such/file.ts', 'file.ts')).toBeNull();
  });
});

describe('fingerprintsMatch', () => {
  it('同じ size と mtimeMs なら一致', () => {
    const a = { relPath: 'x.ts', size: 10, mtimeMs: 100 };
    expect(fingerprintsMatch(a, { ...a })).toBe(true);
  });

  it('size が違えば不一致', () => {
    expect(fingerprintsMatch(
      { relPath: 'x.ts', size: 10, mtimeMs: 100 },
      { relPath: 'x.ts', size: 11, mtimeMs: 100 },
    )).toBe(false);
  });

  it('mtimeMs が違えば不一致', () => {
    expect(fingerprintsMatch(
      { relPath: 'x.ts', size: 10, mtimeMs: 100 },
      { relPath: 'x.ts', size: 10, mtimeMs: 200 },
    )).toBe(false);
  });

  it('両方 null なら一致（cutData.ts 不在 → 不在のまま）', () => {
    expect(fingerprintsMatch(null, null)).toBe(true);
  });

  it('片方だけ null なら不一致（外部でファイルが作られた/消された）', () => {
    const fp = { relPath: 'x.ts', size: 10, mtimeMs: 100 };
    expect(fingerprintsMatch(fp, null)).toBe(false);
    expect(fingerprintsMatch(null, fp)).toBe(false);
  });

  it('実ファイルの mtime を変えると不一致になる', () => {
    withTempFile('hello', (path) => {
      const before = fingerprintFile(path, 'data.ts');
      utimesSync(path, new Date(), new Date(Date.now() + 5000));
      const after = fingerprintFile(path, 'data.ts');
      expect(fingerprintsMatch(before, after)).toBe(false);
    });
  });
});
