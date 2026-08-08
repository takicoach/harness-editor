import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotBaseline } from './baseline';
import type { TrackedFile } from './types';

let root: string;
const tracked: TrackedFile[] = [{ stage: 'transcript-fix', relPath: 'transcript_fixed.json' }];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sm-baseline-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('snapshotBaseline', () => {
  it('追跡ファイルを baseline へコピーする', () => {
    writeFileSync(join(root, 'transcript_fixed.json'), '{"v":1}');
    const result = snapshotBaseline(root, tracked);
    expect(result.snapshotted).toEqual(['transcript_fixed.json']);
    expect(readFileSync(join(root, '.learning/baseline/transcript_fixed.json'), 'utf8')).toBe(
      '{"v":1}',
    );
  });

  it('既にベースラインがあるファイルは上書きしない（冪等）', () => {
    writeFileSync(join(root, 'transcript_fixed.json'), '{"v":1}');
    snapshotBaseline(root, tracked);
    writeFileSync(join(root, 'transcript_fixed.json'), '{"v":2}'); // 編集された
    const result = snapshotBaseline(root, tracked);
    expect(result.snapshotted).toEqual([]);
    expect(readFileSync(join(root, '.learning/baseline/transcript_fixed.json'), 'utf8')).toBe(
      '{"v":1}',
    );
  });

  it('存在しない追跡ファイルはスキップする', () => {
    const result = snapshotBaseline(root, tracked);
    expect(result.snapshotted).toEqual([]);
    expect(result.skipped).toEqual(['transcript_fixed.json']);
    expect(existsSync(join(root, '.learning/baseline/transcript_fixed.json'))).toBe(false);
  });

  it('ベースライン読み出し用のディレクトリを作る', () => {
    mkdirSync(join(root, 'sub'), { recursive: true });
    expect(existsSync(join(root, '.learning'))).toBe(false);
    snapshotBaseline(root, tracked);
    expect(existsSync(join(root, '.learning/baseline'))).toBe(true);
  });

  it('サブディレクトリを含む relPath も baseline へネストしてコピーする（telopData.ts 等）', () => {
    const nested: TrackedFile[] = [{ stage: 'telop-fix', relPath: 'src/テロップテンプレート/telopData.ts' }];
    mkdirSync(join(root, 'src', 'テロップテンプレート'), { recursive: true });
    writeFileSync(join(root, 'src', 'テロップテンプレート', 'telopData.ts'), 'export const telopData = [];');
    const result = snapshotBaseline(root, nested);
    expect(result.snapshotted).toEqual(['src/テロップテンプレート/telopData.ts']);
    expect(
      readFileSync(join(root, '.learning/baseline/src/テロップテンプレート/telopData.ts'), 'utf8'),
    ).toBe('export const telopData = [];');
  });
});
