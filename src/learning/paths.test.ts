import { describe, it, expect, afterEach } from 'vitest';
import {
  projectLearningDir,
  baselineDir,
  historyDir,
  globalStoreDir,
  typoDictPath,
  typoDictMetaPath,
  backupsDir,
} from './paths';

describe('project paths', () => {
  it('プロジェクトの .learning レイアウトを返す', () => {
    expect(projectLearningDir('/p')).toBe('/p/.learning');
    expect(baselineDir('/p')).toBe('/p/.learning/baseline');
    expect(historyDir('/p')).toBe('/p/.learning/history');
  });
});

describe('global store paths', () => {
  const originalNew = process.env.HARNESS_LEARNING_HOME;
  const originalOld = process.env.SUPERMOVIE_LEARNING_HOME;
  afterEach(() => {
    if (originalNew === undefined) delete process.env.HARNESS_LEARNING_HOME;
    else process.env.HARNESS_LEARNING_HOME = originalNew;
    if (originalOld === undefined) delete process.env.SUPERMOVIE_LEARNING_HOME;
    else process.env.SUPERMOVIE_LEARNING_HOME = originalOld;
  });

  it('HARNESS_LEARNING_HOME があればそれを使う', () => {
    process.env.HARNESS_LEARNING_HOME = '/tmp/store';
    delete process.env.SUPERMOVIE_LEARNING_HOME;
    expect(globalStoreDir()).toBe('/tmp/store');
    expect(typoDictPath()).toBe('/tmp/store/typo_dict.json');
    expect(typoDictMetaPath()).toBe('/tmp/store/typo_dict.meta.json');
    expect(backupsDir()).toBe('/tmp/store/backups');
  });

  it('旧 SUPERMOVIE_LEARNING_HOME もフォールバックとして有効（新名が優先）', () => {
    delete process.env.HARNESS_LEARNING_HOME;
    process.env.SUPERMOVIE_LEARNING_HOME = '/tmp/old-store';
    expect(globalStoreDir()).toBe('/tmp/old-store');
    process.env.HARNESS_LEARNING_HOME = '/tmp/new-store';
    expect(globalStoreDir()).toBe('/tmp/new-store');
  });

  it('未設定なら ~/.supermovie-learning を使う', () => {
    delete process.env.HARNESS_LEARNING_HOME;
    delete process.env.SUPERMOVIE_LEARNING_HOME;
    expect(globalStoreDir().endsWith('/.supermovie-learning')).toBe(true);
  });
});
