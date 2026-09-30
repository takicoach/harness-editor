/**
 * smeAi() — 埋め込み AI ターミナル関連の独立 Vite プラグイン。
 * vite.config.ts で smeServer() の「前」に置くこと（ミドルウェアは登録順に走り、
 * 既存ルーターは未知の /api/* を 404 で終端するため、後ろに置くと届かない）。
 * 既存 plugin.ts には触らない設計（スペック「構成」節）。
 *
 * ルーティング本体は handleAiApi として export する。configureServer 内の無名関数に
 * 閉じ込めるとテストから実経路を叩けず、文字列検査に頼るしかなくなるため
 * （外部レビュー P1-5）。
 */
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAllowedLocalRequest } from './localGuard';
import { AI_TOOLS, DEFAULT_AI_TOOL, isAiToolId, type AiToolId } from './aiTools';
import { checkToolVersion, findTool, type ToolStatus } from './aiToolBin';
import { claudeInstallJob } from './claudeInstallJob';
import { HttpError, sendJson } from './http';
import { handlePtyUpgrade, ptyTokens } from './ptyApi';
import { ptySessions } from './ptySession';
import { getProjectRoot } from './projectRoot';
import { JOB_BODY_MAX_BYTES, readJsonBody } from './readBody';
import { saveTerminalAttachment } from './terminalAttachment';

/** 課金系の環境変数が検出されたか（UI 警告用。除去そのものは ptySession が行う）。 */
export function apiKeyDetected(env: NodeJS.ProcessEnv): boolean {
  const keys = new Set<string>();
  for (const t of Object.values(AI_TOOLS)) for (const k of t.billingEnvKeys) keys.add(k);
  for (const k of keys) if (env[k]) return true;
  return false;
}

/**
 * 実ポート解決に必要な最小限の形（構造的部分型。ViteDevServer 全体を要求しない
 * ことでテストが実サーバー無しにモック可能）。
 */
interface PortResolvable {
  httpServer?: { address(): { port: number } | string | null } | null;
  config: { server: { port?: number } };
}

/**
 * MCP URL のポートは決め打ちではなく Vite の実ポートに追随させる。
 * 決め打ちだと 2109 以外で起動したエディタの埋め込み AI が「別インスタンスの MCP」へ
 * 接続する汚染経路になる（address() は listen 後にのみ有効）。
 */
export function resolveActualPort(server: PortResolvable): number {
  const addr = server.httpServer?.address();
  if (addr && typeof addr === 'object') return addr.port;
  return server.config.server.port ?? 2109;
}

export interface AiApiContext {
  editorDir: string;
  port: number;
  env: NodeJS.ProcessEnv;
}

/**
 * ボディを読み、失敗しても throw しない（空ボディ・非 JSON を許す）。
 * この口が受けるのは tool/theme 程度の小さな JSON のみなので上限は
 * JOB_BODY_MAX_BYTES（64 KiB）に絞る。ただし 413（上限超過）は握り潰さない —
 * 巨大ボディを「空ボディ」と同列に扱うと、実際は「ボディが大きすぎる」DoS 的な
 * 入力が「対応していない AI ツールです」という無関係な 400 に化けて原因が分からなくなる。
 */
async function readBodySafe(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const body = await readJsonBody(req, JOB_BODY_MAX_BYTES);
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  } catch (err) {
    if (err instanceof HttpError && err.status === 413) throw err;
    return {};
  }
}

function readTheme(body: Record<string, unknown>): 'light' | 'dark' {
  return body.theme === 'light' ? 'light' : 'dark';
}

/**
 * ボディの tool を許可リストで検証する。未指定は既定ツール。
 * 未知の値は null を返し、呼び出し側が 400 にする（許可リスト外の文字列が
 * spawn の引数へ届く経路を作らない）。
 */
function readTool(body: Record<string, unknown>): AiToolId | null {
  if (body.tool === undefined) return DEFAULT_AI_TOOL;
  return isAiToolId(body.tool) ? body.tool : null;
}

/**
 * /api/ai/* と /api/pty/* を処理する。処理したら true、対象外パスなら false。
 */
