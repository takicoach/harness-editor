import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeTimestampedBackup } from './transcribeBackup';

describe('writeTimestampedBackup', () => {
  it('既存ファイルを transcript.backup-YYYY-MM-DD-HHMMSS.json として複製する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-test-'));
    try {
      const src = join(dir, 'transcript.json');
      writeFileSync(src, '{"foo":1}');
      const bakPath = writeTimestampedBackup(dir, 'transcript.json', new Date('2026-05-24T14:30:45Z'));
      expect(bakPath).toMatch(/transcript\.backup-2026-05-24-\d{6}\.json$/);
      expect(readFileSync(bakPath!, 'utf8')).toBe('{"foo":1}');
      expect(readFileSync(src, 'utf8')).toBe('{"foo":1}'); // 元は残る
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('source が無ければ null を返す（バックアップしない）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-test-'));
    try {
      const bakPath = writeTimestampedBackup(dir, 'transcript.json', new Date());
      expect(bakPath).toBeNull();
      expect(readdirSync(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
