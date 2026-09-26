import { describe, expect, it, vi } from 'vitest';
import { sweepCaptureTmpDirs } from './captureTmpSweep';

describe('sweepCaptureTmpDirs — I-2a 起動時GC', () => {
  it('全プロジェクトの out/ 配下の .capture-* だけを削除する（他ファイルは残す）', () => {
    const rmSync = vi.fn();
    const isSuperMovieProject = vi.fn((dir: string) => dir === '/root/pj1' || dir === '/root/pj2');
    const readdirSync = vi.fn((dir: string): string[] => {
      if (dir === '/root') return ['pj1', 'pj2', '.hidden', 'not-a-project'];
      if (dir === '/root/pj1/out') return ['.capture-telop-abc123', 'video.mp4', '.capture-image-def456-seq0'];
      if (dir === '/root/pj2/out') return ['video.mp4'];
      throw new Error(`unexpected readdirSync(${dir})`);
    });
    const statSync = vi.fn((path: string) => ({
      isDirectory: () => path === '/root/pj1' || path === '/root/pj2' || path === '/root/not-a-project',
    }));

    sweepCaptureTmpDirs('/root', { readdirSync, statSync, rmSync, isSuperMovieProject });

    expect(rmSync).toHaveBeenCalledTimes(2);
    expect(rmSync).toHaveBeenCalledWith('/root/pj1/out/.capture-telop-abc123', { recursive: true, force: true });
    expect(rmSync).toHaveBeenCalledWith('/root/pj1/out/.capture-image-def456-seq0', {
      recursive: true,
      force: true,
    });
    // pj2 の out/ には .capture-* が無いので触らない。
    expect(rmSync).not.toHaveBeenCalledWith(expect.stringContaining('video.mp4'), expect.anything());
  });

  it('ハーネス形式の案件でないディレクトリ（not-a-project）は out/ を走査しない', () => {
    const rmSync = vi.fn();
    const readdirSync = vi.fn((dir: string): string[] => {
      if (dir === '/root') return ['not-a-project'];
      throw new Error(`予期しない readdirSync(${dir})（プロジェクトでないディレクトリの out/ を走査した）`);
    });
    const statSync = vi.fn(() => ({ isDirectory: () => true }));
    const isSuperMovieProject = vi.fn(() => false);

    sweepCaptureTmpDirs('/root', { readdirSync, statSync, rmSync, isSuperMovieProject });

    expect(rmSync).not.toHaveBeenCalled();
  });

  it('root の readdirSync が失敗しても throw しない（起動を止めない）', () => {
    const rmSync = vi.fn();
    const readdirSync = vi.fn(() => {
      throw new Error('EACCES');
    });
    const statSync = vi.fn(() => ({ isDirectory: () => true }));
    const isSuperMovieProject = vi.fn(() => true);

    expect(() =>
      sweepCaptureTmpDirs('/root', { readdirSync, statSync, rmSync, isSuperMovieProject }),
    ).not.toThrow();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it('1件の rmSync 失敗が他のエントリの掃除を止めない', () => {
    const rmSync = vi.fn((path: string) => {
      if (path === '/root/pj1/out/.capture-a') throw new Error('EBUSY');
    });
    const readdirSync = vi.fn((dir: string): string[] => {
      if (dir === '/root') return ['pj1'];
      if (dir === '/root/pj1/out') return ['.capture-a', '.capture-b'];
      throw new Error(`unexpected readdirSync(${dir})`);
    });
    const statSync = vi.fn(() => ({ isDirectory: () => true }));
    const isSuperMovieProject = vi.fn(() => true);

    expect(() =>
      sweepCaptureTmpDirs('/root', { readdirSync, statSync, rmSync, isSuperMovieProject }),
    ).not.toThrow();
    expect(rmSync).toHaveBeenCalledWith('/root/pj1/out/.capture-a', { recursive: true, force: true });
    expect(rmSync).toHaveBeenCalledWith('/root/pj1/out/.capture-b', { recursive: true, force: true });
  });

  it('out/ が存在しないプロジェクト（readdirSync が throw）は無視して次へ進む', () => {
    const rmSync = vi.fn();
    const readdirSync = vi.fn((dir: string): string[] => {
      if (dir === '/root') return ['pj-no-out', 'pj2'];
      if (dir === '/root/pj-no-out/out') throw new Error('ENOENT');
      if (dir === '/root/pj2/out') return ['.capture-x'];
      throw new Error(`unexpected readdirSync(${dir})`);
    });
    const statSync = vi.fn(() => ({ isDirectory: () => true }));
    const isSuperMovieProject = vi.fn(() => true);

    sweepCaptureTmpDirs('/root', { readdirSync, statSync, rmSync, isSuperMovieProject });

    expect(rmSync).toHaveBeenCalledTimes(1);
    expect(rmSync).toHaveBeenCalledWith('/root/pj2/out/.capture-x', { recursive: true, force: true });
  });

  it('焦点再レビュー必須1: cut-filter-{token}.txt / .shape-{i}-{token}.png も掃除対象（非撮影経路のクラッシュ残骸）', () => {
    const rmSync = vi.fn();
    const readdirSync = vi.fn((dir: string): string[] => {
      if (dir === '/root') return ['pj1'];
      if (dir === '/root/pj1/out') {
        return [
          'cut-filter-mtj1sika-s6ah45.txt',
          '.shape-0-mtj1sika-s6ah45.png',
          '.shape-1-mtj1sika-s6ah45.png',
          'video.mp4',
          'cut-filter-not-a-txt', // 拡張子違いは対象外
          'shape-0.png', // 先頭ドット無しは対象外（別ファイルと誤認しない）
        ];
      }
      throw new Error(`unexpected readdirSync(${dir})`);
    });
    const statSync = vi.fn(() => ({ isDirectory: () => true }));
    const isSuperMovieProject = vi.fn(() => true);

    sweepCaptureTmpDirs('/root', { readdirSync, statSync, rmSync, isSuperMovieProject });

    expect(rmSync).toHaveBeenCalledTimes(3);
    expect(rmSync).toHaveBeenCalledWith('/root/pj1/out/cut-filter-mtj1sika-s6ah45.txt', {
      recursive: true,
      force: true,
    });
    expect(rmSync).toHaveBeenCalledWith('/root/pj1/out/.shape-0-mtj1sika-s6ah45.png', {
      recursive: true,
      force: true,
    });
    expect(rmSync).toHaveBeenCalledWith('/root/pj1/out/.shape-1-mtj1sika-s6ah45.png', {
      recursive: true,
      force: true,
    });
    expect(rmSync).not.toHaveBeenCalledWith(expect.stringContaining('video.mp4'), expect.anything());
    expect(rmSync).not.toHaveBeenCalledWith(expect.stringContaining('cut-filter-not-a-txt'), expect.anything());
    expect(rmSync).not.toHaveBeenCalledWith(expect.stringContaining('/shape-0.png'), expect.anything());
  });

  it('焦点再レビュー推奨4: guard:false（多重起動時）は sweep 全体を no-op にする', () => {
    const rmSync = vi.fn();
    const readdirSync = vi.fn(() => {
      throw new Error('readdirSync が呼ばれてはいけない（guard:false は root の走査自体をしない）');
    });
    const statSync = vi.fn();
    const isSuperMovieProject = vi.fn();

    expect(() =>
      sweepCaptureTmpDirs('/root', { readdirSync, statSync, rmSync, isSuperMovieProject, guard: false }),
    ).not.toThrow();
    expect(rmSync).not.toHaveBeenCalled();
    expect(readdirSync).not.toHaveBeenCalled();
  });

  it('guard 省略時は既定で掃除する（guard:true 明示と同じ）', () => {
    const rmSync = vi.fn();
    const readdirSync = vi.fn((dir: string): string[] => {
      if (dir === '/root') return ['pj1'];
      if (dir === '/root/pj1/out') return ['.capture-x'];
      throw new Error(`unexpected readdirSync(${dir})`);
    });
    const statSync = vi.fn(() => ({ isDirectory: () => true }));
    const isSuperMovieProject = vi.fn(() => true);

    sweepCaptureTmpDirs('/root', { readdirSync, statSync, rmSync, isSuperMovieProject });

    expect(rmSync).toHaveBeenCalledTimes(1);
  });
});
