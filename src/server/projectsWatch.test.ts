import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { projectIdFromWatchedPath, watchAllProjectsStatus } from './projectsWatch';

describe('projectIdFromWatchedPath', () => {
  const root = '/root/projects';

  it('.sme/status.json のパスからプロジェクト id を取り出す', () => {
    expect(projectIdFromWatchedPath(root, join(root, 'golf-drills', '.sme', 'status.json'))).toBe(
      'golf-drills',
    );
  });

  it('out/video.mp4 のパスからプロジェクト id を取り出す', () => {
    expect(projectIdFromWatchedPath(root, join(root, 'youtube1', 'out', 'video.mp4'))).toBe(
      'youtube1',
    );
  });

  it('root 配下でないパスは null', () => {
    expect(projectIdFromWatchedPath(root, join('/other', 'golf-drills', 'out', 'video.mp4'))).toBeNull();
  });

  it('root 直下のファイル（2階層に満たない）は null', () => {
    expect(projectIdFromWatchedPath(root, join(root, 'stray.json'))).toBeNull();
  });

  it('root 自身のパスは null', () => {
    expect(projectIdFromWatchedPath(root, root)).toBeNull();
  });

  it('隠しディレクトリ配下（.git 等）は null', () => {
    expect(projectIdFromWatchedPath(root, join(root, '.git', 'out', 'video.mp4'))).toBeNull();
  });

  it('プロジェクト名が空文字になるケースは null', () => {
    expect(projectIdFromWatchedPath(root, `${root}${sep}${sep}out${sep}video.mp4`)).toBeNull();
  });
});

describe('watchAllProjectsStatus', () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** projectIdFromWatchedPath 用の最小のハーネス形式プロジェクト体裁を作る（isHarnessProject 判定に必要）。 */
  function makeMinimalProject(dir: string): void {
    mkdirSync(join(dir, 'src', 'テロップテンプレート'), { recursive: true });
    writeFileSync(join(dir, 'src', 'videoConfig.ts'), 'export const videoFile = "main.mp4";\n', 'utf8');
    writeFileSync(
      join(dir, 'src', 'テロップテンプレート', 'telopData.ts'),
      'export const telopData = [];\n',
      'utf8',
    );
  }

  it('停止関数を呼んでも例外を投げない（監視の起動・終了ライフサイクル）', () => {
    root = mkdtempSync(join(tmpdir(), 'sme-projects-watch-'));
    makeMinimalProject(join(root, 'proj-a'));
    mkdirSync(join(root, 'proj-a', '.sme'), { recursive: true });
    writeFileSync(join(root, 'proj-a', '.sme', 'status.json'), '{}\n', 'utf8');

    const events: unknown[] = [];
    const stop = watchAllProjectsStatus(root, (e) => events.push(e));
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
    // 2 回目の停止呼び出しも安全（呼び出し側の二重 close 対策の確認）。
    expect(() => stop()).not.toThrow();
  });

  it('status.json の変更を検知しプロジェクト単位の解決済みステータスを配信する', async () => {
    root = mkdtempSync(join(tmpdir(), 'sme-projects-watch-'));
    const projDir = join(root, 'proj-b');
    makeMinimalProject(projDir);
    mkdirSync(join(projDir, '.sme'), { recursive: true });
    writeFileSync(join(projDir, '.sme', 'status.json'), '{}\n', 'utf8');

    const events: Array<{ id: string; status: string }> = [];
    const stop = watchAllProjectsStatus(
      root,
      (e) => {
        events.push(e as { id: string; status: string });
      },
      { debounceMs: 20 },
    );
    try {
      // chokidar の初回スキャンが終わるのを少し待ってから変更を書き込む。
      await new Promise((r) => setTimeout(r, 200));
      writeFileSync(
        join(projDir, '.sme', 'status.json'),
        JSON.stringify({ stage: 'review' }) + '\n',
        'utf8',
      );
      await new Promise((r) => setTimeout(r, 500));
      expect(events.some((e) => e.id === 'proj-b' && e.status === 'review')).toBe(true);
    } finally {
      stop();
    }
  });

  it('.sme が無いプロジェクトでも初回の status.json 作成を検知する', async () => {
    root = mkdtempSync(join(tmpdir(), 'sme-projects-watch-'));
    const projDir = join(root, 'proj-c');
    makeMinimalProject(projDir); // .sme は作らない（スキルが初めて書くケース）

    const events: Array<{ id: string; activityLabel?: string }> = [];
    const stop = watchAllProjectsStatus(
      root,
      (e) => {
        events.push(e as { id: string; activityLabel?: string });
      },
      { debounceMs: 20 },
    );
    try {
      await new Promise((r) => setTimeout(r, 200));
      mkdirSync(join(projDir, '.sme'), { recursive: true });
      writeFileSync(
        join(projDir, '.sme', 'status.json'),
        JSON.stringify({ activity: { label: 'カット中', startedAt: new Date().toISOString() } }) + '\n',
        'utf8',
      );
      await new Promise((r) => setTimeout(r, 500));
      expect(events.some((e) => e.id === 'proj-c' && e.activityLabel === 'カット中')).toBe(true);
    } finally {
      stop();
    }
  });

  it('プロジェクト内の無関係ファイル変更ではイベントを出さない', async () => {
    root = mkdtempSync(join(tmpdir(), 'sme-projects-watch-'));
    const projDir = join(root, 'proj-d');
    makeMinimalProject(projDir);

    const events: unknown[] = [];
    const stop = watchAllProjectsStatus(root, (e) => events.push(e), { debounceMs: 20 });
    try {
      await new Promise((r) => setTimeout(r, 200));
      writeFileSync(join(projDir, 'note.txt'), 'x', 'utf8');
      await new Promise((r) => setTimeout(r, 400));
      expect(events).toEqual([]);
    } finally {
      stop();
    }
  });
});
