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
import { removeTerminalAttachments, saveTerminalAttachment } from './terminalAttachment';
import { aiFocus } from './aiFocus';
import { firstPrompt, withRequestNumber } from '../shared/agentPrompts';
import type { AiPresence } from '../shared/aiFocus';
import { instructionInbox, validateInstructionInput } from './instructionInbox';
import { aiTabMcpLastSeen } from './mcp/aiTabClient';
import { aiLoginState } from './aiLogin';
import { resolveProjectDir } from './projectRoot';
import { thumbnailAgent } from './thumbnail/agent';
import { createThumbnailAiButtonRequest, thumbnailAiLatest, type ThumbnailAiApiDeps } from './thumbnail/aiRequestApi';

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

/** AI タブを開いた画面を主画面にする（ensure・switch の本文の focus）。形が違っても起動は止めない。 */
function claimFocus(body: Record<string, unknown>): void {
  if (body.focus === undefined) return;
  try { aiFocus.claim(body.focus); } catch { /* 古い画面・壊れた本文は主画面にしない */ }
}

/** 起動の引数で 1 回だけ渡す最初の依頼。ログインのための起動（purpose=login）では渡さない。 */
function launchPrompt(body: Record<string, unknown>): string | null {
  return body.purpose === 'login' ? null : firstPrompt(aiFocus.primary()?.screen ?? null);
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
    claimFocus(body);
    const tool = readTool(body);
    if (tool === null) { sendJson(res, 400, { error: '対応していない AI ツールです' }); return true; }
    const r = await ptySessions.ensure({
      editorDir: ctx.editorDir,
      projectRoot: getProjectRoot(),
      env: ctx.env,
      port: ctx.port,
      theme: readTheme(body),
      tool,
      firstPrompt: launchPrompt(body),
      purpose: body.purpose === 'login' ? 'login' : 'work',
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
    claimFocus(body);
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
      firstPrompt: launchPrompt(body),
      purpose: body.purpose === 'login' ? 'login' : 'work',
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

  // AI タブの土台: 画面の状況（主画面の台帳）。画面は 2 秒ごとに送り、閉じる時は beacon で release を送る。
  if (url.pathname === '/api/ai/focus' && method === 'GET') {
    sendJson(res, 200, aiFocus.view());
    return true;
  }
  if (url.pathname === '/api/ai/focus' && method === 'POST') {
    const body = await readBodySafe(req);
    try { sendJson(res, 200, aiFocus.beat(body)); }
    catch { sendJson(res, 400, { error: '画面の状況の形が正しくありません' }); }
    return true;
  }
  if (url.pathname === '/api/ai/focus/release' && method === 'POST') {
    const body = await readBodySafe(req);
    if (typeof body.pageId === 'string') aiFocus.release(body.pageId);
    sendJson(res, 200, { ok: true });
    return true;
  }
  // AI タブの土台: 画面のボタンの依頼。記録を作って AI の入力欄に貼るだけ（送るのは利用者の Enter）。
  if (url.pathname === '/api/ai/requests' && method === 'POST') {
    const input = validateInstructionInput(await readJsonBody(req, JOB_BODY_MAX_BYTES));
    if (ptySessions.state() !== 'running') {
      sendJson(res, 409, { error: 'AI が起動していません。AI タブ（AI の作業）を開いて AI が起動してから、もう一度押してください', code: 'AI_NOT_RUNNING' });
      return true;
    }
    const { record, created } = instructionInbox.enqueuePasted({ ...input, projectDir: resolveProjectDir(getProjectRoot(), input.projectId) });
    if (created) {
      const pasted = ptySessions.paste(withRequestNumber(record.text, record.id));
      if (!pasted.ok) {
        instructionInbox.updateStatus(record.id, 'failed', 'AI の入力欄に貼れませんでした');
        sendJson(res, 409, { error: pasted.error, code: 'AI_NOT_RUNNING' });
        return true;
      }
    }
    sendJson(res, 200, record);
    return true;
  }
  // サムネの AI: 画面の「AI タブに入れる」と、欄の下の状態の照会。
  if (url.pathname === '/api/ai/thumbnail-requests') {
    const deps: ThumbnailAiApiDeps = { agent: thumbnailAgent, inbox: instructionInbox, running: () => ptySessions.state() === 'running',
      paste: text => ptySessions.paste(text), projectDir: projectId => resolveProjectDir(getProjectRoot(), projectId) };
    if (method === 'POST') { const result = createThumbnailAiButtonRequest(await readJsonBody(req, JOB_BODY_MAX_BYTES), deps); sendJson(res, result.status, result.body); return true; }
    if (method === 'GET') {
      const projectId = url.searchParams.get('id');
      if (!projectId) { sendJson(res, 400, { error: 'プロジェクトIDが必要です' }); return true; }
      try { sendJson(res, 200, thumbnailAiLatest(projectId, deps)); } catch { sendJson(res, 404, { error: '案件が見つかりません' }); }
      return true;
    }
  }
  // 「AI が使えるか」: 端末が起動していて、その起動の後に AI タブの MCP 接続が来た（受け箱の待機ではなく）。
  if (url.pathname === '/api/ai/presence' && method === 'GET') {
    const terminal = ptySessions.state(), startedAt = ptySessions.startedAt(), seen = aiTabMcpLastSeen();
    const mcp = terminal === 'running' && startedAt !== null && seen !== null && seen >= startedAt;
    const presence: AiPresence = { terminal, tool: ptySessions.currentTool(), mcp, connected: mcp, focus: aiFocus.view() };
    sendJson(res, 200, presence);
    return true;
  }

  if (url.pathname === '/api/ai/login' && method === 'GET') {
    const tool = url.searchParams.get('tool');
    if (!isAiToolId(tool)) { sendJson(res, 400, { error: '対応していない AI ツールです' }); return true; }
    sendJson(res, 200, { state: await aiLoginState(tool, { editorDir: ctx.editorDir, env: ctx.env }) });
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
      // AI が終了したら、貼り付けの依頼を「送られませんでした」「結果不明」にする（再起動後に結果を照会して送り直す）。
      ptySessions.onExit(() => { instructionInbox.failPasted(); });
      server.httpServer?.on('close', () => {
        claudeInstallJob.killAll();
        ptySessions.killAll();
        // 端末が終わればドロップした添付の一時コピーも参照されない。
        removeTerminalAttachments();
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
