/**
 * aiPlugin の HTTP ハンドラを、実際のリクエスト/レスポンスに近い偽物を通して検証する。
 * 旧版はソースの文字列検査だったが、ルーティング・ステータス・ボディの実際の値を
 * 押さえられないという外部レビュー指摘（P1-5）を受けて実経路に切り替えた。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleAiApi, resolveActualPort, apiKeyDetected, smeAi } from './aiPlugin';
import { ptySessions } from './ptySession';
import { claudeInstallJob } from './claudeInstallJob';
import { handlePtyUpgrade, ptyTokens } from './ptyApi';

interface Captured { status: number; body: unknown }

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:2109', origin: 'http://127.0.0.1:2109', 'sec-fetch-site': 'same-origin' },
    // 実装（readBody.ts）は for await のみでボディを読む。on('data'/'end') は
    // 使われないため死にコードだった（Minor 3）。
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; },
  };
  return req as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: null };
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() { return this; },
    writeHead(status: number) { captured.status = status; return this; },
    end(payload?: string) {
      this.writableEnded = true;
      if (payload !== undefined) { try { captured.body = JSON.parse(payload); } catch { captured.body = payload; } }
      return this;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

let editorDir: string;
beforeEach(() => { editorDir = mkdtempSync(join(tmpdir(), 'sme-aiplugin-')); });
afterEach(() => {
  rmSync(editorDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const ctx = () => ({ editorDir, port: 2109, env: { ...process.env } as NodeJS.ProcessEnv });

describe('ルーティング', () => {
  it('/api/ai/ 以外・/api/pty/ 以外は処理しない（false を返す）', async () => {
    const { res } = makeRes();
    expect(await handleAiApi(makeReq('GET', '/api/projects'), res, ctx())).toBe(false);
  });

  it('未知の /api/ai/* は 404', async () => {
    const { res, captured } = makeRes();
    expect(await handleAiApi(makeReq('GET', '/api/ai/nope'), res, ctx())).toBe(true);
    expect(captured.status).toBe(404);
  });

  it('ローカル以外からのアクセスは 403（個別ルート分岐より前に弾く）', async () => {
    const { res, captured } = makeRes();
    const req = makeReq('GET', '/api/ai/tools');
    (req.headers as Record<string, string>).host = 'evil.example.com';
    await handleAiApi(req, res, ctx());
    expect(captured.status).toBe(403);
  });

  it('Minor 6: 不正な request-target で URL 解析が失敗したら next() へ委譲する（false・500 にしない）', async () => {
    const { res, captured } = makeRes();
    // WHATWG URL が Invalid URL で throw する例（不正な IPv6 リテラル）。
    const result = await handleAiApi(makeReq('GET', 'http://[::1'), res, ctx());
    expect(result).toBe(false);
    expect(captured.status).toBe(0); // レスポンスを一切書いていない（next() に委ねた）
  });
});

describe('readBodySafe の上限（Minor 5）', () => {
  it('JOB_BODY_MAX_BYTES（64 KiB）を超えるボディは 413 を投げる（「未指定」に握り潰さない）', async () => {
    const bigTool = 'a'.repeat(70 * 1024);
    const { res } = makeRes();
    await expect(
      handleAiApi(makeReq('POST', '/api/pty/ensure', { tool: bigTool }), res, ctx()),
    ).rejects.toMatchObject({ status: 413 });
  });
});

describe('GET /api/pty/token', () => {
  it('ptyTokens.issue() の結果を 200 で返す（WebSocket 接続の入口）', async () => {
    vi.spyOn(ptyTokens, 'issue').mockReturnValue('tok-123');
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('GET', '/api/pty/token'), res, ctx());
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ token: 'tok-123' });
  });
});

describe('POST /api/pty/waiting', () => {
  it('ptySessions.startWaiting() の失敗を 409 にする', async () => {
    vi.spyOn(ptySessions, 'startWaiting').mockReturnValue({ ok: false, error: 'AI が起動していません' });
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/waiting'), res, ctx());
    expect(captured.status).toBe(409);
    expect((captured.body as { error: string }).error).toBe('AI が起動していません');
  });

  it('成功時は 200 で { ok: true }', async () => {
    vi.spyOn(ptySessions, 'startWaiting').mockReturnValue({ ok: true });
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/waiting'), res, ctx());
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ ok: true });
  });
});

describe('GET /api/ai/tools', () => {
  it('ツール一覧・current・課金検出を返す', async () => {
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('GET', '/api/ai/tools'), res, ctx());
    expect(captured.status).toBe(200);
    const body = captured.body as { tools: { id: string; label: string; installed: boolean }[]; current: string | null };
    expect(body.tools.map((t) => t.id).sort()).toEqual(['claude', 'codex']);
    expect(body.tools.find((t) => t.id === 'claude')?.label).toBe('Claude');
    expect(body).toHaveProperty('current');
  });

  it('current は ptySessions.currentTool を反映する（サーバーが正本）', async () => {
    vi.spyOn(ptySessions, 'currentTool').mockReturnValue('codex');
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('GET', '/api/ai/tools'), res, ctx());
    expect((captured.body as { current: string | null }).current).toBe('codex');
  });
});

describe('POST /api/ai/install', () => {
  it('自動導入の対象外ツール（codex）は 400', async () => {
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/ai/install', { tool: 'codex' }), res, ctx());
    expect(captured.status).toBe(400);
    expect(String((captured.body as { error: string }).error)).toContain('自動導入');
  });

  it('Minor 2: エラー文言はツールの label を使った一般的な文言で、codex 決め打ちのパッケージ名を含まない', async () => {
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/ai/install', { tool: 'codex' }), res, ctx());
    const message = String((captured.body as { error: string }).error);
    expect(message).toContain('Codex'); // AI_TOOLS.codex.label
    expect(message).not.toContain('@openai/codex'); // 特定パッケージ名の決め打ちを含まない
    expect(message).not.toContain('npm i');
  });

  it('未知のツールは 400', async () => {
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/ai/install', { tool: 'gemini' }), res, ctx());
    expect(captured.status).toBe(400);
  });

  it('claudeInstallJob.start() の失敗（多重起動中等）は 409', async () => {
    vi.spyOn(claudeInstallJob, 'start').mockReturnValue({ ok: false, error: '導入は既に実行中です' });
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/ai/install', { tool: 'claude' }), res, ctx());
    expect(captured.status).toBe(409);
    expect((captured.body as { error: string }).error).toBe('導入は既に実行中です');
  });
});

describe('POST /api/pty/ensure', () => {
  it('未知のツールは 400（許可リスト外を spawn 経路へ通さない）', async () => {
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/ensure', { tool: 'rm -rf /' }), res, ctx());
    expect(captured.status).toBe(400);
  });

  it('tool-mismatch は 409 で actualTool を返す', async () => {
    vi.spyOn(ptySessions, 'ensure').mockResolvedValue({
      ok: false, error: 'busy', code: 'tool-mismatch', actualTool: 'claude',
    });
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/ensure', { tool: 'codex' }), res, ctx());
    expect(captured.status).toBe(409);
    expect((captured.body as { actualTool: string }).actualTool).toBe('claude');
  });

  it('成功時（200）は actualTool と notes を body に載せ、検証済み tool を ensure へ転送する（Minor 4）', async () => {
    const ensureSpy = vi.spyOn(ptySessions, 'ensure').mockResolvedValue({ ok: true });
    vi.spyOn(ptySessions, 'state').mockReturnValue('running');
    vi.spyOn(ptySessions, 'currentTool').mockReturnValue('codex');
    vi.spyOn(ptySessions, 'notes').mockReturnValue(['注意事項']);

    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/ensure', { tool: 'codex', theme: 'light' }), res, ctx());

    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ ok: true, actualTool: 'codex', notes: ['注意事項'] });
    expect(ensureSpy).toHaveBeenCalledWith(expect.objectContaining({ tool: 'codex', theme: 'light' }));
  });
});

describe('POST /api/pty/switch', () => {
  it('未知のツールは 400', async () => {
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/switch', { tool: 'nope' }), res, ctx());
    expect(captured.status).toBe(400);
  });

  it('未指定（Minor 1: 「指定してください」）と未対応（「対応していない」）で別文言を返す', async () => {
    const { res: resMissing, captured: missing } = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/switch', {}), resMissing, ctx());
    expect(missing.status).toBe(400);
    expect((missing.body as { error: string }).error).toContain('指定してください');

    const { res: resUnknown, captured: unknown } = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/switch', { tool: 'nope' }), resUnknown, ctx());
    expect(unknown.status).toBe(400);
    expect((unknown.body as { error: string }).error).toContain('対応していない');
    expect((unknown.body as { error: string }).error).not.toBe((missing.body as { error: string }).error);
  });

  it('成功時に actualTool と notes を返す', async () => {
    vi.spyOn(ptySessions, 'switchTool').mockResolvedValue({
      ok: true, actualTool: 'codex', sessionId: 'sid-1', notes: ['注意'],
    });
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/switch', { tool: 'codex', theme: 'light' }), res, ctx());
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ actualTool: 'codex', notes: ['注意'] });
  });

  it('失敗時は 409', async () => {
    vi.spyOn(ptySessions, 'switchTool').mockResolvedValue({ ok: false, error: '見つかりません', code: 'not-found' });
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/switch', { tool: 'codex' }), res, ctx());
    expect(captured.status).toBe(409);
  });
});

describe('apiKeyDetected', () => {
  it('全ツールの課金キーの和集合で判定する', () => {
    expect(apiKeyDetected({ ANTHROPIC_API_KEY: 'x' })).toBe(true);
    expect(apiKeyDetected({ OPENAI_API_KEY: 'x' })).toBe(true);
    expect(apiKeyDetected({ CODEX_API_KEY: 'x' })).toBe(true);
    expect(apiKeyDetected({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(true);
    expect(apiKeyDetected({ PATH: '/bin' })).toBe(false);
  });

  it('サブスク認証（CODEX_ACCESS_TOKEN）は課金検出に含めない', () => {
    expect(apiKeyDetected({ CODEX_ACCESS_TOKEN: 'tok' })).toBe(false);
  });
});

describe('resolveActualPort', () => {
  it('listen 済みなら実ポートを返す', () => {
    expect(resolveActualPort({ httpServer: { address: () => ({ port: 2112 }) }, config: { server: { port: 2109 } } })).toBe(2112);
  });
  it('listen 前は設定値、それも無ければ 2109', () => {
    expect(resolveActualPort({ httpServer: null, config: { server: { port: 2115 } } })).toBe(2115);
    expect(resolveActualPort({ httpServer: null, config: { server: {} } })).toBe(2109);
  });
  it('httpServer.address() が null（listen 前）なら設定値へフォールバックする', () => {
    expect(
      resolveActualPort({ httpServer: { address: () => null }, config: { server: { port: 2115 } } }),
    ).toBe(2115);
  });
  it('httpServer.address() が文字列（unix ソケット）でも typeof object ガードでフォールバックする', () => {
    expect(
      resolveActualPort({
        httpServer: { address: () => '/tmp/sme.sock' },
        config: { server: { port: 2117 } },
      }),
    ).toBe(2117);
  });
});

/**
 * smeAi() の configureServer 配線そのものを検証する。
 * handleAiApi の単体テストだけでは、configureServer 内で実際に何が登録されるか
 * （close/upgrade ハンドラ・middlewares.use・resolveActualPort 由来の port）は
 * 検証できず、smeAi() を誰も呼ばない場合これらの配線が壊れても全緑になってしまう
 * （外部レビュー Important 1）。偽の Vite server を通してここを直接検証する。
 */
