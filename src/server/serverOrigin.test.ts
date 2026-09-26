/**
 * serverOrigin.ts のユニットテスト（M2c T3・設計判断7・T3 追補 Minor③）。
 *
 * plugin.ts 配線の存在検査は当初 captureSmoke.e2e.test.ts から実サーバの
 * `getServerOrigin()` を直接呼ぶ形で試みたが、vite.config.ts が読み込む plugin.ts は
 * Vite の**設定ローダ側モジュール realm**で実行され、e2e テストファイルが素の import で
 * 読む serverOrigin.ts（vitest 側 realm）とは別インスタンスになることが実測で判明した
 * （captureOverlaySequence 経由の撮影自体は成功する＝smeServer() の configureServer は
 * 実際に走っているのに、e2e から getServerOrigin() を呼ぶと常に null）。
 * そのため実配線の検査は**フック注入**に切り替える: plugin.ts が呼ぶ配線本体
 * `wireServerOrigin()` を、実 http.Server を起動せず fake httpServer で直接駆動して pin する
 * （「記録と取得」「listen アドレス→origin の組み立て」は従来どおりフック注入なしで pin）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getServerOrigin, originFromAddress, setServerOrigin, wireServerOrigin } from './serverOrigin';
import type { OriginAwareHttpServer } from './serverOrigin';

afterEach(() => {
  setServerOrigin(null);
});

describe('originFromAddress: listen アドレス→origin 文字列の組み立て', () => {
  it('通常のホスト・ポートはそのまま http://host:port にする', () => {
    expect(originFromAddress({ address: '127.0.0.1', port: 5173 })).toBe('http://127.0.0.1:5173');
  });

  it('0.0.0.0（全インターフェース bind）は 127.0.0.1 に丸める', () => {
    expect(originFromAddress({ address: '0.0.0.0', port: 4321 })).toBe('http://127.0.0.1:4321');
  });

  it('::（IPv6 全インターフェース bind）も 127.0.0.1 に丸める', () => {
    expect(originFromAddress({ address: '::', port: 4321 })).toBe('http://127.0.0.1:4321');
  });

  it('M-3: IPv6 リテラル（::1 等）は角括弧で囲む（http://[::1]:port）', () => {
    expect(originFromAddress({ address: '::1', port: 4321 })).toBe('http://[::1]:4321');
    expect(originFromAddress({ address: 'fe80::1', port: 5173 })).toBe('http://[fe80::1]:5173');
  });

  it('address が null なら null（未起動として扱う）', () => {
    expect(originFromAddress(null)).toBeNull();
  });
});

describe('setServerOrigin / getServerOrigin: 記録と取得', () => {
  it('未起動（未記録）は null', () => {
    expect(getServerOrigin()).toBeNull();
  });

  it('記録した値がそのまま取得できる', () => {
    setServerOrigin('http://127.0.0.1:9999');
    expect(getServerOrigin()).toBe('http://127.0.0.1:9999');
  });

  it('null で再記録すると未起動扱いに戻る（サーバ停止時の使い方）', () => {
    setServerOrigin('http://127.0.0.1:9999');
    setServerOrigin(null);
    expect(getServerOrigin()).toBeNull();
  });
});

/** 最小限の fake httpServer（listening/address/once の3面だけ）。実 http.Server は起動しない。 */
function fakeHttpServer(opts: {
  listening: boolean;
  address: unknown;
}): OriginAwareHttpServer & { emitListening(): void } {
  let onListening: (() => void) | undefined;
  return {
    listening: opts.listening,
    address: () => opts.address,
    once: (event, listener) => {
      if (event === 'listening') onListening = listener;
    },
    emitListening: () => onListening?.(),
  };
}

describe('wireServerOrigin: plugin.ts 配線本体のフック注入テスト（実 http.Server 不使用）', () => {
  it('既に listening な httpServer なら即座に記録する（listen 完了後に configureServer が走る場合）', () => {
    const server = fakeHttpServer({ listening: true, address: { address: '127.0.0.1', port: 4321 } });
    wireServerOrigin(server);
    expect(getServerOrigin()).toBe('http://127.0.0.1:4321');
  });

  it('未 listening なら listening イベント発火まで記録しない（フック配線の pin）', () => {
    const server = fakeHttpServer({ listening: false, address: { address: '127.0.0.1', port: 5555 } });
    wireServerOrigin(server);
    expect(getServerOrigin()).toBeNull();
    server.emitListening();
    expect(getServerOrigin()).toBe('http://127.0.0.1:5555');
  });

  it('httpServer が無い（ミドルウェアモード等）は null に倒す', () => {
    setServerOrigin('http://127.0.0.1:1111'); // 前回起動の残留値がクリアされることも確認する。
    wireServerOrigin(null);
    expect(getServerOrigin()).toBeNull();
  });

  it('0.0.0.0 bind の listening アドレスも 127.0.0.1 に丸めて記録する（originFromAddress との結線）', () => {
    const server = fakeHttpServer({ listening: true, address: { address: '0.0.0.0', port: 9000 } });
    wireServerOrigin(server);
    expect(getServerOrigin()).toBe('http://127.0.0.1:9000');
  });

  it('plugin.ts が実際にこの関数を呼ぶ配線であること（import 差し替えでの結線 pin）', async () => {
    // plugin.ts 自体を丸ごと実行するのは重い副作用（instructionInbox 永続化・fs 走査等）を
    // 引き連れるため避け、plugin.ts が wireServerOrigin をモジュールとして参照していることを
    // ソースの静的検査で pin する（実行結線は上の fake httpServer 群が担う）。
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const pluginSource = readFileSync(resolve(import.meta.dirname, 'plugin.ts'), 'utf8');
    expect(pluginSource).toMatch(/wireServerOrigin\(server\.httpServer/);
  });
});
