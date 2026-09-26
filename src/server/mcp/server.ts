import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { InstructionInbox } from '../instructionInbox';
import { getNextInstruction, reportInstructionStatus } from './tools';
import type { EditorAgentService } from '../editorAgentService';
import { editorToolInputError, registerEditorTools } from './editorTools';
import { editorAgentRequestIdentifiers, publicEditorAgentError } from '../../shared/editorAgentErrors';

// ロングポーリングのブロック上限。5 分のプロンプトキャッシュ TTL 未満に保ち、
// 再呼び出し時のコールド再計算（高額化）を避ける。
const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 240_000;
const requestSignals = new Map<string, AbortSignal>();

function requestKey(sessionId: string, requestId: string | number): string {
  return JSON.stringify([sessionId, typeof requestId, requestId]);
}

function requestIds(parsedBody: unknown): Array<string | number> {
  const requests = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  return requests.flatMap((request) => {
    if (!request || typeof request !== 'object' || !('id' in request)) return [];
    const id = (request as { id: unknown }).id;
    return typeof id === 'string' || typeof id === 'number' ? [id] : [];
  });
}

async function withRequestAbort<T>(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string | undefined,
  parsedBody: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const keys = sessionId === undefined
    ? []
    : requestIds(parsedBody).map((id) => requestKey(sessionId, id));
  for (const key of keys) requestSignals.set(key, controller.signal);
  const cleanup = () => {
    req.off('aborted', onRequestAbort);
    res.off('close', onResponseClose);
    res.off('finish', cleanup);
    for (const key of keys) {
      if (requestSignals.get(key) === controller.signal) requestSignals.delete(key);
    }
  };
  const onRequestAbort = () => {
    controller.abort();
    cleanup();
  };
  const onResponseClose = () => {
    // `close` also follows a normal `end`; only an incomplete response means the requester left.
    if (!res.writableEnded) controller.abort();
    cleanup();
  };
  // A client can abort after its request body has been read but while the long-poll response is
  // pending. Node reports that on the request and/or the unfinished response depending on timing.
  req.once('aborted', onRequestAbort);
  res.once('close', onResponseClose);
  res.once('finish', cleanup);
  try {
    return await run();
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** 受け箱の2操作に、利用可能なら型付き編集と案件・方針の読み取りを追加する。 */
function buildMcpServer(inbox: InstructionInbox, editor?: EditorAgentService): McpServer {
  const server = new McpServer({ name: 'harness-editor', version: '0.1.0' });
  if (editor) registerEditorTools(server, editor);

  server.registerTool(
    'get_next_instruction',
    {
      title: '次の編集指示を取得',
      description:
        'エディタ画面から届いた未処理の編集指示を 1 件取り出す。無ければサーバ側で最大 waitMs ' +
        'ブロックして待つ（待機中はトークンを消費しない）。字幕本文はeditor_read→editor_validate→editor_applyを優先し、人の未保存編集を保護する。未対応操作は能力と既存案件の契約を確認する。',
      inputSchema: {
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_MS)
          .optional()
          .describe('ブロック上限ミリ秒（既定 120000）'),
        projectId: z
          .string()
          .optional()
          .describe('指定するとこのプロジェクトの指示だけを受け取る（動画専属モード）'),
      },
    },
    async ({ waitMs, projectId }, extra) => {
      const httpSignal = extra.sessionId === undefined
        ? undefined
        : requestSignals.get(requestKey(extra.sessionId, extra.requestId));
      const signal = httpSignal ? AbortSignal.any([extra.signal, httpSignal]) : extra.signal;
      const result = await getNextInstruction(inbox, waitMs ?? DEFAULT_WAIT_MS, projectId, signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'report_instruction_status',
    {
      title: '編集指示の結果を報告',
      description: '指示の処理結果（done/failed）と一言返答を画面へ書き戻す。編集が終わったら必ず呼ぶ。',
      inputSchema: {
        id: z.string().describe('get_next_instruction が返した指示 id'),
        status: z.enum(['done', 'failed']),
        reply: z.string().describe('画面に表示する一言（例: テロップを赤にしました / 対象が特定できません）'),
      },
    },
    async ({ id, status, reply }) => {
      const result = reportInstructionStatus(inbox, { id, status, reply });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  return server;
}

// セッションごとのトランスポートを保持（mcp-session-id ヘッダで再利用）。
type TransportEntry = { transport: StreamableHTTPServerTransport; editor?: EditorAgentService };
const transports = new Map<string, TransportEntry>();

function rejectUnknownSession(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(publicEditorAgentError(
    new Error('MCP セッションが失効しました。initialize から接続し直してください'), {}, 'MCP_SESSION_EXPIRED')));
}

function rejectExpiredToolCall(res: ServerResponse, parsedBody: unknown): boolean {
  const wasBatch = Array.isArray(parsedBody);
  const requests = wasBatch ? parsedBody : [parsedBody];
  const replies = requests.flatMap((request) => {
    if (!request || typeof request !== 'object' || !('id' in request)
      || !('method' in request) || request.method !== 'tools/call') return [];
    const id = (request as { id: unknown }).id;
    if (typeof id !== 'string' && typeof id !== 'number') return [];
    const params = (request as { params?: unknown }).params;
    const input = params && typeof params === 'object' ? (params as { arguments?: unknown }).arguments : undefined;
    return [{ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text',
      text: JSON.stringify(publicEditorAgentError(
        new Error('MCP_SESSION_EXPIRED: エディタが再起動しました。initialize から接続し直してください'),
        editorAgentRequestIdentifiers(input))) }] } }];
  });
  if (replies.length === 0) return false;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(wasBatch ? replies : replies[0]));
  return true;
}

