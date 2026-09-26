import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { editorChangeSetSchema } from '../../shared/editorCommands';
import { editorOperationActivityPage } from '../../shared/editorActivity';
import { editorAgentRequestIdentifiers, publicEditorAgentError, type EditorAgentIdentifiers,
  type PublicEditorAgentError } from '../../shared/editorAgentErrors';
import { EDITOR_AGENT_CAPABILITIES } from '../editorAgentApi';
import type { EditorAgentService } from '../editorAgentService';

const id = z.string().min(1).max(256);
const pagination = { offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() };
const activityPagination = {
  offset: z.number().int().nonnegative().optional()
    .describe('初回は省略または0。続きは直前の応答にある正のnextOffsetを指定し、nullなら終端'),
  limit: z.number().int().min(1).max(100).optional().describe('1回に返す件数。省略時20、最大100'),
};
export const EDITOR_TOOL_INPUT_SCHEMAS = {
  editor_projects: z.object(pagination),
  editor_preferences: z.object({ projectId: id, ruleId: id.optional(), version: z.number().int().positive().optional(), ...pagination }),
  editor_read: z.object({ sessionId: id.optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional(),
    section:z.enum(['clips','assets','tracks','cuts','transcripts']).optional(),revision:id.optional() }),
  editor_validate: z.object({ sessionId: id, request: editorChangeSetSchema }),
  editor_apply: z.object({ sessionId: id, request: editorChangeSetSchema }),
  editor_runs: z.object({ runId: id.optional(), projectId: id.optional(), ...activityPagination }),
  editor_cancel: z.object({ runId: id }),
} as const;

export function editorToolInputError(name: string, input: unknown): PublicEditorAgentError | null {
  if (!Object.hasOwn(EDITOR_TOOL_INPUT_SCHEMAS, name)) return null;
  const schema = EDITOR_TOOL_INPUT_SCHEMAS[name as keyof typeof EDITOR_TOOL_INPUT_SCHEMAS];
  const result = schema.safeParse(input);
  return result.success ? null : publicEditorAgentError(new Error(
    `INVALID_EDITOR_INPUT: ${result.error.issues.map((issue) => issue.message).join(' / ')}`),
    editorAgentRequestIdentifiers(input));
}

/** Extend the existing MCP server. The browser remains the only typed-edit executor. */
export function registerEditorTools(server: McpServer, service: EditorAgentService) {
  const respond = (run: () => unknown, identifiers: EditorAgentIdentifiers = {}) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(run()) }] }; }
    catch (error) { return { isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify(publicEditorAgentError(error, identifiers)) }] }; }
  };
  server.registerTool('editor_projects', { title: '編集する案件を探す',
    description: '案件一覧と接続中の編集画面を取得。既定20件。nextOffsetとsnapshotHashで続きを確認。絶対パスや素材本文は返さない。実行には対象案件のreadyなsessionIdが必要。',
    inputSchema: EDITOR_TOOL_INPUT_SCHEMAS.editor_projects.shape,
  }, ({ offset, limit }) => respond(() => service.projects(offset, limit)));
  server.registerTool('editor_preferences', { title: '案件の編集方針と実例を読む',
    description: 'projectIdで割当方針のルールを取得。availableかつexcludedForProject=falseだけが利用可能。ruleIdとversionを指定すると学習同意が有効な根拠実例を取得。取消済み同意・保留・合成例は返さない。判断や同意、有効化を変更しない。',
    inputSchema: EDITOR_TOOL_INPUT_SCHEMAS.editor_preferences.shape,
  }, ({ projectId, ...options }) => respond(() => service.preferences(projectId, options), { projectId }));
  server.registerTool('editor_read', { title: '編集画面の現在状態を取得',
    description: '指定なしで利用可能操作と接続画面を取得。sessionIdのみで現在版と字幕を取得。独自編集はsection=clips/assets/tracks/cuts/transcriptsでタイムラインや元発話を最大100件取得。続きは初回のrevisionを指定し、版が変わったら読み直す。未保存や確認中は人の操作を待つ。',
    inputSchema: EDITOR_TOOL_INPUT_SCHEMAS.editor_read.shape,
  }, ({ sessionId, offset, limit,section,revision }) => respond(() => {
    if(section&&!sessionId)throw new Error('INVALID_EDITOR_INPUT: 編集画面のsessionIdを指定してください');
    return sessionId?(section?service.readNative(sessionId,{section,offset,limit,revision}):service.read(sessionId,offset,limit))
      :{capabilities:EDITOR_AGENT_CAPABILITIES,sessions:service.sessions.list()};
  }, { sessionId }));
  server.registerTool('editor_validate', { title: '編集案を検証',
    description: 'editor_readで得た版・IDを照合する。字幕本文にはbefore/referenceを指定。独自タイムライン編集はchanges=[]とsequence={documentId,commands:[型付き操作]}を指定し、既存編集処理で事前検証する。保存もUI変更も行わない。実行時にも再検証する。',
    inputSchema: EDITOR_TOOL_INPUT_SCHEMAS.editor_validate.shape,
  }, ({ sessionId, request }) => respond(() => service.validate(sessionId, request),
    { sessionId, projectId: request.projectId, operationId: request.operationId }));
  server.registerTool('editor_apply', { title: '編集を画面へ依頼',
    description: '型付き編集を既存の1回分のUndoと非上書き保存へ依頼しrunIdを返す。完了はeditor_runsで確認。同じoperationId/同じ本文の再送は再実行しない。保存済みは人の採用や学習同意ではない。',
    inputSchema: EDITOR_TOOL_INPUT_SCHEMAS.editor_apply.shape,
  }, ({ sessionId, request }) => respond(() => service.enqueue(sessionId, request),
    { sessionId, projectId: request.projectId, operationId: request.operationId }));
  server.registerTool('editor_runs', { title: 'AI編集の実行結果を確認',
    description: 'runIdで正確な履歴を取得。初回はoffsetを省略するか0を指定すると最近20件。続きは応答の正のnextOffsetをそのまま指定し、nullなら終端。limitは最大100件。applied/saved/結果不明と人の確認待ちを区別する。結果不明は画面の確認操作で再開し、自動再実行しない。',
    inputSchema: EDITOR_TOOL_INPUT_SCHEMAS.editor_runs.shape,
  }, ({ runId, projectId, offset, limit }) => respond(() => runId ? service.get(runId)
    : editorOperationActivityPage(service.list(projectId), offset, limit), { runId, projectId }));
  server.registerTool('editor_cancel', { title: 'AI編集の停止を要求',
    description: '未開始なら停止。適用済みの変更はUndoで戻せる。保存と行き違った場合は実際の結果を取得し、取消を巻き戻し成功と扱わない。',
    inputSchema: EDITOR_TOOL_INPUT_SCHEMAS.editor_cancel.shape,
  }, ({ runId }) => respond(() => service.cancel(runId), { runId }));
}
