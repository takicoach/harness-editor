/**
 * 上書き保存前の退避（data-safety-4）と、保持世代の上限（サイクル 2 Minor）。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKUP_KEEP, backupProjectFiles, backupStamp } from './backupProject';

function withTmpDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sme-backup-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('backupProjectFiles', () => {
  it('実在するファイルだけを .sme/backup/<日時>/ へ複写する', () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, 'a.ts'), 'A');
      const rel = backupProjectFiles(dir, ['a.ts', 'missing.ts'], new Date('2026-09-07T01:12:00Z'));
      expect(rel).not.toBeNull();
      expect(existsSync(join(dir, rel!, 'a.ts'))).toBe(true);
      expect(existsSync(join(dir, rel!, 'missing.ts'))).toBe(false);
    });
  });

  it('複写対象が無ければ空フォルダを作らない', () => {
    withTmpDir((dir) => {
      expect(backupProjectFiles(dir, ['nope.ts'])).toBeNull();
      expect(existsSync(join(dir, '.sme', 'backup'))).toBe(false);
    });
  });

  it('保持世代を超えた古い退避は古い順に削る（上限 2 で 3 回 → 2 個）', () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, 'a.ts'), 'A');
      const stamps = [
        new Date('2026-09-07T01:00:00Z'),
        new Date('2026-09-07T02:00:00Z'),
        new Date('2026-09-07T03:00:00Z'),
      ];
      for (const at of stamps) backupProjectFiles(dir, ['a.ts'], at, 2);

      const left = readdirSync(join(dir, '.sme', 'backup')).sort();
      expect(left).toEqual([backupStamp(stamps[1]!), backupStamp(stamps[2]!)]);
    });
  });

  it('既定の保持世代は 10', () => {
    expect(BACKUP_KEEP).toBe(10);
  });
});
