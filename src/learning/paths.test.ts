import { describe, it, expect, afterEach, vi } from 'vitest';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  projectLearningDir,
  baselineDir,
  historyDir,
  globalStoreDir,
  typoDictPath,
  typoDictMetaPath,
  backupsDir,
  cutFeedbackPath,
  withLearningHome,
} from './paths';

describe('project paths', () => {
  it('プロジェクトの .learning レイアウトを返す', () => {
    expect(projectLearningDir('/p')).toBe('/p/.learning');
    expect(baselineDir('/p')).toBe('/p/.learning/baseline');
    expect(historyDir('/p')).toBe('/p/.learning/history');
  });
});

describe('global store paths', () => {
  const original = process.env.SUPERMOVIE_LEARNING_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.SUPERMOVIE_LEARNING_HOME;
    else process.env.SUPERMOVIE_LEARNING_HOME = original;
  });

  it('SUPERMOVIE_LEARNING_HOME があればそれを使う', () => {
    process.env.SUPERMOVIE_LEARNING_HOME = '/tmp/store';
    expect(globalStoreDir()).toBe('/tmp/store');
    expect(typoDictPath()).toBe('/tmp/store/typo_dict.json');
    expect(typoDictMetaPath()).toBe('/tmp/store/typo_dict.meta.json');
    expect(backupsDir()).toBe('/tmp/store/backups');
  });

  it('未設定なら新しい保存先、旧保存先があれば旧保存先を使う', () => {
    const home=mkdtempSync(join(tmpdir(),'learning-paths-'));
    try {
      expect(globalStoreDir({},home)).toBe(join(home,'.video-harness-learning'));
      mkdirSync(join(home,'.supermovie-learning'));
      expect(globalStoreDir({},home)).toBe(join(home,'.supermovie-learning'));
      mkdirSync(join(home,'.video-harness-learning'));
      expect(globalStoreDir({},home)).toBe(join(home,'.video-harness-learning'));
    } finally { rmSync(home,{recursive:true,force:true}); }
  });
});

describe('withLearningHome', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('実行中は環境変数が変わっても固定した保存先を返し、終わったら元の解決順へ戻す', () => {
    vi.stubEnv('HARNESS_LEARNING_HOME', '/tmp/first');
    const seen = withLearningHome('/tmp/pinned', () => {
      vi.stubEnv('HARNESS_LEARNING_HOME', '/tmp/second');
      return [globalStoreDir(), cutFeedbackPath()];
    });
    expect(seen).toEqual(['/tmp/pinned', '/tmp/pinned/cut_feedback.jsonl']);
    expect(globalStoreDir()).toBe('/tmp/second');
  });

  it('例外が出ても固定を外す', () => {
    vi.stubEnv('HARNESS_LEARNING_HOME', '/tmp/after');
    expect(() => withLearningHome('/tmp/pinned', () => { throw new Error('boom'); })).toThrow('boom');
    expect(globalStoreDir()).toBe('/tmp/after');
  });

  it('Promise を返す処理は受け付けない', () => {
    expect(() => withLearningHome('/tmp/pinned', async () => 1)).toThrow('同期処理だけ');
  });

  it('Promise を返して後から失敗しても、未処理の reject にしない', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() =>
        withLearningHome('/tmp/pinned', async () => {
          throw new Error('late');
        }),
      ).toThrow('同期処理だけ');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('入れ子で使うと、内側が終われば外側の固定へ、外側が終われば元の解決順へ戻る', () => {
    vi.stubEnv('HARNESS_LEARNING_HOME', '/tmp/env');
    const seen = withLearningHome('/tmp/outer', () => {
      const inner = withLearningHome('/tmp/inner', () => globalStoreDir());
      const afterInner = globalStoreDir();
      expect(() => withLearningHome('/tmp/inner-throw', () => { throw new Error('boom'); })).toThrow('boom');
      return [inner, afterInner, globalStoreDir()];
    });
    expect(seen).toEqual(['/tmp/inner', '/tmp/outer', '/tmp/outer']);
    expect(globalStoreDir()).toBe('/tmp/env');
  });

  it('固定中は明示した引数（env・home）より固定値を優先する', () => {
    const explicit = { HARNESS_LEARNING_HOME: '/tmp/explicit' };
    expect(withLearningHome('/tmp/pinned', () => globalStoreDir(explicit, '/tmp/home'))).toBe('/tmp/pinned');
    expect(globalStoreDir(explicit, '/tmp/home')).toBe('/tmp/explicit');
  });
});
