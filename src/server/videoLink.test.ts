import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVideoLink, writeVideoLink, inspectVideoLink, fingerprintMatches } from './videoLink';
import { createProjectLinked } from './createProject';
import { relinkVideo, describeMismatch } from './relinkVideo';

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** createProject が要求する最小テンプレート。 */
function makeTemplate(dir: string): string {
  const t = join(dir, 'template');
  mkdirSync(join(t, 'src'), { recursive: true });
  writeFileSync(
    join(t, 'src', 'videoConfig.ts'),
    [
      "export const FORMAT: VideoFormat = 'youtube';",
      'export const FPS = 30;',
      'export const DURATION_FRAMES = 1;',
      "export const VIDEO_FILE = 'main.mp4';",
    ].join('\n'),
  );
  return t;
}

const PROBED = { fps: 30, durationSeconds: 10, width: 1920, height: 1080 };

describe('videoLink の記録と検査', () => {
  it('書いて読める・壊れた JSON は null', () => {
    const dir = tmp('sme-link-');
    try {
      writeVideoLink(dir, { target: '/Volumes/SSD/a.mp4', sizeBytes: 100, mtimeMs: 1, width: 1920, height: 1080, fps: 30 });
      expect(readVideoLink(dir)?.target).toBe('/Volumes/SSD/a.mp4');
      writeFileSync(join(dir, '.sme', 'videoLink.json'), '{ broken');
      expect(readVideoLink(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('記録が無いプロジェクト（コピー取り込み）は null を返す', () => {
    const dir = tmp('sme-link-');
    try {
      expect(inspectVideoLink(dir, 'main.mp4')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('切れたリンクは broken', () => {
    const dir = tmp('sme-link-');
    try {
      mkdirSync(join(dir, 'public'), { recursive: true });
      symlinkSync(join(dir, 'gone.mp4'), join(dir, 'public', 'main.mp4'));
      writeVideoLink(dir, { target: join(dir, 'gone.mp4'), sizeBytes: 10, mtimeMs: 1, width: 1920, height: 1080, fps: 30 });
      expect(inspectVideoLink(dir, 'main.mp4')).toEqual({ target: join(dir, 'gone.mp4'), state: 'broken' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同じパスに別の動画が置かれたら mismatch（サイズ・mtime で検出）', () => {
    const dir = tmp('sme-link-');
    try {
      mkdirSync(join(dir, 'public'), { recursive: true });
      const target = join(dir, 'src.mp4');
      writeFileSync(target, 'aaaa');
      symlinkSync(target, join(dir, 'public', 'main.mp4'));
      const st = statSync(target);
      writeVideoLink(dir, { target, sizeBytes: st.size, mtimeMs: st.mtimeMs, width: 1920, height: 1080, fps: 30 });
      expect(inspectVideoLink(dir, 'main.mp4')?.state).toBe('ok');

      // 同じパスに別内容（サイズ違い）を置く
      writeFileSync(target, 'bbbbbbbbbb');
      expect(inspectVideoLink(dir, 'main.mp4')?.state).toBe('mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('指紋未記録（旧形式）は判定しない', () => {
    expect(fingerprintMatches(
      { target: '/x', sizeBytes: 0, mtimeMs: 0, width: 0, height: 0, fps: 0 },
      { sizeBytes: 999, mtimeMs: 999 },
    )).toBe(true);
  });
});

describe('createProjectLinked', () => {
  it('実体をコピーせず symlink を張り、接続先と指紋を記録する', () => {
    const base = tmp('sme-linkcreate-');
    try {
      const templateDir = makeTemplate(base);
      const root = join(base, 'projects');
      mkdirSync(root, { recursive: true });
      const target = join(base, 'external.mp4');
      writeFileSync(target, 'video-bytes');

      const { id } = createProjectLinked(root, { name: 'proj', targetPath: target }, {
        templateDir,
        probe: () => PROBED,
      });
      expect(id).toBe('proj');
      const link = join(root, 'proj', 'public', 'main.mp4');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      const record = readVideoLink(join(root, 'proj'));
      expect(record?.target).toBe(target);
      expect(record?.width).toBe(1920);
      expect(inspectVideoLink(join(root, 'proj'), 'main.mp4')?.state).toBe('ok');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('リンクを張れない環境ではプロジェクトを残さない（ロールバック）', () => {
    const base = tmp('sme-linkcreate-');
    try {
      const templateDir = makeTemplate(base);
      const root = join(base, 'projects');
      mkdirSync(root, { recursive: true });
      expect(() =>
        createProjectLinked(root, { name: 'proj', targetPath: join(base, 'x.mp4') }, {
          templateDir,
          probe: () => PROBED,
          link: () => { throw new Error('EPERM'); },
        }),
      ).toThrow('EPERM');
      expect(() => statSync(join(root, 'proj'))).toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('relinkVideo', () => {
  const config = { fps: 30, durationFrames: 300, width: 1920, height: 1080 };

  it('食い違う動画は force なしでは張り替えず警告を返す', () => {
    const dir = tmp('sme-relink-');
    try {
      mkdirSync(join(dir, 'public'), { recursive: true });
      const res = relinkVideo(dir, { targetPath: '/x/other.mp4', videoFile: 'main.mp4', force: false }, config, {
        probe: () => ({ fps: 60, durationSeconds: 10, width: 1280, height: 720 }),
        link: () => { throw new Error('張り替えてはいけない'); },
      });
      expect(res.warnings.length).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('一致する動画はリンクを張り替えて記録を更新する', () => {
    const dir = tmp('sme-relink-');
    try {
      mkdirSync(join(dir, 'public'), { recursive: true });
      const oldTarget = join(dir, 'old.mp4');
      const newTarget = join(dir, 'new.mp4');
      writeFileSync(oldTarget, 'aaa');
      writeFileSync(newTarget, 'bbb');
      symlinkSync(oldTarget, join(dir, 'public', 'main.mp4'));
      writeVideoLink(dir, { target: oldTarget, sizeBytes: 3, mtimeMs: 1, width: 1920, height: 1080, fps: 30 });

      const res = relinkVideo(dir, { targetPath: newTarget, videoFile: 'main.mp4', force: false }, config, {
        probe: () => ({ fps: 30, durationSeconds: 10, width: 1920, height: 1080 }),
      });
      expect(res.warnings).toEqual([]);
      expect(readVideoLink(dir)?.target).toBe(newTarget);
      expect(inspectVideoLink(dir, 'main.mp4')?.state).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('コピー取り込み（実体ファイル）のプロジェクトは張り替えを拒否する', () => {
    const dir = tmp('sme-relink-');
    try {
      mkdirSync(join(dir, 'public'), { recursive: true });
      writeFileSync(join(dir, 'public', 'main.mp4'), 'real-file');
      expect(() =>
        relinkVideo(dir, { targetPath: join(dir, 'x.mp4'), videoFile: 'main.mp4', force: true }, config, {
          probe: () => ({ fps: 30, durationSeconds: 10, width: 1920, height: 1080 }),
        }),
      ).toThrow(/コピーで取り込まれ/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('動画以外の拡張子は弾く', () => {
    expect(() =>
      relinkVideo('/x', { targetPath: '/x/a.txt', videoFile: 'main.mp4', force: true }, config),
    ).toThrow(/動画ファイル/);
  });
});

describe('describeMismatch', () => {
  it('端数のずれは許容する（再エンコードの 1 秒未満の差）', () => {
    expect(describeMismatch({ fps: 30, durationSeconds: 10.5, width: 1920, height: 1080 }, {
      fps: 30, durationFrames: 300, width: 1920, height: 1080,
    })).toEqual([]);
  });
});
