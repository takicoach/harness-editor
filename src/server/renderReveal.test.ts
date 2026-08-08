/**
 * 「フォルダで表示」の対象解決の回帰。
 *
 * バグ（2026-08-08 ユーザー遭遇）: handleRenderReveal は out/video.mp4 の固定名しか
 * 見ていなかった。実際の出力は renderOutputName(options) で解像度サフィックスが付く
 * （video-720p.mp4 / video-1080p.mp4）ため、720p や 1080p で書き出すと常に 404 に
 * なり、クライアントは 404 を握り潰すのでボタンが「無反応」に見えていた。
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRevealTarget, listOutputVideos } from './renderApi';
import { renderOutputName } from '../shared/renderPreset';

function tmpOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sme-reveal-'));
  mkdirSync(join(dir, 'out'), { recursive: true });
  return dir;
}

/** out/ にファイルを作り、mtime を明示的に置く（最新判定を時刻順で確定させる）。 */
function writeOut(projectDir: string, name: string, mtimeSec: number): string {
  const p = join(projectDir, 'out', name);
  writeFileSync(p, 'x');
  utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

describe('resolveRevealTarget', () => {
  it('ジョブが記録した実出力があればそれを開く（解像度サフィックス付きでも）', () => {
    const dir = tmpOutDir();
    try {
      const recorded = writeOut(dir, 'video-720p.mp4', 1000);
      writeOut(dir, 'video.mp4', 2000); // より新しい別ファイルがあっても記録が優先
      expect(resolveRevealTarget(join(dir, 'out'), recorded)).toEqual({ path: recorded, fallback: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('記録が無くても out/ の最新 mp4 を開く（サーバ再起動後・前回セッションの成果物）', () => {
    const dir = tmpOutDir();
    try {
      writeOut(dir, 'video.mp4', 1000);
      const newer = writeOut(dir, 'video-720p.mp4', 3000);
      expect(resolveRevealTarget(join(dir, 'out'), undefined)).toEqual({ path: realpathSync(newer), fallback: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('記録されたファイルが消えていれば最新 mp4 へフォールバックする', () => {
    const dir = tmpOutDir();
    try {
      const gone = join(dir, 'out', 'video-1080p.mp4');
      const present = writeOut(dir, 'video.mp4', 1000);
      expect(resolveRevealTarget(join(dir, 'out'), gone)).toEqual({ path: realpathSync(present), fallback: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('中間ファイル（.sme-render-tmp-*）は候補にしない', () => {
    const dir = tmpOutDir();
    try {
      const real = writeOut(dir, 'video.mp4', 1000);
      writeOut(dir, '.sme-render-tmp-p-123.mp4', 5000);
      writeOut(dir, '.sme-render-tmp-p-123.mp4.final.mp4', 6000);
      expect(resolveRevealTarget(join(dir, 'out'), undefined)).toEqual({ path: realpathSync(real), fallback: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mp4 が 1 つも無ければ null（呼び出し側が 404 にする）', () => {
    const dir = tmpOutDir();
    try {
      writeOut(dir, 'notes.txt', 1000);
      expect(resolveRevealTarget(join(dir, 'out'), undefined)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('out/ が存在しなくても落ちずに null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sme-reveal-'));
    try {
      expect(resolveRevealTarget(join(dir, 'out'), undefined)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renderOutputName が返す 3 種すべてを候補として拾える（命名と reveal の追従）', () => {
    const dir = tmpOutDir();
    try {
      const names = (['full', '1080p', '720p'] as const).map((resolution) =>
        renderOutputName({ resolution, quality: 'high' }),
      );
      expect(new Set(names).size).toBe(3);
      names.forEach((n, i) => writeOut(dir, n, 1000 + i));
      const found = listOutputVideos(join(dir, 'out')).map((f) => f.name).sort();
      expect(found).toEqual([...names].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveRevealTarget — 封じ込め（M-1）', () => {
  it('out/ の外を指す symlink は候補にしない（ファイラへ外部パスを渡さない）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sme-reveal-'));
    const outside = mkdtempSync(join(tmpdir(), 'sme-outside-'));
    try {
      mkdirSync(join(dir, 'out'), { recursive: true });
      const secret = join(outside, 'secret.mp4');
      writeFileSync(secret, 'x');
      utimesSync(secret, 9000, 9000); // 最新にして「選ばれてしまう」条件を作る
      symlinkSync(secret, join(dir, 'out', 'link.mp4'));
      const real = join(dir, 'out', 'video.mp4');
      writeFileSync(real, 'x');
      utimesSync(real, 1000, 1000);

      const got = resolveRevealTarget(join(dir, 'out'), undefined);
      expect(got?.path).toBe(realpathSync(real));
      expect(listOutputVideos(join(dir, 'out')).map((f) => f.name)).toEqual(['video.mp4']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('壊れた symlink があっても落ちない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sme-reveal-'));
    try {
      mkdirSync(join(dir, 'out'), { recursive: true });
      symlinkSync(join(dir, 'out', 'nope.mp4'), join(dir, 'out', 'broken.mp4'));
      expect(resolveRevealTarget(join(dir, 'out'), undefined)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
