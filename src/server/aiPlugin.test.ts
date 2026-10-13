/**
 * aiPlugin の HTTP ハンドラを、実際のリクエスト/レスポンスに近い偽物を通して検証する。
 * 旧版はソースの文字列検査だったが、ルーティング・ステータス・ボディの実際の値を
 * 押さえられないという外部レビュー指摘（P1-5）を受けて実経路に切り替えた。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleAiApi, resolveActualPort, apiKeyDetected, smeAi } from './aiPlugin';
import * as aiToolBin from './aiToolBin';
import { ptySessions } from './ptySession';
import { claudeInstallJob } from './claudeInstallJob';
import { handlePtyUpgrade, ptyTokens } from './ptyApi';
import { safeAttachmentName, terminalAttachmentRoot } from './terminalAttachment';
import { aiFocus } from './aiFocus';
import * as aiLogin from './aiLogin';
import { instructionInbox } from './instructionInbox';
import { noteAiTabMcp, resetAiTabMcp } from './mcp/aiTabClient';
import { SequenceStore } from './sequence/store';
import { thumbnailService } from './thumbnail/service';

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

describe('起動の最初の依頼（/api/pty/ensure）', () => {
  const screen = { projectId: 'first-a', projectName: '10月の講義', mode: 'thumbnail', target: null, playheadSec: null, selection: [], materials: '' };
  it('主画面の状況から最初の依頼を作って ensure に渡す', async () => {
    const ensure = vi.spyOn(ptySessions, 'ensure').mockResolvedValue({ ok: true });
    const { res } = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/ensure', { tool: 'claude', focus: { pageId: 'page-first-1', seq: 1, screen } }), res, ctx());
    expect(ensure.mock.calls[0]![0].firstPrompt).toContain('「10月の講義（サムネ）を見ています。何をしましょう？」');
    aiFocus.release('page-first-1');
  });
  it('purpose=login（ログインのための起動）では最初の依頼を渡さない', async () => {
    const ensure = vi.spyOn(ptySessions, 'ensure').mockResolvedValue({ ok: true });
    const { res } = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/ensure', { tool: 'claude', purpose: 'login' }), res, ctx());
    expect(ensure.mock.calls[0]![0].firstPrompt).toBeNull();
  });
  it('待機の口は無くなった', async () => {
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/waiting'), res, ctx());
    expect(captured.status).toBe(404);
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

  it('採用パス・探索段・4 状態を返す', async () => {
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('GET', '/api/ai/tools'), res, ctx());
    const body = captured.body as { tools: Record<string, unknown>[] };
    for (const tool of body.tools) {
      expect(Object.keys(tool).sort()).toEqual(
        ['id', 'installable', 'installed', 'label', 'path', 'source', 'status', 'versionOk'],
      );
      expect(['ready', 'outdated', 'missing', 'unverified']).toContain(tool.status);
      if (tool.installed) expect(typeof tool.path).toBe('string');
      else expect(tool.path).toBeNull();
    }
  });

  it('I1: recheck=1 のときだけ findTool/checkToolVersion に bypassCache:true を渡す', async () => {
    const loc = { file: '/bin/claude', args: [], path: '/bin/claude', source: 'path' as const };
    const findSpy = vi.spyOn(aiToolBin, 'findTool').mockResolvedValue(loc);
    const verSpy = vi.spyOn(aiToolBin, 'checkToolVersion').mockResolvedValue({ ok: true });
    const { res } = makeRes();
    await handleAiApi(makeReq('GET', '/api/ai/tools?recheck=1'), res, ctx());
    expect(findSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of findSpy.mock.calls) expect(call[1]?.bypassCache).toBe(true);
    for (const call of verSpy.mock.calls) expect(call[2]?.bypassCache).toBe(true);
  });

  it('I1: recheck 無しでは bypassCache を渡さない', async () => {
    const loc = { file: '/bin/claude', args: [], path: '/bin/claude', source: 'path' as const };
    const findSpy = vi.spyOn(aiToolBin, 'findTool').mockResolvedValue(loc);
    const verSpy = vi.spyOn(aiToolBin, 'checkToolVersion').mockResolvedValue({ ok: true });
    const { res } = makeRes();
    await handleAiApi(makeReq('GET', '/api/ai/tools'), res, ctx());
    expect(findSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of findSpy.mock.calls) expect(call[1]?.bypassCache).not.toBe(true);
    for (const call of verSpy.mock.calls) expect(call[2]?.bypassCache).not.toBe(true);
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

describe('POST /api/pty/attachment（ブラウザ版のターミナルへのドロップ）', () => {
  const upload = (url: string, bytes: Buffer, headers: Record<string, string> = {}): IncomingMessage =>
    Object.assign(Readable.from([bytes]), {
      method: 'POST', url,
      headers: { host: '127.0.0.1:2109', origin: 'http://127.0.0.1:2109', 'sec-fetch-site': 'same-origin', ...headers },
    }) as unknown as IncomingMessage;

  it('中身を一時フォルダへ元の名前で保存し、その絶対パスを返す', async () => {
    const { res, captured } = makeRes();
    const name = 'スイング 画像(1).png';
    await handleAiApi(upload(`/api/pty/attachment?${new URLSearchParams({ name })}`, Buffer.from('PNGDATA')), res, ctx());
    expect(captured.status).toBe(200);
    const path = (captured.body as { path: string }).path;
    try {
      expect(isAbsolute(path)).toBe(true);
      expect(basename(path)).toBe(name);
      expect(dirname(dirname(path))).toBe(terminalAttachmentRoot());
      expect(readFileSync(path, 'utf8')).toBe('PNGDATA');
    } finally { rmSync(dirname(path), { recursive: true, force: true }); }
  });

  it('名前に含まれるフォルダ区切りは捨て、保存先の外へ出さない', async () => {
    const { res, captured } = makeRes();
    await handleAiApi(upload(`/api/pty/attachment?${new URLSearchParams({ name: '../../evil/../x.png' })}`, Buffer.from('a')), res, ctx());
    const path = (captured.body as { path: string }).path;
    try {
      expect(basename(path)).toBe('x.png');
      expect(dirname(dirname(path))).toBe(terminalAttachmentRoot());
    } finally { rmSync(dirname(path), { recursive: true, force: true }); }
  });

  it('ローカル以外からの送信は 403（保存しない）', async () => {
    const { res, captured } = makeRes();
    await handleAiApi(upload('/api/pty/attachment?name=a.png', Buffer.from('a'), { origin: 'https://evil.example' }), res, ctx());
    expect(captured.status).toBe(403);
  });
});

describe('safeAttachmentName', () => {
  it('空・区切りだけ・制御文字は既定名や除去で安全な 1 階層の名前にする', () => {
    expect(safeAttachmentName(null)).toBe('file');
    expect(safeAttachmentName('..')).toBe('file');
    expect(safeAttachmentName('a\u0000b\nc.png')).toBe('abc.png');
    expect(safeAttachmentName('C:\\Media\\clip.mov')).toBe('clip.mov');
  });
  it('長すぎる名前は拡張子を残して切り詰める', () => {
    const long = 'a'.repeat(300) + '.mov';
    const safe = safeAttachmentName(long);
    expect(safe.length).toBe(120);
    expect(safe.endsWith('.mov')).toBe(true);
  });
  it('日本語の名前は UTF-8 のバイト数で切り詰める（Linux の 255 バイト上限を超えない）', () => {
    const safe = safeAttachmentName('あ'.repeat(116) + '.mov');
    expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(200);
    expect(safe.endsWith('.mov')).toBe(true);
    expect(safe.startsWith('あ')).toBe(true);
    // 文字の途中で切らない（壊れた UTF-8 を作らない）。
    expect(safe).not.toContain('\uFFFD');
  });
});

describe('/api/ai/focus（画面の状況）', () => {
  const screen = { projectId: 'focus-a', projectName: '案件A', mode: 'video', target: { kind: 'video', editorSessionId: 'w-a' },
    playheadSec: 1.5, selection: [], materials: '' };
  it('報告を受けて主画面かどうかを返し、GET で台帳の見え方を返す', async () => {
    aiFocus.claim({ pageId: 'page-focus-1', seq: 1, screen });
    const posted = makeRes();
    await handleAiApi(makeReq('POST', '/api/ai/focus', { pageId: 'page-focus-1', seq: 2, screen: { ...screen, mode: 'thumbnail', target: null } }), posted.res, ctx());
    expect(posted.captured).toEqual({ status: 200, body: { primary: true } });
    const read = makeRes();
    await handleAiApi(makeReq('GET', '/api/ai/focus'), read.res, ctx());
    expect(read.captured.status).toBe(200);
    expect((read.captured.body as { primary: { screen: { mode: string } } }).primary.screen.mode).toBe('thumbnail');
    aiFocus.release('page-focus-1');
  });
  it('形の違う報告は 400', async () => {
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/ai/focus', { pageId: 'page-focus-2', seq: 1, screen: { projectId: 'x' } }), res, ctx());
    expect(captured).toEqual({ status: 400, body: { error: '画面の状況の形が正しくありません' } });
  });
  it('release でその画面を忘れる（主画面なら主画面も無くなる）', async () => {
    aiFocus.claim({ pageId: 'page-focus-3', seq: 1, screen });
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/ai/focus/release', { pageId: 'page-focus-3' }), res, ctx());
    expect(captured).toEqual({ status: 200, body: { ok: true } });
    expect(aiFocus.primary()).toBeNull();
  });
});

describe('AI タブを開いた画面を主画面にする（/api/pty/ensure・/api/pty/switch）', () => {
  const screen = { projectId: 'claim-a', projectName: '案件A', mode: 'slides', target: null, playheadSec: null, selection: [], materials: '' };
  it('ensure の本文の focus で主画面を登録する', async () => {
    vi.spyOn(ptySessions, 'ensure').mockResolvedValue({ ok: true });
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/ensure', { tool: 'claude', theme: 'dark', focus: { pageId: 'page-claim-1', seq: 1, screen } }), res, ctx());
    expect(captured.status).toBe(200);
    expect(aiFocus.primary()).toMatchObject({ pageId: 'page-claim-1', screen: { projectId: 'claim-a', mode: 'slides' } });
    aiFocus.release('page-claim-1');
  });
  it('switch でも登録する。形の違う focus は無視して起動は続ける', async () => {
    vi.spyOn(ptySessions, 'switchTool').mockResolvedValue({ ok: true, actualTool: 'codex', sessionId: 's', notes: [] });
    const bad = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/switch', { tool: 'codex', focus: { pageId: 'x' } }), bad.res, ctx());
    expect(bad.captured.status).toBe(200);
    const good = makeRes();
    await handleAiApi(makeReq('POST', '/api/pty/switch', { tool: 'codex', focus: { pageId: 'page-claim-2', seq: 1, screen } }), good.res, ctx());
    expect(aiFocus.primary()?.pageId).toBe('page-claim-2');
    aiFocus.release('page-claim-2');
  });
});

describe('ボタンの依頼（/api/ai/requests）と在席（/api/ai/presence）', () => {
  // 同じ requestId の再送は受付時刻も同じ（画面は作った時の値を送り直す）。呼ぶたびに Date.now() だとミリ秒の境目で 409 になる。
  const requestCreatedAt = Date.now();
  const body = (projectId: string, requestId?: string) => ({ projectId, text: 'スライド: 構成案を作って', context: { frame: 0, timeSec: 0, selection: null },
    ...(requestId ? { requestId, requestCreatedAt } : {}) });
  it('記録を作って入力欄に貼り、記録（送信待ち）を返す。同じ requestId は貼り直さない', async () => {
    vi.spyOn(ptySessions, 'state').mockReturnValue('running');
    const paste = vi.spyOn(ptySessions, 'paste').mockReturnValue({ ok: true });
    const first = makeRes();
    await handleAiApi(makeReq('POST', '/api/ai/requests', body('req-a', 'request-a000000000000001')), first.res, ctx());
    expect(first.captured.status).toBe(200);
    const record = first.captured.body as { id: string; status: string };
    expect(record.status).toBe('pending');
    expect(paste).toHaveBeenCalledWith(`スライド: 構成案を作って（依頼 #${record.id.replace('inst-', '')}）`);
    const again = makeRes();
    await handleAiApi(makeReq('POST', '/api/ai/requests', body('req-a', 'request-a000000000000001')), again.res, ctx());
    expect((again.captured.body as { id: string }).id).toBe(record.id);
    expect(paste).toHaveBeenCalledTimes(1);
  });
  it('端末が起動していなければ 409 で、記録も作らない', async () => {
    vi.spyOn(ptySessions, 'state').mockReturnValue('idle');
    const { res, captured } = makeRes();
    await handleAiApi(makeReq('POST', '/api/ai/requests', body('req-b')), res, ctx());
    expect(captured).toMatchObject({ status: 409, body: { code: 'AI_NOT_RUNNING' } });
    expect(instructionInbox.list('req-b')).toEqual([]);
  });
  it('在席: 起動の後に AI タブの MCP 接続が来て初めて connected', async () => {
    resetAiTabMcp();
    vi.spyOn(ptySessions, 'state').mockReturnValue('running');
    vi.spyOn(ptySessions, 'startedAt').mockReturnValue(5_000);
    const before = makeRes();
    await handleAiApi(makeReq('GET', '/api/ai/presence'), before.res, ctx());
    expect(before.captured.body).toMatchObject({ terminal: 'running', mcp: false, connected: false, focus: { primary: null } });
    noteAiTabMcp(4_000);
    const old = makeRes();
    await handleAiApi(makeReq('GET', '/api/ai/presence'), old.res, ctx());
    expect(old.captured.body).toMatchObject({ connected: false });
    noteAiTabMcp(6_000);
    const after = makeRes();
    await handleAiApi(makeReq('GET', '/api/ai/presence'), after.res, ctx());
    expect(after.captured.body).toMatchObject({ mcp: true, connected: true });
    resetAiTabMcp();
  });
});

describe('サムネの AI のボタンの依頼（/api/ai/thumbnail-requests）', () => {
  const requestCreatedAt = Date.now();
  const post = (over: Record<string, unknown> = {}) => ({ projectId: 'thumb-wire', kind: 'new', pageId: null, cutout: 'auto', note: '配線の確認',
    requestId: 'thumbwire-0000000000000001', requestCreatedAt, ...over });
  it('形が違えば 400。AI が起動していなければ 409。id の無い照会は 400、知らない案件の照会は 404', async () => {
    vi.stubEnv('HARNESS_PROJECT_ROOT', editorDir);
    vi.spyOn(ptySessions, 'state').mockReturnValue('idle');
    const bad = makeRes();
    await handleAiApi(makeReq('POST', '/api/ai/thumbnail-requests', { projectId: 'x' }), bad.res, ctx());
    expect(bad.captured).toMatchObject({ status: 400, body: { code: 'INVALID_INPUT' } });
    const idle = makeRes();
    await handleAiApi(makeReq('POST', '/api/ai/thumbnail-requests', post()), idle.res, ctx());
    expect(idle.captured).toMatchObject({ status: 409, body: { code: 'AI_NOT_RUNNING' } });
    const noId = makeRes();
    await handleAiApi(makeReq('GET', '/api/ai/thumbnail-requests'), noId.res, ctx());
    expect(noId.captured.status).toBe(400);
    const unknown = makeRes();
    await handleAiApi(makeReq('GET', '/api/ai/thumbnail-requests?id=no-such-project'), unknown.res, ctx());
    expect(unknown.captured.status).toBe(404);
    vi.unstubAllEnvs();
  });
  it('案件のあるサムネで押すと依頼番号つきで貼り、照会が送信待ちを返す。同じ requestId は貼り直さない', async () => {
    vi.stubEnv('HARNESS_PROJECT_ROOT', editorDir);
    vi.spyOn(ptySessions, 'state').mockReturnValue('running');
    const paste = vi.spyOn(ptySessions, 'paste').mockReturnValue({ ok: true });
    const directory = join(editorDir, 'thumb-wire');
    mkdirSync(directory);
    new SequenceStore(directory).save({ expectedSavedRevision: null, executionId: 'v', document: { schemaVersion: 2, id: 'thumb-wire', name: 'thumb-wire', revision: 0, fps: { num: 30, den: 1 },
      resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 30, background: '#000000', assets: [], tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } } });
    thumbnailService.create(directory, 'c-wire');
    const first = makeRes();
    await handleAiApi(makeReq('POST', '/api/ai/thumbnail-requests', post()), first.res, ctx());
    expect(first.captured).toMatchObject({ status: 200, body: { status: 'pending', label: '送信待ち（AI タブで Enter）', request: { route: 'button', kind: 'new' } } });
    const requestId = (first.captured.body as { request: { requestId: string } }).request.requestId;
    expect(paste).toHaveBeenCalledWith(`サムネ: 新しい案を作って（切り抜き: AI に任せる）配線の確認（依頼 #${requestId.replace('inst-', '')}）`);
    const again = makeRes();
    await handleAiApi(makeReq('POST', '/api/ai/thumbnail-requests', post()), again.res, ctx());
    expect(paste).toHaveBeenCalledTimes(1);
    const read = makeRes();
    await handleAiApi(makeReq('GET', '/api/ai/thumbnail-requests?id=thumb-wire'), read.res, ctx());
    expect(read.captured).toMatchObject({ status: 200, body: { status: 'pending', request: { requestId } } });
    vi.unstubAllEnvs();
  });
});

describe('GET /api/ai/login', () => {
  it('ツールのログイン状態を返す。知らないツールは 400', async () => {
    vi.spyOn(aiLogin, 'aiLoginState').mockResolvedValue('missing');
    const ok = makeRes();
    await handleAiApi(makeReq('GET', '/api/ai/login?tool=codex'), ok.res, ctx());
    expect(ok.captured).toEqual({ status: 200, body: { state: 'missing' } });
    const bad = makeRes();
    await handleAiApi(makeReq('GET', '/api/ai/login?tool=gemini'), bad.res, ctx());
    expect(bad.captured.status).toBe(400);
  });
});