describe('smeAi() の configureServer 配線', () => {
  interface FakeServer {
    httpServer: { on: ReturnType<typeof vi.fn>; address: () => { port: number } | null };
    config: { server: Record<string, unknown> };
    middlewares: { use: ReturnType<typeof vi.fn> };
  }

  function makeFakeServer(): FakeServer {
    return {
      httpServer: { on: vi.fn(), address: () => ({ port: 2222 }) },
      config: { server: {} },
      middlewares: { use: vi.fn() },
    };
  }

  function applyPlugin(fakeServer: FakeServer): void {
    const plugin = smeAi();
    const configureServer = plugin.configureServer as unknown as (server: FakeServer) => void;
    configureServer(fakeServer);
  }

  function getHandler(fakeServer: FakeServer, event: string): (...args: unknown[]) => unknown {
    const call = fakeServer.httpServer.on.mock.calls.find(([e]) => e === event);
    if (!call) throw new Error(`'${event}' ハンドラが登録されていません`);
    return call[1] as (...args: unknown[]) => unknown;
  }

  function getMiddleware(
    fakeServer: FakeServer,
  ): (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void> {
    const call = fakeServer.middlewares.use.mock.calls[0];
    if (!call) throw new Error('middlewares.use が呼ばれていません');
    return call[0] as (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>;
  }

  it("'close' ハンドラが claudeInstallJob.killAll と ptySessions.killAll の両方を呼ぶ", () => {
    const killInstall = vi.spyOn(claudeInstallJob, 'killAll').mockImplementation(() => {});
    const killPty = vi.spyOn(ptySessions, 'killAll').mockImplementation(() => {});
    const fakeServer = makeFakeServer();
    applyPlugin(fakeServer);

    const onClose = getHandler(fakeServer, 'close');
    onClose();

    expect(killInstall).toHaveBeenCalledTimes(1);
    expect(killPty).toHaveBeenCalledTimes(1);
  });

  it("'upgrade' に登録される関数は handlePtyUpgrade そのもの", () => {
    const fakeServer = makeFakeServer();
    applyPlugin(fakeServer);
    expect(getHandler(fakeServer, 'upgrade')).toBe(handlePtyUpgrade);
  });

  it('middlewares.use のミドルウェアは無関係パスで next() を呼ぶ', async () => {
    const fakeServer = makeFakeServer();
    applyPlugin(fakeServer);
    const middleware = getMiddleware(fakeServer);

    const next = vi.fn();
    const { res } = makeRes();
    await middleware(makeReq('GET', '/api/projects'), res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('/api/pty/ensure は resolveActualPort 由来の port（2222）で ptySessions.ensure を呼ぶ', async () => {
    const ensureSpy = vi.spyOn(ptySessions, 'ensure').mockResolvedValue({ ok: true });
    vi.spyOn(ptySessions, 'state').mockReturnValue('running');
    vi.spyOn(ptySessions, 'currentTool').mockReturnValue('claude');
    vi.spyOn(ptySessions, 'notes').mockReturnValue([]);

    const fakeServer = makeFakeServer();
    applyPlugin(fakeServer);
    const middleware = getMiddleware(fakeServer);

    const next = vi.fn();
    const { res, captured } = makeRes();
    await middleware(makeReq('POST', '/api/pty/ensure', { tool: 'claude' }), res, next);

    expect(captured.status).toBe(200);
    expect(ensureSpy).toHaveBeenCalledWith(expect.objectContaining({ port: 2222 }));
    expect(next).not.toHaveBeenCalled();
  });

  /**
   * readBodySafe が意図的に re-throw する 413（ボディ超過）を、レスポンスへ変換するのは
   * configureServer の catch 1箇所のみ（handleAiApi 自体は reject する）。この catch を
   * 誰かが外すと unhandled rejection になり応答が返らず接続がハングする（aiPlugin.ts の
   * コメントが警告する事故そのもの）。handleAiApi の reject を確認するだけのテストでは
   * catch 側の配線が壊れても検出できないため、ここでは実際にミドルウェアを経由させる。
   */
  it('413（ボディ超過）は catch がレスポンスへ変換し next() を呼ばない', async () => {
    const fakeServer = makeFakeServer();
    applyPlugin(fakeServer);
    const middleware = getMiddleware(fakeServer);

    const next = vi.fn();
    const { res, captured } = makeRes();
    const bigTool = 'a'.repeat(70 * 1024);
    await middleware(makeReq('POST', '/api/pty/ensure', { tool: bigTool }), res, next);

    expect(captured.status).toBe(413);
    expect(next).not.toHaveBeenCalled();
  });
});
