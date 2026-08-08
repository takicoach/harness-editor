import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket as WsClient } from 'ws';
import { createPtyTokenStore, isAllowedWsOrigin } from './ptyApi';

const apiSrc = readFileSync(join(import.meta.dirname, 'ptyApi.ts'), 'utf8');

/**
 * このファイルは `loadFresh()` 経由で実 ptySessions（createPtySessionManager()）を使い、
 * switchTool({ tool: 'codex' }) を実行するテストを含む。AI_TOOLS.codex.prepare は
 * deps を注入できない実アダプタ経由のため os.homedir() が実ホームを見てしまい、
 * 隔離 home（~/.supermovie/...）や実ユーザーの ~/.codex/auth.json への symlink を
 * 実ホームに作ってしまう（ptySession.test.ts と同一事故クラス・実際に一度発生させて発覚）。
 * ファイル全体を覆う beforeAll/afterAll で HOME/USERPROFILE を偽ホームへ差し替える。
 */
const PTYAPI_HOME_KEY = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
let ptyApiFakeHome: string;
let ptyApiOriginalHome: string | undefined;
beforeAll(() => {
  ptyApiFakeHome = mkdtempSync(join(tmpdir(), 'sme-ptyapi-fakehome-'));
  ptyApiOriginalHome = process.env[PTYAPI_HOME_KEY];
  process.env[PTYAPI_HOME_KEY] = ptyApiFakeHome;
});
afterAll(() => {
  if (ptyApiOriginalHome === undefined) {
    delete process.env[PTYAPI_HOME_KEY];
  } else {
    process.env[PTYAPI_HOME_KEY] = ptyApiOriginalHome;
  }
  rmSync(ptyApiFakeHome, { recursive: true, force: true });
});

describe('createPtyTokenStore', () => {
  it('発行したトークンは一度だけ consume できる', () => {
    const store = createPtyTokenStore(30_000);
    const t = store.issue();
    expect(store.consume(t)).toBe(true);
    expect(store.consume(t)).toBe(false); // 一回限り
  });
  it('期限切れは consume できない', () => {
    vi.useFakeTimers();
    const store = createPtyTokenStore(1000);
    const t = store.issue();
    vi.advanceTimersByTime(1500);
    expect(store.consume(t)).toBe(false);
    vi.useRealTimers();
  });
  it('未知のトークンは false', () => {
    expect(createPtyTokenStore().consume('bogus')).toBe(false);
  });
});

describe('isAllowedWsOrigin（同一オリジン判定・ポート非依存・WS は Origin 必須）', () => {
  it('Host と Origin の host:port が完全一致すれば許可する（ポート非依存を2ポートで固定）', () => {
    expect(isAllowedWsOrigin('http://localhost:2109', 'localhost:2109')).toBe(true);
    expect(isAllowedWsOrigin('http://localhost:2119', 'localhost:2119')).toBe(true);
    expect(isAllowedWsOrigin('http://127.0.0.1:2109', '127.0.0.1:2109')).toBe(true);
  });
  it('別ポートの Origin は拒否する（Host: localhost:2109 に対し Origin が :9999）', () => {
    expect(isAllowedWsOrigin('http://localhost:9999', 'localhost:2109')).toBe(false);
  });
  it('外部オリジンは拒否する', () => {
    expect(isAllowedWsOrigin('http://evil.example', 'localhost:2109')).toBe(false);
  });
  it('Origin 未指定は拒否する（HTTP の isAllowedOrigin と違い未指定も拒否＝ブラウザの WS は必ず Origin を送る）', () => {
    expect(isAllowedWsOrigin(undefined, 'localhost:2109')).toBe(false);
  });
  it('https スキームは拒否する（http のみ許可）', () => {
    expect(isAllowedWsOrigin('https://localhost:2109', 'localhost:2109')).toBe(false);
  });
  it('Host が loopback でなければ Origin が一致しても拒否する', () => {
    expect(isAllowedWsOrigin('http://example.com:2109', 'example.com:2109')).toBe(false);
  });
});

