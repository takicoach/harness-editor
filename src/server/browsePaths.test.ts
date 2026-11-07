import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import {
  browseRoots,
  assertPathResponds,
  assertBrowsablePath,
  listDirectory,
  parentOf,
  isBrokenLink,
  canCreateSymlink,
  MAX_BROWSE_ENTRIES,
} from './browsePaths';
import { HttpError } from './http';

function makeTree(): { root: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sme-browse-')));
  mkdirSync(join(root, 'inside', 'sub'), { recursive: true });
  mkdirSync(join(root, 'inside', '.hidden'), { recursive: true });
  writeFileSync(join(root, 'inside', 'a.mp4'), 'x'.repeat(10));
  writeFileSync(join(root, 'inside', 'b.MOV'), 'y'.repeat(20));
  writeFileSync(join(root, 'inside', 'memo.txt'), 'z');
  writeFileSync(join(root, 'inside', '.secret.mp4'), 'z');
  mkdirSync(join(root, 'outside'), { recursive: true });
  writeFileSync(join(root, 'outside', 'other.mp4'), 'o');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('browseRoots', () => {
  it('SME_BROWSE_ROOTS を path.delimiter で分割する（Windows のドライブ文字と衝突しない）', async () => {
    const roots = browseRoots({ SME_BROWSE_ROOTS: ['/a', '/b'].join(delimiter) } as NodeJS.ProcessEnv, '/home/u', () => true);
    expect(roots.map((r) => r.path)).toEqual(['/a', '/b']);
  });

  it('存在しない起点は落とす（外付け未接続なら一覧に出さない）', async () => {
    const roots = browseRoots({} as NodeJS.ProcessEnv, '/home/u', (p) => p === '/Volumes');
    expect(roots.map((r) => r.key)).toEqual(['volumes']);
  });
});

describe('assertBrowsablePath', () => {
  it('起点配下は許可し realpath を返す', async () => {
    const { root, cleanup } = makeTree();
    try {
      const roots = [{ key: 'r', label: 'r', path: join(root, 'inside') }];
      expect(assertBrowsablePath(join(root, 'inside', 'a.mp4'), roots)).toBe(join(root, 'inside', 'a.mp4'));
      // 起点そのものも許可（一覧を開くため）
      expect(assertBrowsablePath(join(root, 'inside'), roots)).toBe(join(root, 'inside'));
    } finally {
      cleanup();
    }
  });

  it('.. で起点の外へ出ようとしたら 403', async () => {
    const { root, cleanup } = makeTree();
    try {
      const roots = [{ key: 'r', label: 'r', path: join(root, 'inside') }];
      expect(() => assertBrowsablePath(join(root, 'inside', '..', 'outside', 'other.mp4'), roots))
        .toThrow(HttpError);
    } finally {
      cleanup();
    }
  });

  it('起点内から外を指すリンク経由の脱出も 403（realpath で判定するため）', async () => {
    const { root, cleanup } = makeTree();
    try {
      symlinkSync(join(root, 'outside', 'other.mp4'), join(root, 'inside', 'escape.mp4'));
      const roots = [{ key: 'r', label: 'r', path: join(root, 'inside') }];
      expect(() => assertBrowsablePath(join(root, 'inside', 'escape.mp4'), roots)).toThrow(HttpError);
    } finally {
      cleanup();
    }
  });

  it('相対パスは 400・存在しないパスは 404', async () => {
    const roots = [{ key: 'r', label: 'r', path: '/tmp' }];
    expect(() => assertBrowsablePath('relative/path.mp4', roots)).toThrow(/絶対パス/);
    expect(() => assertBrowsablePath('/tmp/does-not-exist-xyz.mp4', roots)).toThrow(/見つかりません/);
  });
});

describe('listDirectory', () => {
  it('サブフォルダと動画だけを返し、隠しファイルと非動画は除く', async () => {
    const { root, cleanup } = makeTree();
    try {
      const roots = [{ key: 'r', label: 'r', path: root }];
      const out = await listDirectory(join(root, 'inside'), roots);
      expect(out.dirs.map((d) => d.name)).toEqual(['sub']);
      expect(out.files.map((f) => f.name)).toEqual(['a.mp4', 'b.MOV']);
      expect(out.files[0]?.sizeBytes).toBe(10);
      expect(out.truncated).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('stat に失敗する項目は飛ばす（切れたリンク・権限なしで一覧を落とさない）', async () => {
    const out = await listDirectory('/fake', [], {
      readdir: () => ['ok.mp4', 'broken.mp4'],
      stat: (p) => {
        if (p.endsWith('broken.mp4')) throw new Error('ENOENT');
        return { isDirectory: () => false, isFile: () => true, size: 1 };
      },
      realpath: (p) => p,
    });
    expect(out.files.map((f) => f.name)).toEqual(['ok.mp4']);
  });

  it('件数上限で打ち切り truncated を立てる', async () => {
    const names = Array.from({ length: MAX_BROWSE_ENTRIES + 10 }, (_, i) => `v${i}.mp4`);
    const out = await listDirectory('/fake', [], {
      readdir: () => names,
      stat: () => ({ isDirectory: () => false, isFile: () => true, size: 1 }),
      realpath: (p) => p,
    });
    expect(out.truncated).toBe(true);
    expect(out.files.length).toBe(MAX_BROWSE_ENTRIES);
  });

  it('読めないフォルダは 404', async () => {
    await expect(listDirectory('/fake', [], { readdir: () => { throw new Error('EACCES'); }, realpath: (p) => p })).rejects.toThrow(HttpError);
  });
});

describe('parentOf', () => {
  it('起点そのものからは上がれない', async () => {
    const roots = [{ key: 'r', label: 'r', path: '/root' }];
    expect(parentOf('/root', roots, (p) => p)).toBeNull();
    expect(parentOf('/root/sub', roots, (p) => p)).toBe('/root');
  });
});

describe('isBrokenLink', () => {
  it('切れたリンクだけ true（未配置は false）', async () => {
    const { root, cleanup } = makeTree();
    try {
      symlinkSync(join(root, 'gone.mp4'), join(root, 'link.mp4'));
      expect(isBrokenLink(join(root, 'link.mp4'))).toBe(true);
      expect(isBrokenLink(join(root, 'inside', 'a.mp4'))).toBe(false);
      expect(isBrokenLink(join(root, 'nothing-here.mp4'))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('canCreateSymlink', () => {
  it('作れない環境では理由つきで ok:false', async () => {
    const res = canCreateSymlink(() => { throw new Error('EPERM'); });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('EPERM');
  });

  it('作れれば ok:true', async () => {
    expect(canCreateSymlink(() => { /* noop */ })).toEqual({ ok: true });
  });
});

describe('応答しないドライブがあっても保存場所の選択で止まらない', () => {
  const dirStat = { isDirectory: () => true, isFile: () => false, size: 0 };
  const roots = [{ key: 'v', label: '外付け', path: '/Volumes' }];
  const realpath = (path: string) => path;

  it('一覧が戻らないフォルダは 503 と、どのドライブかの案内で返す', async () => {
    await expect(listDirectory('/Volumes/固まるC', roots, { readdir: () => new Promise<string[]>(() => {}), realpath, limitMs: 20 }))
      .rejects.toMatchObject({ status: 503, message: expect.stringContaining('ドライブ「固まるC」') });
  });

  it('一覧の中で情報が戻らないものだけを除き、他は出す', async () => {
    const listing = await listDirectory('/Volumes', roots, {
      readdir: () => ['固まるD', '正常'], realpath, limitMs: 20,
      stat: (path) => path.endsWith('固まるD') ? new Promise<typeof dirStat>(() => {}) : dirStat,
    });
    expect(listing.dirs.map((dir) => dir.name)).toEqual(['正常']);
  });

  it('選ばれたパスの確認が戻らない時も 503 で返す。起点の外のパスには触れない', async () => {
    const stuck = () => new Promise<string>(() => {});
    await expect(assertPathResponds('/Volumes/固まるE/撮影', roots, { realpath: stuck, limitMs: 20 })).rejects.toMatchObject({ status: 503 });
    let asked = false;
    await assertPathResponds('/etc/秘密', roots, { realpath: async (path) => { asked = true; return path; }, limitMs: 20 });
    expect(asked).toBe(false);
  });
});
