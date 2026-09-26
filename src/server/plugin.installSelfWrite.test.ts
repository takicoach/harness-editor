/**
 * install 系ルートが自己書込をマークしているかを静的に固定する（監査 data-safety-9）。
 *
 * 導入 API は shapeData.ts / transitionData.ts などの**監視対象ファイル**を配置する。
 * markSelfWrite を呼ばないと、自分で押した導入で「外部で変更されました」バナーが出る。
 * install モジュール本体（撤去予定）には触れず、ルート側の 1 行で塞ぐ方針なので、
 * その 1 行が消えたことを検知できるようにルート網羅をここで pin する。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, 'plugin.ts'), 'utf8');

/** markSelfWrite ＋ 指紋記録が必須の導入ルート。 */
const INSTALL_ROUTES = [
  '/api/install-image-rendering',
  '/api/install-telop-pack',
  '/api/install-video-insert',
  '/api/install-bgm',
  '/api/install-shape',
  '/api/install-transition',
  '/api/install-speed',
  '/api/install-main-layout',
];

/** 該当ルートの `if (url.pathname === ...)` ブロック本文を取り出す。 */
function routeBlock(pathname: string): string {
  const head = `if (url.pathname === '${pathname}')`;
  const start = SRC.indexOf(head);
  expect(start, `${pathname} のルートが見つからない`).toBeGreaterThanOrEqual(0);
  // 次のルート分岐まで（＝このルートの本文）。
  const rest = SRC.slice(start + head.length);
  const nextIdx = rest.indexOf('if (url.pathname === ');
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

/** install 以外にもサーバ自身が監視対象を書き換えるルート。 */
const OTHER_SELF_WRITE_ROUTES = ['/api/convert-burned-in', '/api/pack-upgrade', '/api/telop-add',
  '/api/telop-template-update/apply', '/api/telop-template-update/revert'];

const SELF_WRITE_ROUTES = [...INSTALL_ROUTES, ...OTHER_SELF_WRITE_ROUTES];

describe('install 系ルートの markSelfWrite（data-safety-9）', () => {
  for (const pathname of SELF_WRITE_ROUTES) {
    it(`${pathname} は markSelfWrite を呼ぶ`, () => {
      expect(routeBlock(pathname)).toContain('markSelfWrite(id)');
    });

    // markSelfWrite だけでは通知が 1.1 秒遅れるだけで、窓明けの再評価は必ず onChange に
    // 到達する（isSelfWriteContent が指紋なしでは false を返すため）。PUT と同じく
    // 「書込後の指紋」を記録して初めて自分の導入がバナーを出さなくなる。
    it(`${pathname} は書込後の指紋を記録する`, () => {
      const block = routeBlock(pathname);
      expect(block).toContain('recordSelfWriteContent(id, projectContentSignature(dir))');
      // 順序も固定する（マーク → 書込 → 指紋記録）。
      expect(block.indexOf('markSelfWrite(id)')).toBeLessThan(
        block.indexOf('recordSelfWriteContent(id,'),
      );
      // sendJson(res, 200, result) と sendJson(res, 200, { ... }) の両形に対応する
      // （固定文字列一致だと新ルートの整形レスポンスを拾えない）。
      const sendJsonMatch = /sendJson\(res, 200, /.exec(block);
      expect(sendJsonMatch, `${pathname} に sendJson(res, 200, …) が見つからない`).not.toBeNull();
      expect(block.indexOf('recordSelfWriteContent(id,')).toBeLessThan(sendJsonMatch!.index);
    });
  }

  it('導入ルートすべてを対象にしている（ルートを足したら気づける）', () => {
    const all = [...SRC.matchAll(/url\.pathname === '(\/api\/install-[a-z-]+)'/g)].map((m) => m[1]);
    expect([...new Set(all)].sort()).toEqual([...INSTALL_ROUTES].sort());
  });
});