describe('writer の sessionId 束縛（切替を跨いだ入力を断つ）', () => {
  it('attachWriter が接続時の sessionId を記録する', () => {
    expect(apiSrc).toContain('ptySessions.sessionId()');
    expect(apiSrc).toMatch(/boundSessionId/);
  });

  it('onMessage が「現在の writer か」と「同じ sessionId か」の両方を見る', () => {
    const guard = /if \(ws !== writer\) return;[\s\S]{0,400}?boundSessionId !== ptySessions\.sessionId\(\)/;
    expect(apiSrc).toMatch(guard);
  });

  it('sessionId 不一致では stale を送って切断する', () => {
    expect(apiSrc).toContain("type: 'stale'");
  });

  it('invalidateWriter を export し、ptySessions へ登録している', () => {
    expect(apiSrc).toMatch(/export function invalidateWriter\(\)/);
    expect(apiSrc).toContain('setInvalidateWriter(invalidateWriter)');
  });

  it('接続制御の既存機構を消していない（回帰）', () => {
    expect(apiSrc).toContain('maxPayload: MAX_WS_PAYLOAD_BYTES');
    expect(apiSrc).toContain('perMessageDeflate: false');
    expect(apiSrc).toContain('MAX_PENDING_CONNS');
    expect(apiSrc).toContain('prevWriter.terminate()');
    expect(apiSrc).toContain('isAllowedWsOrigin');
  });
});

/**
 * 接続制御（takeover・pendingCount・maxPayload）の統合テスト。
 * 実 http.createServer + WebSocketServer（listen(0) で OS 割当ポート、2109/2110 は使わない）で検証する。
 * ptyApi/ptySession はテストごとに vi.resetModules() で再ロードし、モジュール内シングルトン
 * （writer/pendingCount/wss 等）をテスト間で隔離する。ptySessions.ensure() は一度も呼ばないため
 * 実 pty は spawn されない（write/resize は pty===null で no-op、onData/onExit も購読登録のみ）。
 */
