import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { INSTALL_APIS, type InstallKind } from './install';

const ALL_KINDS: InstallKind[] = [
  'imageRendering',
  'telopPack',
  'videoInsert',
  'bgm',
  'shape',
  'transition',
  'speed',
  'mainLayout',
];

describe('INSTALL_APIS', () => {
  it('全種の導入 API を持つ', () => {
    expect(Object.keys(INSTALL_APIS).sort()).toEqual([...ALL_KINDS].sort());
  });

  it('パスはサーバの導入ルート（plugin.ts ソース）と1:1で一致する（同期ガード）', () => {
    // 文字列を二重に書くのではなく、実際のルート定義ソースから導出して照合する
    //（assetVersions ↔ assetPathFor の同期ガードと同じ発想）。
    const pluginSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'plugin.ts'),
      'utf8',
    );
    const serverPaths = [...new Set(pluginSrc.match(/\/api\/install-[a-z-]+/g) ?? [])].sort();
    const clientPaths = Object.values(INSTALL_APIS).map((a) => a.path).sort();
    expect(clientPaths).toEqual(serverPaths);
  });

  it('失敗メッセージは全種で非空', () => {
    for (const kind of ALL_KINDS) {
      expect(INSTALL_APIS[kind].failMessage.length).toBeGreaterThan(0);
    }
  });
});
