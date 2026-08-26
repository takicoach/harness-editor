import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MATCH_LIMITS,
  defaultMatchLimits,
  chunkDigest,
  findSizeMatches,
  findLinkTarget,
} from './matchVideoSource';
import type { BrowseRoot } from './browsePaths';

function tmpRoot(prefix: string): { root: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function roots(...paths: string[]): BrowseRoot[] {
  return paths.map((p) => ({ key: p, label: p, path: p }));
}

/** 決定的な擬似ランダム中身（同じ seed なら同一バイト列）。 */
function body(seed: number, bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  let x = seed >>> 0;
  for (let i = 0; i < bytes; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

describe('findSizeMatches', () => {
  it('名前とサイズが一致する動画だけを拾う', () => {
    const { root, cleanup } = tmpRoot('sme-match-');
    try {
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'sub', 'a.mp4'), 'x'.repeat(10));
      writeFileSync(join(root, 'sub', 'b.mp4'), 'x'.repeat(10)); // 名前違い
      writeFileSync(join(root, 'a.mp4'), 'x'.repeat(11)); // サイズ違い
      const r = findSizeMatches(roots(root), { name: 'a.mp4', sizeBytes: 10 });
      expect(r.candidates.map((c) => c.path)).toEqual([join(root, 'sub', 'a.mp4')]);
      expect(r.exhausted).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('name=null ならサイズ一致だけで拾う（コピー実体は元の名前を失っているため）', () => {
    const { root, cleanup } = tmpRoot('sme-match-');
    try {
      writeFileSync(join(root, 'zzz.mov'), 'x'.repeat(10));
      const r = findSizeMatches(roots(root), { name: null, sizeBytes: 10 });
      expect(r.candidates.map((c) => c.path)).toEqual([join(root, 'zzz.mov')]);
    } finally {
      cleanup();
    }
  });

  it('動画以外の拡張子・隠しファイル・隠しフォルダは見ない', () => {
    const { root, cleanup } = tmpRoot('sme-match-');
    try {
      writeFileSync(join(root, 'a.txt'), 'x'.repeat(10));
      writeFileSync(join(root, '.a.mp4'), 'x'.repeat(10));
      mkdirSync(join(root, '.hidden'), { recursive: true });
      writeFileSync(join(root, '.hidden', 'a.mp4'), 'x'.repeat(10));
      const r = findSizeMatches(roots(root), { name: null, sizeBytes: 10 });
      expect(r.candidates).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('symlink は辿らない（ファイルもフォルダも）', () => {
    const { root, cleanup } = tmpRoot('sme-match-');
    try {
      mkdirSync(join(root, 'real'), { recursive: true });
      writeFileSync(join(root, 'real', 'a.mp4'), 'x'.repeat(10));
      mkdirSync(join(root, 'roots'), { recursive: true });
      symlinkSync(join(root, 'real'), join(root, 'roots', 'linkdir'));
      symlinkSync(join(root, 'real', 'a.mp4'), join(root, 'roots', 'a.mp4'));
      const r = findSizeMatches(roots(join(root, 'roots')), { name: null, sizeBytes: 10 });
      expect(r.candidates).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('FIFO 等の非通常ファイルは statSync isFile で弾く（size=0 でも上限を素通りさせない）', () => {
    if (process.platform === 'win32') return;
    const { root, cleanup } = tmpRoot('sme-match-');
    try {
      const fifo = join(root, 'pipe.mp4');
      execFileSync('mkfifo', [fifo]);
      const r = findSizeMatches(roots(root), { name: null, sizeBytes: 0 });
      expect(r.candidates).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('exclude 配下は走査しない（プロジェクト置き場の自分自身を候補にしない）', () => {
    const { root, cleanup } = tmpRoot('sme-match-');
    try {
      mkdirSync(join(root, 'projects', 'p1', 'public'), { recursive: true });
      writeFileSync(join(root, 'projects', 'p1', 'public', 'main.mp4'), 'x'.repeat(10));
      const r = findSizeMatches(
        roots(root),
        { name: null, sizeBytes: 10 },
        { exclude: [join(root, 'projects')] },
      );
      expect(r.candidates).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('深さ上限を超えたフォルダへは降りない（exhausted になる）', () => {
    const { root, cleanup } = tmpRoot('sme-match-');
    try {
      const deep = join(root, 'a', 'b', 'c');
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, 'x.mp4'), 'x'.repeat(10));
      const r = findSizeMatches(
        roots(root),
        { name: null, sizeBytes: 10 },
        { limits: { ...DEFAULT_MATCH_LIMITS, maxDepth: 1 } },
      );
      expect(r.candidates).toEqual([]);
      expect(r.exhausted).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('件数上限で打ち切る（exhausted になる）', () => {
    const { root, cleanup } = tmpRoot('sme-match-');
    try {
      for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.txt`), 'y');
      writeFileSync(join(root, 'zz.mp4'), 'x'.repeat(10));
      const r = findSizeMatches(
        roots(root),
        { name: null, sizeBytes: 10 },
        { limits: { ...DEFAULT_MATCH_LIMITS, maxEntries: 3 } },
      );
      expect(r.exhausted).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('時間上限を超えたら打ち切る', () => {
    const { root, cleanup } = tmpRoot('sme-match-');
    try {
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'sub', 'a.mp4'), 'x'.repeat(10));
      let t = 0;
      const r = findSizeMatches(
        roots(root),
        { name: null, sizeBytes: 10 },
        { limits: { ...DEFAULT_MATCH_LIMITS, maxMillis: 5 }, now: () => (t += 100) },
      );
      expect(r.exhausted).toBe(true);
      expect(r.candidates).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('同名同サイズが 2 件見つかった時点で打ち切る（曖昧確定のため走査を続けない）', () => {
    const { root, cleanup } = tmpRoot('sme-match-');
    try {
      writeFileSync(join(root, 'a.mp4'), 'x'.repeat(10));
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'sub', 'a.mp4'), 'x'.repeat(10));
      writeFileSync(join(root, 'sub', 'a2.mp4'), 'x'.repeat(10));
      const r = findSizeMatches(roots(root), { name: null, sizeBytes: 10 });
      expect(r.candidates.length).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('入れ子の起点で同じ実体を二重に数えない（realpath で重複排除・M-1）', () => {
    const { root, cleanup } = tmpRoot('sme-match-');
    try {
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'sub', 'a.mp4'), 'x'.repeat(10));
      // 「外付け全体」と「その中の撮影フォルダ」の両方が登録されているのは普通の設定。
      // 重複排除しないと 1 本の動画が 2 候補になり ambiguous でリンク化できなくなる。
      const r = findSizeMatches(roots(root, join(root, 'sub')), { name: null, sizeBytes: 10 });
      expect(r.candidates.map((c) => c.path)).toEqual([join(root, 'sub', 'a.mp4')]);
    } finally {
      cleanup();
    }
  });

  it('読めない起点は飛ばす（未接続の外付けで全体を落とさない）', () => {
    const { root, cleanup } = tmpRoot('sme-match-');
    try {
      writeFileSync(join(root, 'a.mp4'), 'x'.repeat(10));
      const r = findSizeMatches(roots(join(root, 'nope'), root), { name: null, sizeBytes: 10 });
      expect(r.candidates.map((c) => c.path)).toEqual([join(root, 'a.mp4')]);
    } finally {
      cleanup();
    }
  });
});

describe('chunkDigest', () => {
  it('同じ内容なら同じ、1 バイト違えば違う（末尾の差も検出する）', () => {
    const { root, cleanup } = tmpRoot('sme-digest-');
    try {
      const a = body(1, 3000);
      const b = Buffer.from(a);
      b[b.length - 1] = (b[b.length - 1]! + 1) & 0xff;
      writeFileSync(join(root, 'a.bin'), a);
      writeFileSync(join(root, 'a2.bin'), a);
      writeFileSync(join(root, 'b.bin'), b);
      const da = chunkDigest(join(root, 'a.bin'), a.length, 1024);
      expect(chunkDigest(join(root, 'a2.bin'), a.length, 1024)).toBe(da);
      expect(chunkDigest(join(root, 'b.bin'), b.length, 1024)).not.toBe(da);
    } finally {
      cleanup();
    }
  });

  it('チャンクより小さいファイルでも全体を読む', () => {
    const { root, cleanup } = tmpRoot('sme-digest-');
    try {
      writeFileSync(join(root, 'a.bin'), 'abc');
      writeFileSync(join(root, 'b.bin'), 'abd');
      expect(chunkDigest(join(root, 'a.bin'), 3, 1024)).not.toBe(
        chunkDigest(join(root, 'b.bin'), 3, 1024),
      );
    } finally {
      cleanup();
    }
  });
});

describe('findLinkTarget', () => {
  function setup(): { root: string; cleanup: () => void; src: string } {
    const { root, cleanup } = tmpRoot('sme-link-');
    mkdirSync(join(root, 'ssd'), { recursive: true });
    mkdirSync(join(root, 'work'), { recursive: true });
    const src = join(root, 'work', 'upload.tmp');
    writeFileSync(src, body(7, 5000));
    return { root, cleanup, src };
  }

  it('同名・同サイズ・内容一致の 1 件だけが見つかればリンク先になる', () => {
    const { root, cleanup, src } = setup();
    try {
      const target = join(root, 'ssd', 'DJI_0688.mp4');
      writeFileSync(target, body(7, 5000));
      const out = findLinkTarget(
        { path: src, name: 'DJI_0688.mp4', sizeBytes: statSync(src).size },
        roots(join(root, 'ssd')),
        { chunkBytes: 1024 },
      );
      expect(out).toEqual({
        matched: true,
        target,
        sizeBytes: 5000,
        mtimeMs: statSync(target).mtimeMs,
      });
    } finally {
      cleanup();
    }
  });

  it('候補が無ければ no-candidate（＝従来どおりコピー）', () => {
    const { root, cleanup, src } = setup();
    try {
      const out = findLinkTarget(
        { path: src, name: 'DJI_0688.mp4', sizeBytes: 5000 },
        roots(join(root, 'ssd')),
        { chunkBytes: 1024 },
      );
      expect(out).toEqual({ matched: false, reason: 'no-candidate' });
    } finally {
      cleanup();
    }
  });

  it('候補 0 でも探索を打ち切っていたら search-truncated（「無い」と言い切らない）', () => {
    const { root, cleanup, src } = setup();
    try {
      const out = findLinkTarget(
        { path: src, name: 'DJI_0688.mp4', sizeBytes: 5000 },
        roots(join(root, 'ssd')),
        {
          chunkBytes: 1024,
          find: () => ({ candidates: [], exhausted: true }),
        },
      );
      expect(out).toEqual({ matched: false, reason: 'search-truncated' });
    } finally {
      cleanup();
    }
  });

  /**
   * 打ち切りは「候補 0」だけの問題ではない。上限に当たって走査を止めた時点で
   * **一意性は確立していない** — 未走査の領域に同名同サイズの別ファイルが
   * 残っているかもしれない。候補が 1 件でも「これしか無い」の証明にはならないので、
   * ambiguous（2 件以上）と同じくリンク化しない。
   * 取り違えは「別の動画で編集を続ける」という静かな事故になるため、
   * リンク化の成功率よりも取り違えの回避を優先する。
   */
  it('打ち切り中は候補 1 件でも一意と見なさず search-truncated', () => {
    const { root, cleanup, src } = setup();
    try {
      const twin = join(root, 'ssd', 'DJI_0688.mp4');
      const out = findLinkTarget(
        { path: src, name: 'DJI_0688.mp4', sizeBytes: 5000 },
        roots(join(root, 'ssd')),
        {
          chunkBytes: 1024,
          // 中身は完全一致する（＝打ち切りが無ければ matched になる候補）。
          find: () => ({
            candidates: [{ path: twin, sizeBytes: 5000, mtimeMs: 1 }],
            exhausted: true,
          }),
        },
      );
      expect(out).toEqual({ matched: false, reason: 'search-truncated' });
    } finally {
      cleanup();
    }
  });

  it('同名同サイズが複数なら ambiguous（内容を見るまでもなくリンク化しない）', () => {
    const { root, cleanup, src } = setup();
    try {
      writeFileSync(join(root, 'ssd', 'DJI_0688.mp4'), body(7, 5000));
      mkdirSync(join(root, 'ssd', 'backup'), { recursive: true });
      writeFileSync(join(root, 'ssd', 'backup', 'DJI_0688.mp4'), body(7, 5000));
      const out = findLinkTarget(
        { path: src, name: 'DJI_0688.mp4', sizeBytes: 5000 },
        roots(join(root, 'ssd')),
        { chunkBytes: 1024 },
      );
      expect(out).toEqual({ matched: false, reason: 'ambiguous' });
    } finally {
      cleanup();
    }
  });

  it('同名同サイズでも内容が違えば content-mismatch', () => {
    const { root, cleanup, src } = setup();
    try {
      writeFileSync(join(root, 'ssd', 'DJI_0688.mp4'), body(9, 5000));
      const out = findLinkTarget(
        { path: src, name: 'DJI_0688.mp4', sizeBytes: 5000 },
        roots(join(root, 'ssd')),
        { chunkBytes: 1024 },
      );
      expect(out).toEqual({ matched: false, reason: 'content-mismatch' });
    } finally {
      cleanup();
    }
  });

  it('サイズ 0 は決してマッチさせない（空ファイル同士の偶然一致を避ける）', () => {
    const { root, cleanup } = tmpRoot('sme-link-');
    try {
      writeFileSync(join(root, 'empty.mp4'), '');
      const out = findLinkTarget(
        { path: join(root, 'empty.mp4'), name: 'empty.mp4', sizeBytes: 0 },
        roots(root),
        { chunkBytes: 1024 },
      );
      expect(out).toEqual({ matched: false, reason: 'no-candidate' });
    } finally {
      cleanup();
    }
  });

  it('読み取りに失敗したら unreadable（例外にせずコピー経路へ落とす）', () => {
    const { root, cleanup, src } = setup();
    try {
      const target = join(root, 'ssd', 'DJI_0688.mp4');
      writeFileSync(target, body(7, 5000));
      const out = findLinkTarget(
        { path: src, name: 'DJI_0688.mp4', sizeBytes: 5000 },
        roots(join(root, 'ssd')),
        { chunkBytes: 1024, digest: () => { throw new Error('boom'); } },
      );
      expect(out).toEqual({ matched: false, reason: 'unreadable' });
    } finally {
      cleanup();
    }
  });
});

describe('defaultMatchLimits', () => {
  const KEY = 'HARNESS_LINK_SCAN_MS';
  const prev = process.env[KEY];
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  it('既定の探索時間は 3 秒（エディタが止まって見える時間を短く保つ）', () => {
    delete process.env[KEY];
    expect(defaultMatchLimits().maxMillis).toBe(3000);
  });

  it('HARNESS_LINK_SCAN_MS で上書きできる', () => {
    process.env[KEY] = '12000';
    expect(defaultMatchLimits().maxMillis).toBe(12000);
  });

  it('数値でない・0 以下の指定は無視して既定へ落とす', () => {
    process.env[KEY] = 'あとで';
    expect(defaultMatchLimits().maxMillis).toBe(3000);
    process.env[KEY] = '0';
    expect(defaultMatchLimits().maxMillis).toBe(3000);
  });
});
