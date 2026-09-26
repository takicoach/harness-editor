import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanProjects, isSuperMovieProject } from './scanProjects';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

describe('isSuperMovieProject', () => {
  it('videoConfig.ts と telopData.ts を持つディレクトリを真と判定する', () => {
    expect(isSuperMovieProject(join(FIXTURE_ROOT, 'sample-project'))).toBe(true);
  });
  it('ハーネス形式でないディレクトリは偽', () => {
    expect(isSuperMovieProject(FIXTURE_ROOT)).toBe(false);
  });
});

describe('scanProjects', () => {
  it('ルート配下のハーネス形式の案件を列挙する', () => {
    const projects = scanProjects(FIXTURE_ROOT);
    const sample = projects.find((p) => p.id === 'sample-project');
    expect(sample).toBeDefined();
    expect(sample?.orientation).toBe('v');
    expect(sample?.durationLabel).toBe('3:20');
  });
  it('保存先の絶対パス（dir）を載せる（ホームの「保存先」表示用）', () => {
    const sample = scanProjects(FIXTURE_ROOT).find((p) => p.id === 'sample-project');
    expect(sample?.dir).toBe(join(FIXTURE_ROOT, 'sample-project'));
  });
  it('存在しないルートは空配列を返す', () => {
    expect(scanProjects('/no/such/dir/at/all')).toEqual([]);
  });

  // FIFO は statSync().size が 0 でサイズ上限を素通りし、readFileSync が書き手を待って
  // 恒久ブロックする（一覧 API 全体が固まる）。通常ファイル以外は読まずに除外する。
  it.skipIf(process.platform === 'win32')(
    '通常ファイルでない videoConfig.ts（FIFO）はハングせず一覧から除外する',
    { timeout: 5_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), 'sme-scan-fifo-'));
      try {
        const dir = join(root, 'fifo-project');
        mkdirSync(join(dir, 'src', 'テロップテンプレート'), { recursive: true });
        writeFileSync(join(dir, 'src', 'テロップテンプレート', 'telopData.ts'), 'export const telopData = [];', 'utf8');
        execFileSync('mkfifo', [join(dir, 'src', 'videoConfig.ts')]);
        expect(scanProjects(root)).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
