import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { THUMBNAIL_AI_CUTOUTS, THUMBNAIL_AI_KINDS, THUMBNAIL_AI_MAX_FRAMES_PER_CALL } from '../../shared/thumbnailAi';
import type { AiTargetDenial } from '../aiFocus';
import { ThumbnailAgentError, type ThumbnailAgent } from './agent';

export const THUMBNAIL_TOOLS = ['thumbnail_begin', 'thumbnail_read', 'thumbnail_frames', 'thumbnail_preview', 'thumbnail_apply', 'thumbnail_runs'] as const;
export const THUMBNAIL_MODE_DENIAL: AiTargetDenial = { code: 'TARGET_NOT_REQUESTED', message: 'サムネの画面で頼まれた依頼ではありません',
  recovery: '利用者に、サムネの画面を開いてから頼み直してもらってください' };
const id = z.string().min(1).max(256), request = { projectId: id, requestId: id };
export const THUMBNAIL_TOOL_INPUT_SCHEMAS = {
  thumbnail_begin: z.object({ projectId: id, kind: z.enum(THUMBNAIL_AI_KINDS), pageId: id.optional(), replacePageId: id.optional(), cutout: z.enum(THUMBNAIL_AI_CUTOUTS).optional(), note: z.string().max(100).optional() }),
  thumbnail_read: z.object({ ...request, transcriptOffset: z.number().int().nonnegative().optional(), transcriptLimit: z.number().int().min(1).max(300).optional() }),
  thumbnail_frames: z.object({ ...request, assetId: id, streamIndex: z.number().int().nonnegative().optional(),
    seconds: z.array(z.number().nonnegative()).min(1).max(THUMBNAIL_AI_MAX_FRAMES_PER_CALL).optional(),
    range: z.object({ start: z.number().nonnegative(), end: z.number().nonnegative(), count: z.number().int().min(1).max(THUMBNAIL_AI_MAX_FRAMES_PER_CALL) }).optional() }),
  thumbnail_preview: z.object({ ...request, ops: z.array(z.unknown()) }),
  thumbnail_apply: z.object({ ...request, operationId: id, baseRevision: z.number().int().nonnegative(), ops: z.array(z.unknown()) }),
  thumbnail_runs: z.object(request),
} as const;
export function thumbnailToolError(error: unknown): { code: string; message: string; recovery: string } {
  if (error instanceof ThumbnailAgentError) return { code: error.code, message: error.message, recovery: error.recovery };
  return { code: 'FAILED', message: error instanceof Error ? error.message : String(error), recovery: 'thumbnail_read で今の状態を確かめてから、もう一度試してください' };
}
/** サムネの AI の道具。書き込みの範囲は依頼の記録で守る（依頼時点を見るのは thumbnail_begin だけ。設計「依頼の固定」）。 */
export function registerThumbnailTools(server: McpServer, agent: ThumbnailAgent, options: { origin: string; beginGuard?: (projectId: string) => AiTargetDenial | null }): void {
  const respond = async (run: () => unknown) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await run()) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: thumbnailToolError(error) }) }] }; }
  };
  server.registerTool('thumbnail_begin', { title: 'サムネの依頼を始める（端末から直接頼まれた時）',
    description: '画面のボタンの依頼（依頼文に「（依頼 #番号）」がある）では呼ばない。端末に直接頼まれた時に最初に呼び、requestId を受け取る。kind=edit は pageId（editor_context の screen.target.pageId）、kind=new で案が 3 つの時は利用者に聞いた入れ替える案を replacePageId に入れる（3 つ未満の時は入れない。断られる）。',
    inputSchema: THUMBNAIL_TOOL_INPUT_SCHEMAS.thumbnail_begin.shape,
  }, input => respond(() => {
    const denied = options.beginGuard?.(input.projectId);
    if (denied) throw new ThumbnailAgentError(denied.code, denied.message, denied.recovery);
    return agent.begin(input);
  }));
  server.registerTool('thumbnail_read', { title: 'サムネと依頼を読む',
    description: '文書（案・レイヤー・メインの案・版 revision）、依頼の対象（種類・対象の案・切り抜きの選択・ひとこと）、背景に使える動画（assetId・秒・大きさ）、字幕の行（元の秒。既定 150 行、続きは transcriptOffset）を返す。requestId は「#14」でもよい。',
    inputSchema: THUMBNAIL_TOOL_INPUT_SCHEMAS.thumbnail_read.shape,
  }, input => respond(() => agent.read(input)));
  server.registerTool('thumbnail_frames', { title: '動画のコマを見る',
    description: `元の動画から、seconds（最大 ${THUMBNAIL_AI_MAX_FRAMES_PER_CALL} 個）か range（区間を count 枚に等分）のコマを、書き出しと同じ描画で JPEG（長辺 640）にする。各コマの frameId・path（画像の場所。開いて見る）・元の秒を返す。背景に使う時は add-layer の content に { kind: 'video-frame', frameId } を入れる。数秒かかる。`,
    inputSchema: THUMBNAIL_TOOL_INPUT_SCHEMAS.thumbnail_frames.shape,
  }, input => respond(() => agent.frames(input, options.origin)));
  server.registerTool('thumbnail_preview', { title: '下書きで仕上がりを見る',
    description: 'ops を今の文書の写しに当てて、案を PNG（長辺 1280）にして path を返す。文書も画面も変えない。確定の前に見て、文字の読みやすさ・はみ出し・顔への重なりを直す（見直しは 2 回まで。1 つの依頼で 5 回まで）。',
    inputSchema: THUMBNAIL_TOOL_INPUT_SCHEMAS.thumbnail_preview.shape,
  }, input => respond(() => agent.preview(input, options.origin)));
  server.registerTool('thumbnail_apply', { title: '確定する（1 つの依頼で 1 回）',
    description: 'ops を 1 回の元に戻すで戻る形で適用し、保存して結果（status: saved / save-failed / conflict、pageId）を返す。baseRevision は thumbnail_read の document.revision。同じ operationId・同じ内容の再送は同じ結果を返す。応答が途切れたら thumbnail_runs で確かめ、新しい operationId で送り直さない。',
    inputSchema: THUMBNAIL_TOOL_INPUT_SCHEMAS.thumbnail_apply.shape,
  }, input => respond(() => agent.apply(input)));
  server.registerTool('thumbnail_runs', { title: '確定の結果を照会',
    description: '依頼の確定の状態（未確定・確定の途中・保存済み・保存に失敗・別の場所で変わっていた）を返す。',
    inputSchema: THUMBNAIL_TOOL_INPUT_SCHEMAS.thumbnail_runs.shape,
  }, input => respond(() => agent.runs(input)));
}
