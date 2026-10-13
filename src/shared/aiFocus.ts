/**
 * AI タブの土台: 画面の状況（どの案件の、どのモードを見ているか）の型。
 * 画面（ブラウザのページ 1 枚＝pageId）が 2 秒ごとにサーバへ送り、AI は editor_context で読む。
 */
import { z } from 'zod';
import type { AiToolId } from './aiToolId';

export const AI_MODES = ['video', 'slides', 'thumbnail'] as const;
export type AiMode = (typeof AI_MODES)[number];
export const AI_MODE_LABEL: Readonly<Record<AiMode, string>> = { video: '動画', slides: 'スライド', thumbnail: 'サムネ' };

const id = z.string().min(1).max(256);
const revision = z.number().int().nonnegative();
/** 書き込み先の照合情報。動画は編集画面の sessionId（editor_read に渡す）、スライド・サムネは文書 ID・セッション・版。 */
export const aiScreenTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('video'), editorSessionId: id }).strict(),
  z.object({ kind: z.literal('slides'), documentId: id, sessionId: id, revision }).strict(),
  z.object({ kind: z.literal('thumbnail'), documentId: id, sessionId: id, revision, pageId: id.nullable() }).strict(),
]);
export type AiScreenTarget = z.infer<typeof aiScreenTargetSchema>;
export const aiScreenSchema = z.object({
  projectId: id,
  projectName: z.string().min(1).max(200),
  mode: z.enum(AI_MODES),
  target: aiScreenTargetSchema.nullable(),
  playheadSec: z.number().nonnegative().max(1_000_000).nullable(),
  selection: z.array(id).max(50),
  materials: z.string().max(400),
}).strict();
export type AiScreen = z.infer<typeof aiScreenSchema>;
/** 画面の定期報告。seq はページの中の連番で、サーバは古い番号を捨てる。screen が null はホーム（案件を開いていない）。 */
export const aiFocusBeatSchema = z.object({ pageId: z.string().min(8).max(128), seq: z.number().int().nonnegative(), screen: aiScreenSchema.nullable() }).strict();
export type AiFocusBeat = z.infer<typeof aiFocusBeatSchema>;

export interface AiRequestPoint { projectId: string; projectName: string; mode: AiMode; at: number }
export interface AiContextRead { projectId: string | null; projectName: string | null; mode: AiMode | null; at: number }
export interface AiFocusPrimary { pageId: string; screen: AiScreen | null; updatedAt: number }
export interface AiFocusView { primary: AiFocusPrimary | null; request: AiRequestPoint | null; lastRead: AiContextRead | null }
/** /api/ai/presence の応答。connected は「端末が起動していて、その起動のあとに AI タブの MCP 接続が来た」。 */
export interface AiPresence { terminal: 'idle' | 'running' | 'exited'; tool: AiToolId | null; mcp: boolean; connected: boolean; focus: AiFocusView }

/** 書き込みを断ったときに AI へ返す次の手。 */
export const TARGET_CONFIRM_RECOVERY =
  'editor_context で今の画面と依頼した時点の案件を確かめ、どちらの案件を直すか利用者に確かめてください。利用者が AI タブで改めて依頼（Enter）すると、その時点の案件に書き込めます。';

/** 「講義（サムネ）」の形。案件が無ければ「ホーム」。 */
export function aiScreenLabel(screen: { projectName: string | null; mode: AiMode | null } | null): string {
  if (!screen || screen.projectName === null || screen.mode === null) return 'ホーム';
  return `${screen.projectName}（${AI_MODE_LABEL[screen.mode]}）`;
}

/** AI のログイン状態（/api/ai/login）。unknown は確かめられない（その時は起動を止めない）。 */
export type AiLoginState = 'ok' | 'missing' | 'unknown';
