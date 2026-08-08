import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProjectDir, resolvePublicAsset } from './projectRoot';
import { HttpError } from './http';

const ROOT = '/tmp/sme-root';

describe('resolveProjectDir', () => {
  it('ルート直下のプロジェクトを解決する', () => {
    expect(resolveProjectDir(ROOT, 'my-project')).toBe('/tmp/sme-root/my-project');
  });

  it('ルート自身も許可する', () => {
    expect(resolveProjectDir(ROOT, '.')).toBe(ROOT);
  });

  it('.. でルート外へ出る ID を弾く', () => {
    expect(() => resolveProjectDir(ROOT, '../escape')).toThrow(HttpError);
  });

  it('絶対パスでルート外を指す ID を弾く', () => {
    expect(() => resolveProjectDir(ROOT, '/etc')).toThrow(HttpError);
  });
});

describe('resolveProjectDir シンボリックリンク封じ込め', () => {
  it('ルート外を指すシンボリックリンク経由のパスを拒否する', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'sme-sym-')));
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    // root/escape -> ../outside（ルート外へ脱出するリンク）
    symlinkSync(outside, join(root, 'escape'));
    try {
      expect(() => resolveProjectDir(root, 'escape')).toThrow(/不正なプロジェクトパス/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('ルート配下の実ディレクトリは許可する', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sme-sym-')));
    mkdirSync(join(root, 'proj'));
    try {
      expect(resolveProjectDir(root, 'proj')).toBe(realpathSync(join(root, 'proj')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('存在しないパスは文字列封じ込めで判定する（実体が無くてもルート外は拒否）', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sme-sym-')));
    try {
      expect(() => resolveProjectDir(root, '../escape')).toThrow(/不正なプロジェクトパス/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolvePublicAsset', () => {
  it('public/ 配下の正常なアセットを解決する', () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'sme-asset-')));
    const publicDir = join(projectDir, 'public');
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, 'movie.mp4'), 'data');
    try {
      const result = resolvePublicAsset(projectDir, 'movie.mp4');
      expect(result).toBe(realpathSync(join(publicDir, 'movie.mp4')));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('../ トラバーサルを 400 で弾く', () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'sme-asset-')));
    mkdirSync(join(projectDir, 'public'));
    try {
      expect(() => resolvePublicAsset(projectDir, '../secret')).toThrow(HttpError);
      try {
        resolvePublicAsset(projectDir, '../secret');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(400);
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('絶対パスを 400 で弾く', () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'sme-asset-')));
    mkdirSync(join(projectDir, 'public'));
    try {
      expect(() => resolvePublicAsset(projectDir, '/etc/passwd')).toThrow(HttpError);
      try {
        resolvePublicAsset(projectDir, '/etc/passwd');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(400);
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('存在しないアセットを 404 で弾く', () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'sme-asset-')));
    mkdirSync(join(projectDir, 'public'));
    try {
      expect(() => resolvePublicAsset(projectDir, 'missing.mp4')).toThrow(HttpError);
      try {
        resolvePublicAsset(projectDir, 'missing.mp4');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(404);
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('public/ が存在しないプロジェクトでは 404 を返す（500 にならない）', () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'sme-asset-')));
    // public/ ディレクトリを作らない
    try {
      expect(() => resolvePublicAsset(projectDir, 'movie.mp4')).toThrow(HttpError);
      try {
        resolvePublicAsset(projectDir, 'movie.mp4');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(404);
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('public/ 内のシンボリックリンクがプロジェクト外を指す場合は 400 で弾く', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'sme-asset-')));
    const projectDir = join(base, 'project');
    const outside = join(base, 'outside');
    mkdirSync(projectDir);
    mkdirSync(join(projectDir, 'public'));
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.mp4'), 'secret');
    // public/evil.mp4 -> ../../outside/secret.mp4（プロジェクト外へのシンボリックリンク）
    symlinkSync(join(outside, 'secret.mp4'), join(projectDir, 'public', 'evil.mp4'));
    try {
      expect(() => resolvePublicAsset(projectDir, 'evil.mp4')).toThrow(HttpError);
      try {
        resolvePublicAsset(projectDir, 'evil.mp4');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(400);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