export async function handleAiApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AiApiContext,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    // 極端に不正な request-target で URL 解析が throw した場合、ここで例外を
    // 伝播させると無関係なリクエスト（本来 Vite の他ミドルウェアが処理すべきもの）まで
    // 500 で巻き添えにする。対象外パス（return false）と同じ扱いにして next() へ委譲する。
    return false;
  }
  if (!url.pathname.startsWith('/api/ai/') && !url.pathname.startsWith('/api/pty/')) return false;
  if (!isAllowedLocalRequest(req.headers)) {
    sendJson(res, 403, { error: 'ローカル以外からのアクセスは許可されていません' });
    return true;
  }
  const method = (req.method ?? 'GET').toUpperCase();

  if (url.pathname === '/api/pty/token' && method === 'GET') {
    sendJson(res, 200, { token: ptyTokens.issue() });
    return true;
  }

  if (url.pathname === '/api/pty/ensure' && method === 'POST') {
    const body = await readBodySafe(req);
    const tool = readTool(body);
    if (tool === null) { sendJson(res, 400, { error: '対応していない AI ツールです' }); return true; }
    const r = await ptySessions.ensure({
      editorDir: ctx.editorDir,
      projectRoot: getProjectRoot(),
      env: ctx.env,
      port: ctx.port,
      theme: readTheme(body),
      tool,
    });
    if (!r.ok) {
      sendJson(res, 409, { error: r.error, code: r.code, actualTool: r.actualTool });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      state: ptySessions.state(),
      actualTool: ptySessions.currentTool(),
      notes: ptySessions.notes(),
    });
    return true;
  }

  if (url.pathname === '/api/pty/switch' && method === 'POST') {
    const body = await readBodySafe(req);
    // switch は ensure と違い「未指定なら既定ツール」を許さない（切り替え先を明示させる）。
    // 「未指定」と「指定されたが許可リスト外」は原因が違うので別文言にし、かつ
    // body.tool === undefined を先に見ることでその非対称の意図をコードからも読めるようにする。
    if (body.tool === undefined) {
      sendJson(res, 400, { error: '切り替え先の AI ツールを指定してください' });
      return true;
    }
    const tool = readTool(body);
    if (tool === null) {
      sendJson(res, 400, { error: '対応していない AI ツールです' });
      return true;
    }
    const r = await ptySessions.switchTool({
      editorDir: ctx.editorDir,
      projectRoot: getProjectRoot(),
      env: ctx.env,
      port: ctx.port,
      theme: readTheme(body),
      tool,
    });
    if (!r.ok) { sendJson(res, 409, { error: r.error, code: r.code }); return true; }
    sendJson(res, 200, { ok: true, actualTool: r.actualTool, sessionId: r.sessionId, notes: r.notes });
    return true;
  }

  // ブラウザ版のターミナルへファイルをドロップした時の受け皿。保存先の絶対パスを返す。
  if (url.pathname === '/api/pty/attachment' && method === 'POST') {
    sendJson(res, 200, { path: await saveTerminalAttachment(req, url.searchParams.get('name')) });
    return true;
  }

  if (url.pathname === '/api/pty/waiting' && method === 'POST') {
    const r = ptySessions.startWaiting();
    if (!r.ok) { sendJson(res, 409, { error: r.error }); return true; }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === '/api/ai/tools' && method === 'GET') {
    // I1（レビュー指摘）: 「再確認」ボタンは同じ GET を叩くだけだと TOOL_CACHE_TTL_MS
    // （5秒）以内は同じ結果が返り無効化する。`?recheck=1` のときだけキャッシュを
    // 素通しする。通常の一覧取得（初回表示・導入完了後の refreshTools）はキャッシュ
    // を使う——乱打を毎回フルスキャンにしないため。
    const bypassCache = url.searchParams.get('recheck') === '1';
    const tools = await Promise.all(Object.values(AI_TOOLS).map(async (t) => {
      const loc = await findTool(t, { editorDir: ctx.editorDir, bypassCache });
      const version = loc === null ? null : await checkToolVersion(t, loc, { bypassCache });
      const status: ToolStatus = loc === null ? 'missing'
        : version === null || version.ok === true ? 'ready' : version.ok === 'unverified' ? 'unverified' : 'outdated';
      return {
        id: t.id, label: t.label,
        installed: loc !== null,
        path: loc?.path ?? null,
        source: loc?.source ?? null,
        status,
        versionOk: status !== 'outdated',
        installable: t.installPackage !== null,
      };
    }));
    sendJson(res, 200, {
      tools,
      current: ptySessions.currentTool(),
      notes: ptySessions.notes(),
      apiKeyDetected: apiKeyDetected(ctx.env),
      allowApiKey: ctx.env.SME_ALLOW_API_KEY === '1',
      install: claudeInstallJob.status(),
    });
    return true;
  }

  if (url.pathname === '/api/ai/install' && method === 'POST') {
    const body = await readBodySafe(req);
    const tool = readTool(body);
    if (tool === null) { sendJson(res, 400, { error: '対応していない AI ツールです' }); return true; }
    if (AI_TOOLS[tool].installPackage === null) {
      // installPackage === null の一般分岐なので、特定パッケージ名を決め打ちしない
      // （codex 決め打ちだと3つ目のツールを追加したとき誤案内になる）。
      sendJson(res, 400, {
        error: `${AI_TOOLS[tool].label} は自動導入に対応していません。ターミナルから手動で導入してください。`,
      });
      return true;
    }
    const r = claudeInstallJob.start(ctx.editorDir);
    if (!r.ok) { sendJson(res, 409, { error: r.error }); return true; }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === '/api/ai/install/status' && method === 'GET') {
    sendJson(res, 200, claudeInstallJob.status());
    return true;
  }

  sendJson(res, 404, { error: `API が見つかりません: ${url.pathname}` });
  return true;
}

export function smeAi(): Plugin {
  const editorDir = process.cwd(); // vite は package.json のあるエディタルートで起動する
  return {
    name: 'sme-ai',
    configureServer(server) {
      server.httpServer?.on('upgrade', handlePtyUpgrade);
      server.httpServer?.on('close', () => {
        claudeInstallJob.killAll();
        ptySessions.killAll();
      });
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        // このハンドラ内で throw すると async 関数の Promise が unhandled rejection になり、
        // レスポンスを返さないまま接続がハングする。try/catch で必ず応答を返す。
        try {
          const handled = await handleAiApi(req, res, {
            editorDir,
            port: resolveActualPort(server),
            env: process.env,
          });
          if (!handled) next();
        } catch (err) {
          const status = err instanceof HttpError ? err.status : 500;
          const message = err instanceof Error ? err.message : String(err);
          console.error('[sme] AI API エラー:', err);
          if (!res.headersSent) sendJson(res, status, { error: message });
          else if (!res.writableEnded) res.end();
        }
      });
    },
  };
}
