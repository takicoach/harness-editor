// src/server/openMaterialFolder.test.ts — 素材フォルダ解決と OS 別 open コマンドの分岐を検証。
import { describe, it, expect, vi } from 'vitest';
import { materialFolderFor, openFolder } from './openMaterialFolder';

function mockSpawn() {
  const child = { on: vi.fn(), unref: vi.fn() };
  const spawnFn = vi.fn(() => child);
  return { child, spawnFn };
}

describe('materialFolderFor', () => {
  it('種別ごとに materialList.ts の assetDir と対応するフォルダを返す', () => {
    expect(materialFolderFor('/pj', 'se')).toBe('/pj/public/se');
    expect(materialFolderFor('/pj', 'image')).toBe('/pj/public/images');
    expect(materialFolderFor('/pj', 'bgm')).toBe('/pj/public/BGM');
    expect(materialFolderFor('/pj', 'video')).toBe('/pj/public');
  });

  it('未知の種別は null', () => {
    expect(materialFolderFor('/pj', 'unknown')).toBeNull();
    expect(materialFolderFor('/pj', '')).toBeNull();
  });
});

describe('openFolder', () => {
  it('darwin は open <dir>', () => {
    const { child, spawnFn } = mockSpawn();
    openFolder('/pj/public/se', 'darwin', spawnFn as never);
    expect(spawnFn).toHaveBeenCalledWith('open', ['/pj/public/se'], { stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalled();
  });

  it('win32 は explorer <dir>', () => {
    const { spawnFn } = mockSpawn();
    openFolder('C:\\pj\\public\\se', 'win32', spawnFn as never);
    expect(spawnFn).toHaveBeenCalledWith('explorer', ['C:\\pj\\public\\se'], { stdio: 'ignore' });
  });

  it('その他は xdg-open <dir>', () => {
    const { spawnFn } = mockSpawn();
    openFolder('/pj/public/se', 'linux', spawnFn as never);
    expect(spawnFn).toHaveBeenCalledWith('xdg-open', ['/pj/public/se'], { stdio: 'ignore' });
  });

  it('spawn エラーは on("error") で握られサーバを落とさない', () => {
    const { child, spawnFn } = mockSpawn();
    openFolder('/pj/public/se', 'darwin', spawnFn as never);
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
  });
});
