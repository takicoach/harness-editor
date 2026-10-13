/** サムネの AI の、サーバと画面が共有する型と決め方。 */
import { z } from 'zod';
import type { Rational } from '../core/sequence/time';
import type { InstructionStatus } from './types';

export const THUMBNAIL_AI_KINDS = ['new', 'edit'] as const;
export type ThumbnailAiKind = (typeof THUMBNAIL_AI_KINDS)[number];
export const THUMBNAIL_AI_CUTOUTS = ['auto', 'yes', 'no'] as const;
export type ThumbnailAiCutout = (typeof THUMBNAIL_AI_CUTOUTS)[number];
export const THUMBNAIL_AI_CUTOUT_LABEL: Readonly<Record<ThumbnailAiCutout, string>> = { auto: 'AI に任せる', yes: 'あり', no: 'なし' };
/** 作業中の細かい段階。サーバが道具の呼び出しから付ける（researching は計画 3 の thumbnail_research が付ける）。 */
export type ThumbnailAiPhase = 'working' | 'researching' | 'reviewing';
/** AI の操作の上限。既存の 1 要求 50 操作から、サーバが足す操作（素材の登録・案の削除・追加・メイン）の 4 を引いた数。 */
export const THUMBNAIL_AI_MAX_OPS = 46;
export const THUMBNAIL_AI_MAX_FRAMES_PER_CALL = 12;
/** 1 つの依頼で残すコマの記録の数（古い順に捨てる）。 */
export const THUMBNAIL_AI_MAX_FRAME_REFS = 60;
/** 1 つの依頼の下書きの回数（手順は見直し 2 回まで。サーバは余裕を持たせて止める）。 */
export const THUMBNAIL_AI_MAX_PREVIEWS = 5;

export interface ThumbnailAiFrameRef { frameId: string; assetId: string; streamIndex: number; fingerprint: string; sourceTime: Rational; file: string }
export interface ThumbnailAiApply {
  operationId: string; requestHash: string; status: 'applying' | 'saved' | 'save-failed' | 'conflict'; pageId: string;
  appliedRevision: number | null; savedRevision: number | null; message: string | null; evacuatedFile: string | null; at: string;
}
/** サムネの依頼の記録。書き込みの範囲はここに固定し、端末で答えても動かない。 */
export interface ThumbnailAiRequest {
  /** ボタンの依頼は受け箱の ID（inst-14）、端末から直接の依頼は d- で始まる。 */
  requestId: string; route: 'button' | 'direct'; projectId: string; documentId: string; kind: ThumbnailAiKind;
  /** 直す: 対象の案。新しい案: 入れ替える案（無ければ null）。 */
  targetPageId: string | null; targetPageName: string | null;
  /** targetPageId の中身の指紋（依頼の時点）。人がその案を変えたら確定を断る。 */
  targetFingerprint: string | null;
  cutout: ThumbnailAiCutout; note: string; phase: ThumbnailAiPhase;
  frames: ThumbnailAiFrameRef[]; nextFrame: number; previews: number; apply: ThumbnailAiApply | null; createdAt: string; updatedAt: string;
}
export type ThumbnailAiStatus = 'pending' | 'working' | 'researching' | 'reviewing' | 'done' | 'failed';
export const THUMBNAIL_AI_STATUS_LABEL: Readonly<Record<ThumbnailAiStatus, string>> = {
  pending: '送信待ち（AI タブで Enter）', working: '作業中', researching: '競合を調べています', reviewing: '仕上がりを確認中', done: '完了', failed: '失敗',
};
/** 画面に出す状態。確定の結果を最優先し、次に受け箱（ボタンの依頼だけ）、最後に作業の段階。 */
export function thumbnailAiStatus(request: ThumbnailAiRequest, inbox: { status: InstructionStatus; reply: string | null } | null): { status: ThumbnailAiStatus; message: string | null } {
  const apply = request.apply;
  if (apply?.status === 'saved') return { status: 'done', message: inbox?.reply ?? null };
  if (apply?.status === 'save-failed' || apply?.status === 'conflict') return { status: 'failed', message: apply.message };
  if (inbox?.status === 'failed') return { status: 'failed', message: inbox.reply };
  if (inbox?.status === 'done') return { status: 'done', message: inbox.reply };
  if (inbox?.status === 'pending') return { status: 'pending', message: null };
  return { status: request.phase, message: null };
}
export function isFinalThumbnailAiStatus(status: ThumbnailAiStatus): boolean { return status === 'done' || status === 'failed'; }
/** AI タブの入力欄に貼る依頼文（受け箱が末尾に「（依頼 #番号）」を足す）。 */
export function thumbnailAiRequestText(input: { kind: ThumbnailAiKind; targetName: string | null; cutout: ThumbnailAiCutout; note: string }): string {
  const what = input.kind === 'new' ? '新しい案を作って' : `${input.targetName ?? '選んでいる案'} を直して`;
  const details = [input.kind === 'new' && input.targetName ? `${input.targetName} と入れ替え` : null, `切り抜き: ${THUMBNAIL_AI_CUTOUT_LABEL[input.cutout]}`].filter(Boolean).join('・');
  return `サムネ: ${what}（${details}）${input.note.replace(/\s+/g, ' ').trim()}`;
}
/** 画面のボタンの入力。pageId は 直す: 選んでいる案、新しい案: 入れ替える案（案が 3 つの時だけ。それ以外は null）。 */
export const thumbnailAiButtonSchema = z.object({
  projectId: z.string().min(1).max(256), kind: z.enum(THUMBNAIL_AI_KINDS), pageId: z.string().min(1).max(256).nullable(),
  cutout: z.enum(THUMBNAIL_AI_CUTOUTS), note: z.string().max(100),
  requestId: z.string().regex(/^[a-zA-Z0-9-]{16,128}$/), requestCreatedAt: z.number().int().nonnegative(),
}).strict();
export type ThumbnailAiButtonInput = z.infer<typeof thumbnailAiButtonSchema>;
/** 画面が照会で受け取る形。 */
export interface ThumbnailAiLatest { request: ThumbnailAiRequest | null; status: ThumbnailAiStatus | null; label: string | null; message: string | null }
