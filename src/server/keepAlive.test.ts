import { describe, it, expect } from 'vitest';
import {
  applyKeepAliveTimeouts,
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
} from './keepAlive';

describe('applyKeepAliveTimeouts', () => {
  it('httpServer のアイドル上限を Node 既定（5s）より十分長くする', () => {
    const server = { keepAliveTimeout: 5_000, headersTimeout: 60_000 };
    applyKeepAliveTimeouts(server);
    expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    // 5 秒のままだと、アイドル接続を使い回したクライアントが ECONNRESET を食う
    // （実測: フルスイート e2e の GET /api/config・保存 POST も同じ窓に当たる）。
    expect(server.keepAliveTimeout).toBeGreaterThan(60_000);
  });

  it('headersTimeout は keepAliveTimeout より長い（先に切ると同じ競合が残る）', () => {
    const server = { keepAliveTimeout: 5_000, headersTimeout: 60_000 };
    applyKeepAliveTimeouts(server);
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it('httpServer が無い（ミドルウェアモード）なら何もしない', () => {
    expect(() => applyKeepAliveTimeouts(null)).not.toThrow();
    expect(() => applyKeepAliveTimeouts(undefined)).not.toThrow();
  });

  it('keep-alive を持たないサーバ実装（HTTP/2 等）には触らない', () => {
    const server: Record<string, unknown> = { somethingElse: 1 };
    applyKeepAliveTimeouts(server);
    expect(server['keepAliveTimeout']).toBeUndefined();
    expect(server['headersTimeout']).toBeUndefined();
  });
});
