import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  projectIdFromWatchedPath,
  serializeStatusForCompare,
  startupMissedEvents,
  watchAllProjectsStatus,
} from './projectsWatch';

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

  /** projectIdFromWatchedPath 用の最小ハーネス形式の案件体裁を作る（isSuperMovieProject 判定に必要）。 */
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
        JSON.stringify({ stage: 'telop' }) + '\n',
        'utf8',
      );
      await new Promise((r) => setTimeout(r, 500));
      expect(events.some((e) => e.id === 'proj-b' && e.status === 'telop')).toBe(true);
    } finally {
      stop();
    }
  });

  it('out/video.mp4 の作成イベントで steps.rendered === true が差分に載る', async () => {
    root = mkdtempSync(join(tmpdir(), 'sme-projects-watch-'));
    const projDir = join(root, 'proj-steps');
    makeMinimalProject(projDir);

    const events: Array<{ id: string; steps?: { rendered: boolean } }> = [];
    const stop = watchAllProjectsStatus(
      root,
      (e) => {
        events.push(e as { id: string; steps?: { rendered: boolean } });
      },
      { debounceMs: 20 },
    );
    try {
      await new Promise((r) => setTimeout(r, 200));
      mkdirSync(join(projDir, 'out'), { recursive: true });
      writeFileSync(join(projDir, 'out', 'video.mp4'), 'x', 'utf8');
      await new Promise((r) => setTimeout(r, 500));
      expect(events.some((e) => e.id === 'proj-steps' && e.steps?.rendered === true)).toBe(true);
    } finally {
      stop();
    }
  });

  it('stage 非 null → null の変更で stageManual が true → 不在になる（クライアントの解除条件）', async () => {
    root = mkdtempSync(join(tmpdir(), 'sme-projects-watch-'));
    const projDir = join(root, 'proj-manual');
    makeMinimalProject(projDir);
    mkdirSync(join(projDir, '.sme'), { recursive: true });
    writeFileSync(join(projDir, '.sme', 'status.json'), '{}\n', 'utf8');

    const events: Array<{ id: string; stageManual?: boolean }> = [];
    const stop = watchAllProjectsStatus(
      root,
      (e) => {
        events.push(e as { id: string; stageManual?: boolean });
      },
      { debounceMs: 20 },
    );
    try {
      await new Promise((r) => setTimeout(r, 200));
      writeFileSync(join(projDir, '.sme', 'status.json'), JSON.stringify({ stage: 'telop' }) + '\n', 'utf8');
      await new Promise((r) => setTimeout(r, 500));
      expect(events.at(-1)?.stageManual).toBe(true);

      writeFileSync(join(projDir, '.sme', 'status.json'), JSON.stringify({ stage: null }) + '\n', 'utf8');
      await new Promise((r) => setTimeout(r, 500));
      const last = events.at(-1);
      expect(last?.stageManual).toBeUndefined();
      // JSON 化でキーごと落ちる（= クライアント側で明示的に undefined を書き込む必要がある）。
      expect(JSON.stringify(last)).not.toContain('stageManual');
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

  it('監視開始直後（初回スキャン中）に書かれた変更も取りこぼさない', async () => {
    // chokidar は ignoreInitial のため「初回スキャン中に起きた変更」をイベントとして出さない。
    // 監視対象が多い・ディスクが混んでいるほどスキャンは長引き、その窓に書かれた
    // status.json は永久に届かなくなる（実測: フルスイート実行中に AI 作業中表示が
    // 15 秒待っても出ないケースが再現）。ready 時に開始時スナップショットとの差分を
    // 送ることで、この窓の変更も必ず届く。
    root = mkdtempSync(join(tmpdir(), 'sme-projects-watch-'));
    // 窓を実測できる程度に広げるため、複数プロジェクトを置いてスキャンを重くする。
    const dirs = ['ready-a', 'ready-b', 'ready-c', 'ready-d', 'ready-e'].map((n) => join(root, n));
    for (const d of dirs) {
      makeMinimalProject(d);
      mkdirSync(join(d, '.sme'), { recursive: true });
      writeFileSync(join(d, '.sme', 'status.json'), '{}\n', 'utf8');
    }

    const events: Array<{ id: string; status: string }> = [];
    const stop = watchAllProjectsStatus(
      root,
      (e) => {
        events.push(e as { id: string; status: string });
      },
      { debounceMs: 20 },
    );
    try {
      // 監視開始の直後（＝初回スキャンの最中）に書き込む。待たないことが本題。
      writeFileSync(
        join(root, 'ready-a', '.sme', 'status.json'),
        JSON.stringify({ stage: 'telop' }) + '\n',
        'utf8',
      );
      await new Promise((r) => setTimeout(r, 1000));
      expect(events.some((e) => e.id === 'ready-a' && e.status === 'telop')).toBe(true);
    } finally {
      stop();
    }
  });
});

describe('startupMissedEvents', () => {
  it('初回スキャン中に変わったプロジェクトだけを返し、baseline を更新する', () => {
    const baseline = new Map<string, string>([
      ['a', JSON.stringify({ id: 'a', status: 'idle' })],
      ['b', JSON.stringify({ id: 'b', status: 'telop' })],
    ]);
    const current: Record<string, { id: string; status: string }> = {
      a: { id: 'a', status: 'telop' }, // スキャン窓で変わった
      b: { id: 'b', status: 'telop' }, // 変わっていない
    };
    const out = startupMissedEvents(['a', 'b'], baseline, (id) => current[id] as never);
    expect(out.map((e) => e.id)).toEqual(['a']);
    // 二度目は何も返さない（同じ取りこぼしを繰り返し流さない）。
    expect(startupMissedEvents(['a', 'b'], baseline, (id) => current[id] as never)).toEqual([]);
  });

  it('statusSeq だけが違うのはイベントにしない（観測のたびに変わる番号で誤配信しない）', () => {
    // statusSeq は「何回目の観測か」であってプロジェクトの状態ではない。比較に含めると
    // baseline と必ず食い違い、接続のたびに全プロジェクト分の無駄なイベントが流れる。
    const baseline = new Map<string, string>([
      ['a', serializeStatusForCompare({ id: 'a', status: 'idle', statusSeq: 1 } as never)],
    ]);
    const out = startupMissedEvents(['a'], baseline, () => ({ id: 'a', status: 'idle', statusSeq: 999 }) as never);
    expect(out).toEqual([]);
  });

  it('解決できないプロジェクト（削除された等）は飛ばす', () => {
    const baseline = new Map<string, string>([['gone', JSON.stringify({ id: 'gone', status: 'idle' })]]);
    expect(startupMissedEvents(['gone'], baseline, () => null)).toEqual([]);
  });
});
