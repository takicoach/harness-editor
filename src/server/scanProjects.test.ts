import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanProjects, isHarnessProject } from './scanProjects';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

describe('isHarnessProject', () => {
  it('videoConfig.ts と telopData.ts を持つディレクトリを真と判定する', () => {
    expect(isHarnessProject(join(FIXTURE_ROOT, 'sample-project'))).toBe(true);
  });
  it('ハーネス形式でないディレクトリは偽', () => {
    expect(isHarnessProject(FIXTURE_ROOT)).toBe(false);
  });
});

describe('scanProjects', () => {
  it('ルート配下のハーネス形式プロジェクトを列挙する', () => {
    const projects = scanProjects(FIXTURE_ROOT);
    const sample = projects.find((p) => p.id === 'sample-project');
    expect(sample).toBeDefined();
    expect(sample?.orientation).toBe('v');
    expect(sample?.durationLabel).toBe('3:20');
  });
  it('存在しないルートは空配列を返す', () => {
    expect(scanProjects('/no/such/dir/at/all')).toEqual([]);
  });
});
