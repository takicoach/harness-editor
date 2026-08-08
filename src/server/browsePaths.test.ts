import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import {
  browseRoots,
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
  it('SME_BROWSE_ROOTS を path.delimiter で分割する（Windows のドライブ文字と衝突しない）', () => {
    const roots = browseRoots({ SME_BROWSE_ROOTS: ['/a', '/b'].join(delimiter) } as NodeJS.ProcessEnv, '/home/u', () => true);
    expect(roots.map((r) => r.path)).toEqual(['/a', '/b']);
  });

  it('存在しない起点は落とす（外付け未接続なら一覧に出さない）', () => {
    const roots = browseRoots({} as NodeJS.ProcessEnv, '/home/u', (p) => p === '/Volumes');
    expect(roots.map((r) => r.key)).toEqual(['volumes']);
  });
});

describe('assertBrowsablePath', () => {
  it('起点配下は許可し realpath を返す', () => {
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

  it('.. で起点の外へ出ようとしたら 403', () => {
    const { root, cleanup } = makeTree();
    try {
      const roots = [{ key: 'r', label: 'r', path: join(root, 'inside') }];
      expect(() => assertBrowsablePath(join(root, 'inside', '..', 'outside', 'other.mp4'), roots))
        .toThrow(HttpError);
    } finally {
      cleanup();
    }
  });

  it('起点内から外を指すリンク経由の脱出も 403（realpath で判定するため）', () => {
    const { root, cleanup } = makeTree();
    try {
      symlinkSync(join(root, 'outside', 'other.mp4'), join(root, 'inside', 'escape.mp4'));
      const roots = [{ key: 'r', label: 'r', path: join(root, 'inside') }];
      expect(() => assertBrowsablePath(join(root, 'inside', 'escape.mp4'), roots)).toThrow(HttpError);
    } finally {
      cleanup();
    }
  });

  it('相対パスは 400・存在しないパスは 404', () => {
    const roots = [{ key: 'r', label: 'r', path: '/tmp' }];
    expect(() => assertBrowsablePath('relative/path.mp4', roots)).toThrow(/絶対パス/);
    expect(() => assertBrowsablePath('/tmp/does-not-exist-xyz.mp4', roots)).toThrow(/見つかりません/);
  });
});

describe('listDirectory', () => {
  it('サブフォルダと動画だけを返し、隠しファイルと非動画は除く', () => {
    const { root, cleanup } = makeTree();
    try {
      const roots = [{ key: 'r', label: 'r', path: root }];
      const out = listDirectory(join(root, 'inside'), roots);
      expect(out.dirs.map((d) => d.name)).toEqual(['sub']);
      expect(out.files.map((f) => f.name)).toEqual(['a.mp4', 'b.MOV']);
      expect(out.files[0]?.sizeBytes).toBe(10);
      expect(out.truncated).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('stat に失敗する項目は飛ばす（切れたリンク・権限なしで一覧を落とさない）', () => {
    const out = listDirectory('/fake', [], {
      readdir: () => ['ok.mp4', 'broken.mp4'],
      stat: (p) => {
        if (p.endsWith('broken.mp4')) throw new Error('ENOENT');
        return { isDirectory: () => false, isFile: () => true, size: 1 };
      },
      realpath: (p) => p,
    });
    expect(out.files.map((f) => f.name)).toEqual(['ok.mp4']);
  });

  it('件数上限で打ち切り truncated を立てる', () => {
    const names = Array.from({ length: MAX_BROWSE_ENTRIES + 10 }, (_, i) => `v${i}.mp4`);
    const out = listDirectory('/fake', [], {
      readdir: () => names,
      stat: () => ({ isDirectory: () => false, isFile: () => true, size: 1 }),
      realpath: (p) => p,
    });
    expect(out.truncated).toBe(true);
    expect(out.files.length).toBe(MAX_BROWSE_ENTRIES);
  });

  it('読めないフォルダは 404', () => {
    expect(() =>
      listDirectory('/fake', [], { readdir: () => { throw new Error('EACCES'); }, realpath: (p) => p }),
    ).toThrow(HttpError);
  });
});

describe('parentOf', () => {
  it('起点そのものからは上がれない', () => {
    const roots = [{ key: 'r', label: 'r', path: '/root' }];
    expect(parentOf('/root', roots, (p) => p)).toBeNull();
    expect(parentOf('/root/sub', roots, (p) => p)).toBe('/root');
  });
});

describe('isBrokenLink', () => {
  it('切れたリンクだけ true（未配置は false）', () => {
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
  it('作れない環境では理由つきで ok:false', () => {
    const res = canCreateSymlink(() => { throw new Error('EPERM'); });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('EPERM');
  });

  it('作れれば ok:true', () => {
    expect(canCreateSymlink(() => { /* noop */ })).toEqual({ ok: true });
  });
});