describe('接続制御 — takeover・pendingCount・maxPayload（実 http+ws 統合テスト）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  type PtyApiModule = typeof import('./ptyApi');
  type PtySessionModule = typeof import('./ptySession');

  /** テストごとに ptyApi/ptySession を新規ロードしてモジュール状態を隔離する。 */
  async function loadFresh(): Promise<PtyApiModule & { ptySessions: PtySessionModule['ptySessions'] }> {
    vi.resetModules();
    const ptyApiMod = await import('./ptyApi');
    const { ptySessions } = await import('./ptySession');
    return { ...ptyApiMod, ptySessions };
  }

  function startServer(handlePtyUpgrade: PtyApiModule['handlePtyUpgrade']): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });
      server.on('upgrade', handlePtyUpgrade);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve({ server, port });
      });
    });
  }

  function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  function connectClient(port: number): WsClient {
    // Origin は同一オリジン判定（Host ヘッダとの host:port 完全一致）に合わせ、
    // 実際に listen したポートから動的に組み立てる（ハードコードすると新しい
    // isAllowedWsOrigin の下では常に不一致で 403 になる）。
    return new WsClient(`ws://127.0.0.1:${port}/api/pty`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
  }

  function once<T = void>(emitter: { once: (event: string, cb: (arg: T) => void) => void }, event: string): Promise<T> {
    return new Promise((resolve) => emitter.once(event, (arg: T) => resolve(arg)));
  }

  function onceUnexpectedResponse(ws: WsClient): Promise<number> {
    return new Promise((resolve) => {
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? -1));
      ws.once('error', () => resolve(-1));
    });
  }

  function waitForJsonMessage(
    ws: WsClient,
    predicate: (msg: { type?: string }) => boolean,
    timeoutMs = 2000,
  ): Promise<{ type?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
      const onMessage = (raw: WsClient.RawData): void => {
        let msg: { type?: string };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(msg);
        }
      };
      ws.on('message', onMessage);
    });
  }

  /**
   * ws クライアントの内部 TCP ソケットへ直接マスク済みフレームを書き込む。
   * ws インスタンス自身の readyState チェック（close 後は send() できない）を迂回し、
   * 「サーバ側が旧接続の受信を止めていない限り、生データはそのまま処理される」という
   * 脆弱性の実際の攻撃条件を再現するためのテスト専用ヘルパー。
   */
  function sendRawFrame(ws: WsClient, json: unknown): void {
    const payload = Buffer.from(JSON.stringify(json), 'utf8');
    const maskKey = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      masked[i] = payload[i]! ^ maskKey[i % 4]!;
    }
    const header =
      payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : (() => {
            const h = Buffer.alloc(4);
            h[0] = 0x81;
            h[1] = 0x80 | 126;
            h.writeUInt16BE(payload.length, 2);
            return h;
          })();
    const socket = (ws as unknown as { _socket: { write: (b: Buffer) => void } })._socket;
    socket.write(Buffer.concat([header, maskKey, masked]));
  }

  /** Sec-WebSocket-Key を意図的に欠落させた不正 upgrade リクエスト（Host/Origin は正規＝同一オリジン）。 */
  function sendMalformedUpgrade(port: number): Promise<void> {
    return new Promise((resolve) => {
      const socket = netConnect(port, '127.0.0.1', () => {
        socket.write(
          'GET /api/pty HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${port}\r\n` +
            `Origin: http://127.0.0.1:${port}\r\n` +
            'Connection: Upgrade\r\n' +
            'Upgrade: websocket\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            '\r\n',
        );
      });
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve();
      };
      socket.on('data', finish);
      socket.on('close', finish);
      socket.on('error', finish);
    });
  }

  /** 開いた client を finally で確実に terminate する（assert 失敗時も server.close() が
   * 未終了ソケット待ちでハングしないようにするため）。 */
  function terminateAll(clients: WsClient[]): void {
    for (const c of clients) {
      if (c.readyState !== WsClient.CLOSED) c.terminate();
    }
  }

  it('takeover 後、旧 writer が直接生フレームで送った input は ptySessions.write に渡らない（Critical #1 回帰テスト）', async () => {
    const { handlePtyUpgrade, ptyTokens, ptySessions } = await loadFresh();
    const writeSpy = vi.spyOn(ptySessions, 'write').mockImplementation(() => {});
    const { server, port } = await startServer(handlePtyUpgrade);
    const clients: WsClient[] = [];
    try {
      const client1 = connectClient(port);
      clients.push(client1);
      await once(client1, 'open');
      const authOk1 = waitForJsonMessage(client1, (m) => m.type === 'auth-ok');
      client1.send(JSON.stringify({ type: 'auth', token: ptyTokens.issue() }));
      await authOk1;

      // takeover を受信した瞬間、素の TCP ソケットへ直接 input フレームを書き込む。
      // 修正前は close() 後の receiver 猶予中に旧ハンドラが生きているため、
      // ここで書いた input がそのまま ptySessions.write に渡ってしまう。
      const takeoverSeen = waitForJsonMessage(client1, (m) => m.type === 'takeover');
      client1.on('message', (raw) => {
        let msg: { type?: string };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === 'takeover') {
          sendRawFrame(client1, { type: 'input', data: 'echo pwned-by-old-writer\n' });
        }
      });

      const client2 = connectClient(port);
      clients.push(client2);
      await once(client2, 'open');
      const authOk2 = waitForJsonMessage(client2, (m) => m.type === 'auth-ok');
      client2.send(JSON.stringify({ type: 'auth', token: ptyTokens.issue() }));
      await Promise.all([authOk2, takeoverSeen]);

      // サーバ側の非同期処理（ソケット受信〜JSON.parse〜write 呼び出し）が終わるまで待つ。
      await new Promise((r) => setTimeout(r, 200));

      expect(writeSpy).not.toHaveBeenCalledWith('echo pwned-by-old-writer\n');

      // 現行 writer（client2）からの正規 input は引き続き処理されることも確認する。
      client2.send(JSON.stringify({ type: 'input', data: 'echo legit\n' }));
      await new Promise((r) => setTimeout(r, 200));
      expect(writeSpy).toHaveBeenCalledWith('echo legit\n');
    } finally {
      terminateAll(clients);
      await closeServer(server);
    }
  });

  it('不正ハンドシェイク4連続でも pendingCount はリークせず、直後の正規接続が auth まで到達できる（Important #2 回帰テスト）', async () => {
    const { handlePtyUpgrade, ptyTokens } = await loadFresh();
    const { server, port } = await startServer(handlePtyUpgrade);
    const clients: WsClient[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        await sendMalformedUpgrade(port);
      }

      const client = connectClient(port);
      clients.push(client);
      const outcome = await Promise.race([
        once(client, 'open').then(() => 'open' as const),
        onceUnexpectedResponse(client),
      ]);
      expect(outcome).toBe('open');

      const authOk = waitForJsonMessage(client, (m) => m.type === 'auth-ok');
      client.send(JSON.stringify({ type: 'auth', token: ptyTokens.issue() }));
      await authOk;
    } finally {
      terminateAll(clients);
      await closeServer(server);
    }
  });

  it('maxPayload(65536バイト) 超のフレームは接続を閉じる（コード1009・Important #3）', async () => {
    const { handlePtyUpgrade } = await loadFresh();
    const { server, port } = await startServer(handlePtyUpgrade);
    const clients: WsClient[] = [];
    try {
      const client = connectClient(port);
      clients.push(client);
      await once(client, 'open');
      const closed = once<number>(client, 'close');
      client.send('a'.repeat(70_000));
      const code = await closed;
      expect(code).toBe(1009);
    } finally {
      terminateAll(clients);
      await closeServer(server);
    }
  });

  /** Task 7 用: 実 pty（偽 claude/codex バイナリ）を spawn して switchTool を跨いだ挙動を検証する。 */
  function setupFakeTools(): {
    dir: string;
    base: { editorDir: string; projectRoot: string; env: NodeJS.ProcessEnv };
  } {
    const dir = mkdtempSync(join(tmpdir(), 'sme-ptyapi-sid-'));
    mkdirSync(join(dir, 'projects-root'));
    const claudeFake = join(dir, 'fake-claude.mjs');
    const codexFake = join(dir, 'fake-codex.mjs');
    // 常駐して終了しない偽ツール（setInterval）。SIGTERM で即死ぬのは Node の既定動作。
    writeFileSync(claudeFake, 'process.stdout.write("AAA");setInterval(()=>{},1000);');
    writeFileSync(codexFake, 'process.stdout.write("BBB");setInterval(()=>{},1000);');
    return {
      dir,
      base: {
        editorDir: dir,
        projectRoot: join(dir, 'projects-root'),
        env: { ...process.env, SME_CLAUDE_BIN: claudeFake, SME_CODEX_BIN: codexFake },
      },
    };
  }

  it('pty の生出力は {type:"data"} で框付けされ、制御 JSON と同じ文字列を出力しても exit として解釈されない', async () => {
    const { handlePtyUpgrade, ptyTokens, ptySessions } = await loadFresh();
    const dir = mkdtempSync(join(tmpdir(), 'sme-ptyapi-frame-'));
    mkdirSync(join(dir, 'projects-root'));
    const fake = join(dir, 'fake-claude.mjs');
    // 制御メッセージと同一の文字列を出力する偽ツール（出力偽装の再現）
    writeFileSync(fake, 'process.stdout.write(JSON.stringify({type:"exit",code:0}));setInterval(()=>{},1000);');
    const { server, port } = await startServer(handlePtyUpgrade);
    const clients: WsClient[] = [];
    try {
      const ensured = await ptySessions.ensure({
        editorDir: dir,
        projectRoot: join(dir, 'projects-root'),
        env: { ...process.env, SME_CLAUDE_BIN: fake },
        tool: 'claude',
      });
      expect(ensured.ok).toBe(true);

      const client = connectClient(port);
      clients.push(client);
      await once(client, 'open');
      const messages: { type?: string; data?: string }[] = [];
      client.on('message', (raw) => {
        try {
          messages.push(JSON.parse(String(raw)) as { type?: string; data?: string });
        } catch {
          messages.push({ type: '__unframed__' });
        }
      });
      client.send(JSON.stringify({ type: 'auth', token: ptyTokens.issue() }));
      await waitForJsonMessage(client, (m) => m.type === 'auth-ok');
      // 偽装文字列が data 框（または接続前出力の scrollback）で届くまで待つ
      await vi.waitFor(() => {
        expect(
          messages.some(
            (m) => (m.type === 'data' || m.type === 'scrollback') && m.data?.includes('"exit"'),
          ),
        ).toBe(true);
      });
      expect(messages.some((m) => m.type === 'exit')).toBe(false);
      expect(messages.some((m) => m.type === '__unframed__')).toBe(false);
    } finally {
      terminateAll(clients);
      ptySessions.killAll();
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'boundSessionId が pty の sessionId と食い違うと、writer が同一でも stale で切断し write を遮断する' +
      '（Task 7: 二段目の防御を invalidateWriter 抜きで単独検証）',
    async () => {
      // invalidateWriter が何らかの理由で効かなかった異常系を模す: ptySessions.setInvalidateWriter
      // を意図的に no-op へ差し替え、switchTool 後も writer 変数が旧 ws のまま残る状況を作る
      // （一段目の `ws !== writer` ガードでは検出できない）。それでも boundSessionId 不一致
      // という二段目のガードだけで入力が遮断されることを確認する。
      const { handlePtyUpgrade, ptyTokens, ptySessions } = await loadFresh();
      const { dir, base } = setupFakeTools();
      const writeSpy = vi.spyOn(ptySessions, 'write').mockImplementation(() => {});
      const { server, port } = await startServer(handlePtyUpgrade);
      const clients: WsClient[] = [];
      try {
        const ensured = await ptySessions.ensure({ ...base, tool: 'claude' });
        expect(ensured.ok).toBe(true);

        const client1 = connectClient(port);
        clients.push(client1);
        await once(client1, 'open');
        const authOk1 = waitForJsonMessage(client1, (m) => m.type === 'auth-ok');
        client1.send(JSON.stringify({ type: 'auth', token: ptyTokens.issue() }));
        await authOk1;

        ptySessions.setInvalidateWriter(() => {});

        const switched = await ptySessions.switchTool({ ...base, tool: 'codex' });
        expect(switched.ok).toBe(true);

        const stale = waitForJsonMessage(client1, (m) => m.type === 'stale');
        const closed = once<number>(client1, 'close');
        client1.send(JSON.stringify({ type: 'input', data: 'echo pwned-across-switch\n' }));

        await stale;
        await closed;
        expect(writeSpy).not.toHaveBeenCalledWith('echo pwned-across-switch\n');
      } finally {
        terminateAll(clients);
        ptySessions.killAll();
        await closeServer(server);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    'switchTool は旧セッションの exit 確定より先に invalidateWriter を呼ぶため、旧 writer に exit 通知は届かない' +
      '（Task 7 注意3: 切替中に「AI が終了しました」と誤表示しないことの確認）',
    async () => {
      const { handlePtyUpgrade, ptyTokens, ptySessions } = await loadFresh();
      const { dir, base } = setupFakeTools();
      const { server, port } = await startServer(handlePtyUpgrade);
      const clients: WsClient[] = [];
      try {
        const ensured = await ptySessions.ensure({ ...base, tool: 'claude' });
        expect(ensured.ok).toBe(true);

        const client1 = connectClient(port);
        clients.push(client1);
        await once(client1, 'open');
        const authOk1 = waitForJsonMessage(client1, (m) => m.type === 'auth-ok');
        client1.send(JSON.stringify({ type: 'auth', token: ptyTokens.issue() }));
        await authOk1;

        const messages: { type?: string }[] = [];
        client1.on('message', (raw) => {
          try {
            messages.push(JSON.parse(String(raw)) as { type?: string });
          } catch {
            // ignore
          }
        });
        const closed = once<number>(client1, 'close');

        const switched = await ptySessions.switchTool({ ...base, tool: 'codex' });
        expect(switched.ok).toBe(true);

        await closed;
        // 旧プロセスの実終了イベントが（もしすり抜けていれば）届く猶予を与える。
        await new Promise((r) => setTimeout(r, 300));

        expect(messages.some((m) => m.type === 'stale')).toBe(true);
        expect(messages.some((m) => m.type === 'exit')).toBe(false);
      } finally {
        terminateAll(clients);
        ptySessions.killAll();
        await closeServer(server);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