/**
 * The SDK validates a tool schema before calling its handler and turns that failure into an
 * unstructured text result. Intercept only the seven public editor tools after the transport has
 * validated JSON-RPC/session/protocol, then use the exact same schemas used for registration.
 */
function installEditorInputValidation(transport: StreamableHTTPServerTransport): void {
  const next = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if (isJSONRPCRequest(message) && message.method === 'tools/call'
      && message.params && typeof message.params === 'object') {
      const params = message.params as { name?: unknown; arguments?: unknown };
      if (typeof params.name === 'string') {
        const detail = editorToolInputError(params.name, params.arguments);
        if (detail) {
          void transport.send({ jsonrpc: '2.0', id: message.id, result: { isError: true,
            content: [{ type: 'text', text: JSON.stringify(detail) }] } }).catch((error: unknown) => {
            transport.onerror?.(error instanceof Error ? error : new Error(String(error)));
          });
          return;
        }
      }
    }
    next?.(message, extra);
  };
}

/**
 * /mcp の HTTP リクエストを処理する。Vite ミドルウェアの req/res をそのまま渡せる。
 * POST: 既存セッションがあれば再利用、無ければ初期化。GET/DELETE: 既存セッションに委譲。
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  inbox: InstructionInbox,
  parsedBody: unknown,
  editor?: EditorAgentService,
): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];
  if (typeof sessionId === 'string') {
    const existing = transports.get(sessionId);
    if (!existing) {
      rejectUnknownSession(res);
      return;
    }
    // Tool handlers close over the editor owner that existed at initialize time. Never allow an
    // old transport to mutate through that captured service after Vite replaces the owner.
    if (existing.editor !== editor && parsedBody !== undefined) {
      transports.delete(sessionId);
      await existing.transport.close();
      // Return a tool-level error for the request that discovers the generation change so clients
      // can surface the reason. The session is already removed; every later use receives HTTP 404.
      if (!rejectExpiredToolCall(res, parsedBody)) rejectUnknownSession(res);
      return;
    }
    await withRequestAbort(req, res, sessionId, parsedBody,
      () => existing.transport.handleRequest(req, res, parsedBody));
    return;
  }

  // Per Streamable HTTP, a request carrying an unknown session ID cannot initialize a replacement
  // session implicitly. The client must retry initialize without the stale ID.
  if (sessionId !== undefined) {
    rejectUnknownSession(res);
    return;
  }

  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(publicEditorAgentError(
      new Error('MCP セッションが未確立です（先に initialize してください）'), {}, 'MCP_SESSION_REQUIRED')));
    return;
  }

  // 新規セッション: initialize POST。
  let entry: TransportEntry | null = null;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      entry = { transport, editor };
      transports.set(sid, entry);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId && transports.get(transport.sessionId) === entry) transports.delete(transport.sessionId);
  };
  const server = buildMcpServer(inbox, editor);
  await server.connect(transport);
  if (editor) installEditorInputValidation(transport);
  await withRequestAbort(req, res, undefined, parsedBody,
    () => transport.handleRequest(req, res, parsedBody));
}
