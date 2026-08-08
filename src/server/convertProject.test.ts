import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { convertBurnedInProject, hasCutData } from './convertProject';
import { HttpError } from './http';
import { parseCutData } from '../core';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'sample-project');
const SAMPLE_VC = readFileSync(join(SAMPLE, 'src', 'videoConfig.ts'), 'utf8');

let tmp: string | null = null;

/** sample-project の videoConfig.ts だけを持つ最小プロジェクトを temp に作る。 */
function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sme-convert-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'videoConfig.ts'), SAMPLE_VC, 'utf8');
  tmp = dir;
  return dir;
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('convertBurnedInProject', () => {
  it('cutData.ts が無いプロジェクトに恒等 cutData.ts を生成する', () => {
    const dir = makeProjectDir();
    expect(hasCutData(dir)).toBe(false);
    const result = convertBurnedInProject(dir);
    expect(result.cutDataRelPath).toBe('cutData.ts');
    expect(existsSync(join(dir, 'cutData.ts'))).toBe(true);
    expect(hasCutData(dir)).toBe(true);
  });

  it('生成した cutData.ts は動画全体を残す 1 区間（カット 0 件相当）', () => {
    const dir = makeProjectDir();
    convertBurnedInProject(dir);
    const segments = parseCutData(readFileSync(join(dir, 'cutData.ts'), 'utf8'));
    expect(segments).toHaveLength(1);
    expect(segments[0]!.originalStart).toBe(0);
    // sample-project の DURATION_FRAMES は 12000。
    expect(segments[0]!.originalEnd).toBe(12000);
    expect(segments[0]!.playbackStart).toBe(0);
    expect(segments[0]!.playbackEnd).toBe(12000);
  });

  it('cutData.ts が既にあれば HttpError(400) を投げる', () => {
    const dir = makeProjectDir();
    convertBurnedInProject(dir);
    try {
      convertBurnedInProject(dir);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
    }
  });
});
