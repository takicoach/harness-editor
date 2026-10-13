/**
 * AI タブの土台: 利用者が今見ている画面（主画面）と、依頼した時点の画面を AI に渡す道具。
 * AI は依頼のたびに最初に editor_context を呼ぶ（説明書に書く）。主画面が無い時は推測で案件を決めさせない。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AI_MODES, aiScreenLabel, type AiMode, type AiRequestPoint, type AiScreen } from '../../shared/aiFocus';
import { editorGuide } from '../../shared/agentPrompts';
import type { EditorSessionSummary } from '../../shared/editorSessions';
import type { AiFocusRegistry } from '../aiFocus';
import { THUMBNAIL_TOOLS } from '../thumbnail/mcpTools';

const VIDEO_TOOLS = ['editor_read', 'editor_validate', 'editor_apply', 'editor_runs', 'editor_cancel', 'editor_import_media', 'editor_import_runs', 'editor_import_cancel'] as const;
/** モードごとに使う道具。 */
export const MODE_TOOLS: Readonly<Record<AiMode, readonly string[]>> = {
  video: VIDEO_TOOLS,
  slides: ['slides_read', 'slides_validate', 'slides_apply_outline', 'slides_apply_pages', 'slides_runs', 'slides_cancel'],
  thumbnail: THUMBNAIL_TOOLS,
};
export const COMMON_TOOLS: readonly string[] = ['editor_context', 'editor_guide', 'report_instruction_status'];
export interface ContextToolDeps { focus: AiFocusRegistry; sessions?: () => EditorSessionSummary[] }
export interface EditorContextResult {
  screen: (AiScreen & { label: string; editorSession: EditorSessionSummary | null }) | null;
  request: (AiRequestPoint & { label: string }) | null;
  switchedSinceRequest: boolean;
  modeChangedSinceRequest: boolean;
  tools: string[];
  next: string;
}

export function editorContext(deps: ContextToolDeps): EditorContextResult {
  const primary = deps.focus.primary();
  deps.focus.noteContextRead();
  const screen = primary?.screen ?? null, request = deps.focus.request();
  const switched = !!(screen && request && request.projectId !== screen.projectId);
  const modeChanged = !!(screen && request && !switched && request.mode !== screen.mode);
  const target = screen?.target;
  const editorSession = target?.kind === 'video' ? deps.sessions?.().find(item => item.sessionId === target.editorSessionId) ?? null : null;
  const label = aiScreenLabel(screen), requestLabel = request ? aiScreenLabel(request) : '';
  const next = !primary ? '主画面がありません（AI タブを開いている画面が閉じられたか、まだありません）。利用者に、直したい案件を開いて AI タブを開いてもらってください。推測で案件を決めないでください。'
    : !screen ? '利用者はホームにいます。どの案件を直すか聞き、その案件を開いてもらってください。推測で案件を決めないでください。'
    : switched ? `依頼した時は「${requestLabel}」でしたが、今は「${label}」を開いています。どちらを直すか利用者に確かめてください。`
    : !request ? `利用者は「${label}」を見ています。まだ依頼はありません。依頼を待ってください。`
    : modeChanged ? `依頼した後、同じ案件の中で画面が「${label}」に変わりました。依頼どおり「${requestLabel}」の作業を続けてかまいません。`
    : `「${label}」への依頼です。tools の道具で進めてください（手順は editor_guide）。`;
  return {
    screen: screen ? { ...screen, label, editorSession } : null,
    request: request ? { ...request, label: requestLabel } : null,
    switchedSinceRequest: switched, modeChangedSinceRequest: modeChanged,
    tools: [...(screen ? MODE_TOOLS[screen.mode] : []), ...COMMON_TOOLS], next,
  };
}

export function registerContextTools(server: McpServer, deps: ContextToolDeps): void {
  server.registerTool('editor_context', { title: '利用者が今見ている画面と、依頼した時点の画面を知る',
    description: '依頼を受けたら最初に呼ぶ。主画面（AI タブを開いている画面）の案件 ID・名前・モード（video/slides/thumbnail）・書き込み先の照合情報（target）・再生位置・選択・素材の要約・使える道具と、利用者が依頼（Enter）した時点の案件とモードを返す。switchedSinceRequest が true なら、どちらの案件か利用者に確かめる。screen が null なら推測で案件を決めない。',
    inputSchema: {},
  }, () => ({ content: [{ type: 'text' as const, text: JSON.stringify(editorContext(deps)) }] }));
  server.registerTool('editor_guide', { title: 'モード別の手順を読む',
    description: 'mode（video・slides・thumbnail）の詳しい手順を返す。editor_context の screen.mode（依頼した時点と違えば request.mode）を渡す。',
    inputSchema: { mode: z.enum(AI_MODES) },
  }, ({ mode }) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ mode, guide: editorGuide(mode) }) }] }));
}
