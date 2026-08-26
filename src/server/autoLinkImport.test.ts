import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planImport, describeCopyReason } from './autoLinkImport';
import type { BrowseRoot } from './browsePaths';

function setup(): { base: string; root: string; ssd: string; tmpPath: string; cleanup: () => void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sme-auto-')));
  const root = join(base, 'projects');
  const ssd = join(base, 'ssd');
  mkdirSync(root, { recursive: true });
  mkdirSync(ssd, { recursive: true });
  const tmpPath = join(root, '.sme-upload-tmp', 'up.tmp');
  mkdirSync(join(root, '.sme-upload-tmp'), { recursive: true });
  writeFileSync(tmpPath, 'video-bytes-0123456789');
  return { base, root, ssd, tmpPath, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function roots(p: string): BrowseRoot[] {
  return [{ key: p, label: p, path: p }];
}

describe('planImport', () => {
  it('外付けに同一実体があればリンク取り込みを選ぶ', () => {
    const { root, ssd, tmpPath, cleanup } = setup();
    try {
      const target = join(ssd, 'take1.mp4');
      writeFileSync(target, 'video-bytes-0123456789');
      const plan = planImport(
        { root, tmpPath, videoName: 'take1.mp4', preferCopy: false },
        { roots: roots(ssd), chunkBytes: 8 },
      );
      expect(plan).toEqual({ link: true, target, sizeBytes: 22 });
    } finally {
      cleanup();
    }
  });

  it('ユーザーがコピーを選んでいたら探索そのものを行わない', () => {
    const { root, ssd, tmpPath, cleanup } = setup();
    try {
      writeFileSync(join(ssd, 'take1.mp4'), 'video-bytes-0123456789');
      let searched = false;
      const plan = planImport(
        { root, tmpPath, videoName: 'take1.mp4', preferCopy: true },
        {
          roots: roots(ssd),
          match: () => { searched = true; return { matched: false, reason: 'no-candidate' }; },
        },
      );
      expect(plan).toEqual({ link: false, reason: 'requested' });
      expect(searched).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('この環境でリンクを作れないならコピーへ落とす', () => {
    const { root, ssd, tmpPath, cleanup } = setup();
    try {
      writeFileSync(join(ssd, 'take1.mp4'), 'video-bytes-0123456789');
      const plan = planImport(
        { root, tmpPath, videoName: 'take1.mp4', preferCopy: false },
        { roots: roots(ssd), chunkBytes: 8, symlinkOk: () => false },
      );
      expect(plan).toEqual({ link: false, reason: 'no-symlink-support' });
    } finally {
      cleanup();
    }
  });

  it('プロジェクト置き場の中は探索しない（取り込み済みのコピーを自分の実体にしない）', () => {
    const { root, tmpPath, cleanup } = setup();
    try {
      // 起点にプロジェクト置き場そのものを指定しても、その配下は候補にならない。
      mkdirSync(join(root, 'p1', 'public'), { recursive: true });
      writeFileSync(join(root, 'p1', 'public', 'take1.mp4'), 'video-bytes-0123456789');
      const plan = planImport(
        { root, tmpPath, videoName: 'take1.mp4', preferCopy: false },
        { roots: roots(root), chunkBytes: 8 },
      );
      expect(plan).toEqual({ link: false, reason: 'no-candidate' });
    } finally {
      cleanup();
    }
  });

  it('候補が無ければコピー（理由を持ち帰る）', () => {
    const { root, ssd, tmpPath, cleanup } = setup();
    try {
      const plan = planImport(
        { root, tmpPath, videoName: 'take1.mp4', preferCopy: false },
        { roots: roots(ssd), chunkBytes: 8 },
      );
      expect(plan).toEqual({ link: false, reason: 'no-candidate' });
    } finally {
      cleanup();
    }
  });

  it('探索が例外を投げてもコピーへ落として作成をブロックしない', () => {
    const { root, ssd, tmpPath, cleanup } = setup();
    try {
      const plan = planImport(
        { root, tmpPath, videoName: 'take1.mp4', preferCopy: false },
        { roots: roots(ssd), match: () => { throw new Error('boom'); } },
      );
      expect(plan).toEqual({ link: false, reason: 'search-failed' });
    } finally {
      cleanup();
    }
  });
});

describe('describeCopyReason', () => {
  it('理由ごとに非エンジニア向けの説明を返す', () => {
    expect(describeCopyReason('no-candidate')).toContain('コピー');
    expect(describeCopyReason('ambiguous')).toContain('複数');
    expect(describeCopyReason('content-mismatch')).toContain('中身');
    expect(describeCopyReason('requested')).toContain('コピー');
  });

  it('探索の打ち切りは「無かった」と区別して伝える（I-4）', () => {
    const text = describeCopyReason('search-truncated');
    expect(text).toContain('探索を途中で打ち切りました');
    expect(text).toContain('登録フォルダを絞ると見つかることがあります');
  });

  it('リンク作成に失敗してコピーへ落ちた場合も理由を持つ（I-3）', () => {
    expect(describeCopyReason('link-failed')).toContain('コピー');
  });
});
