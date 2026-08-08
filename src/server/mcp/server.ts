import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { InstructionInbox } from '../instructionInbox';
import { getNextInstruction, reportInstructionStatus } from './tools';

// ロングポーリングのブロック上限。5 分のプロンプトキャッシュ TTL 未満に保ち、
// 再呼び出し時のコールド再計算（高額化）を避ける。
const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 240_000;

/** 受け箱に紐づく McpServer を構築する（ツール 2 個を登録）。 */
function buildMcpServer(inbox: InstructionInbox): McpServer {
  const server = new McpServer({ name: 'harness-editor', version: '0.1.0' });

  server.registerTool(
    'get_next_instruction',
    {
      title: '次の編集指示を取得',
      description:
        'エディタ画面から届いた未処理の編集指示を 1 件取り出す。無ければサーバ側で最大 waitMs ' +
        'ブロックして待つ（待機中はトークンを消費しない）。返り値の projectDir 配下のファイルを編集すること。',
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
    async ({ waitMs, projectId }) => {
      const result = await getNextInstruction(inbox, waitMs ?? DEFAULT_WAIT_MS, projectId);
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
const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * /mcp の HTTP リクエストを処理する。Vite ミドルウェアの req/res をそのまま渡せる。
 * POST: 既存セッションがあれば再利用、無ければ初期化。GET/DELETE: 既存セッションに委譲。
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  inbox: InstructionInbox,
  parsedBody: unknown,
): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];
  const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

  if (existing) {
    await existing.handleRequest(req, res, parsedBody);
    return;
  }

  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'MCP セッションが未確立です（先に initialize してください）' }));
    return;
  }

  // 新規セッション: initialize POST。
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) transports.delete(transport.sessionId);
  };
  const server = buildMcpServer(inbox);
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}
