import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SlidesAgentError, type SlidesAgent } from './agent';
import type { AiWriteGuard } from '../aiFocus';

const id = z.string().min(1).max(256);
const target = { projectId: id, documentId: id, sessionId: id, expectedRevision: z.number().int().nonnegative() };
export const SLIDES_TOOL_INPUT_SCHEMAS = {
  slides_read: z.object({ projectId: id.optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional() }),
  slides_validate: z.object({ ...target, kind: z.enum(['outline', 'pages']), regenerate: z.boolean().optional(), payload: z.unknown() }),
  slides_apply_outline: z.object({ ...target, operationId: id, model: z.string().max(80).optional(), payload: z.unknown() }),
  slides_apply_pages: z.object({ ...target, operationId: id, runId: id, regenerate: z.boolean().optional(), model: z.string().max(80).optional(), payload: z.unknown() }),
  slides_runs: z.object({ projectId: id, operationId: id.optional(), runId: id.optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }),
  slides_cancel: z.object({ ...target, operationId: id, runId: id }),
} as const;
export function slidesToolError(error: unknown): { code: string; message: string; recovery: string } {
  if (error instanceof SlidesAgentError) return { code: error.code, message: error.message, recovery: error.recovery };
  return { code: 'FAILED', message: error instanceof Error ? error.message : String(error), recovery: 'slides_read で今の状態を確かめてから、もう一度試してください' };
}

/** 既存の /mcp にスライドの道具を足す。貼り付けの経路（HTTP /apply）と同じ受け口・同じ検証器を通る。guard は AI タブの接続だけに付く。 */
export function registerSlidesTools(server: McpServer, agent: SlidesAgent, guard?: AiWriteGuard): void {
  const respond = async (run: () => unknown) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await run()) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: slidesToolError(error) }) }] }; }
  };
  /** 書き込みの前に、依頼時点の案件かを確かめる（貼り付けの経路は人の操作なので確かめない）。 */
  const allow = (projectId: string) => {
    const denied = guard?.(projectId);
    if (denied) throw new SlidesAgentError(denied.code, denied.message, denied.recovery);
  };
  server.registerTool('slides_read', { title: 'スライドを読む',
    description: 'projectId なしでスライド案件の一覧。ありで documentId・sessionId・revision・台本の段落（既定 100 件、続きは offset）・レイアウト 6 種の入力型と文字数の上限・テーマ・生成の状態（runId・各ページの状態）・ページの一覧を返す。以後の要求にはここで得た documentId・sessionId・revision を付ける。',
    inputSchema: SLIDES_TOOL_INPUT_SCHEMAS.slides_read.shape,
  }, ({ projectId, offset, limit }) => respond(() => agent.read(projectId, { offset, limit })));
  server.registerTool('slides_validate', { title: '構成案・ページ本文を事前に検証',
    description: 'kind=outline は harness-slides-outline/1、kind=pages は harness-slides-page/1 の配列（1〜8 ページ）。文書は変えず、問題の位置（path）と理由（message）を返す。適用の時も同じ検証をもう一度行う。',
    inputSchema: SLIDES_TOOL_INPUT_SCHEMAS.slides_validate.shape,
  }, ({ kind, regenerate, payload, ...target }) => respond(() => agent.validate({ ...target, kind, regenerate, payload })));
  server.registerTool('slides_apply_outline', { title: '構成案を渡す',
    description: '全段落をどれか 1 ページだけに入れた構成案を渡す。通れば 1 回の Undo で適用して保存し runId を返す。人が画面で確かめて確定するまで本文は受け取らない。同じ operationId・同じ内容の再送は再実行しない。拒否したときは文書を変えない。',
    inputSchema: SLIDES_TOOL_INPUT_SCHEMAS.slides_apply_outline.shape,
  }, ({ operationId, model, payload, ...target }) => respond(() => { allow(target.projectId); return agent.applyOutline({ ...target, operationId, model, payload, route: 'mcp' }); }));
  server.registerTool('slides_apply_pages', { title: 'ページ本文を渡す',
    description: '確定した構成案の key ごとの本文（1〜8 ページ）を渡す。合格したページだけ適用して保存し、不正なページは位置と理由を返す（修復は 1 ページにつき 2 回まで。超えると失敗として画面に示す）。生成済みのページは regenerate=true のときだけ受け取り、人が手で直したページは置き換え案になる。imageSlots[].file に PNG・JPEG・WebP の絶対パス（スライドの案件フォルダかホームフォルダの中の画像に限る）を渡すと取り込んで画像枠に置く。',
    inputSchema: SLIDES_TOOL_INPUT_SCHEMAS.slides_apply_pages.shape,
  }, ({ operationId, runId, regenerate, model, payload, ...target }) => respond(() => { allow(target.projectId); return agent.applyPages({ ...target, operationId, runId, regenerate, model, payload, route: 'mcp' }); }));
  server.registerTool('slides_runs', { title: '結果を照会',
    description: 'operationId を指定するとその操作の結果。指定しなければ生成の状態（各ページの状態・理由・修復回数・置き換え案の有無）と最近の操作（新しい順・既定 20 件）。応答が途切れたときはここで確かめ、結果が分からない操作を新しい operationId で送り直さない。',
    inputSchema: SLIDES_TOOL_INPUT_SCHEMAS.slides_runs.shape,
  }, ({ projectId, ...query }) => respond(() => agent.runs(projectId, query)));
  server.registerTool('slides_cancel', { title: '生成を中止',
    description: '構成案の確認中または生成中の runId を中止する。適用済みのページは残り、画面の元に戻すで戻せる。再開は画面の「続きから作る」。',
    inputSchema: SLIDES_TOOL_INPUT_SCHEMAS.slides_cancel.shape,
  }, ({ operationId, runId, ...target }) => respond(() => { allow(target.projectId); return agent.cancel({ ...target, operationId, runId, route: 'mcp' }); }));
}
