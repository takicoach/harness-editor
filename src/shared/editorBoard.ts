import { z } from 'zod';
import type { EditorOperation, PublicEditorOperation } from './editorOperations';

const id = z.string().min(1).max(256);
export const editorBoardOperationSchema = z.object({
  phase: z.enum(['queued', 'running', 'applied', 'saved', 'failed', 'cancelled', 'unknown']),
  updatedAt: z.number().int().nonnegative(), applied: z.boolean(), saved: z.boolean(), reconciled: z.boolean(),
}).strict().superRefine((operation, ctx) => {
  if ((operation.phase === 'saved') !== operation.saved) ctx.addIssue({ code: 'custom', message: '保存状態が一致しません' });
  if (operation.saved && !operation.applied) ctx.addIssue({ code: 'custom', message: '保存済みは適用済みでもあります' });
  if (operation.phase === 'applied' && !operation.applied) ctx.addIssue({ code: 'custom', message: '適用状態が一致しません' });
  if (operation.reconciled && operation.phase !== 'unknown') ctx.addIssue({ code: 'custom', message: '結果確認はunknownだけに付きます' });
});
export const editorProjectBoardItemSchema = z.object({
  projectId: id,
  editor: z.object({ connected: z.boolean(), ready: z.boolean(), dirty: z.boolean(),
    failed: z.boolean().optional().default(false) }).strict(),
  operation: editorBoardOperationSchema.nullable(),
  humanReview: z.enum(['pending', 'partial', 'reviewed', 'unavailable']).nullable().default(null),
}).strict().superRefine((item, ctx) => {
  if (item.editor.ready && !item.editor.connected) ctx.addIssue({ code: 'custom', message: 'readyな編集画面は接続中である必要があります' });
  if (item.editor.dirty && !item.editor.ready) ctx.addIssue({ code: 'custom', message: '未保存状態はreadyな編集画面だけが持ちます' });
  if (item.editor.failed && !item.editor.connected) ctx.addIssue({ code: 'custom', message: '読込失敗は接続中の編集画面だけが持ちます' });
});
export const editorProjectBoardPageSchema = z.object({
  schemaVersion: z.literal(1), items: z.array(editorProjectBoardItemSchema).max(100),
  total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
}).strict();
export type EditorBoardOperation = z.infer<typeof editorBoardOperationSchema>;
export type EditorProjectBoardItem = z.infer<typeof editorProjectBoardItemSchema>;
export type EditorProjectBoardPage = z.infer<typeof editorProjectBoardPageSchema>;
export type EditorBoardHumanReview = EditorProjectBoardItem['humanReview'];

const unresolved = (operation: EditorOperation): boolean => ['queued', 'running', 'applied'].includes(operation.phase)
  || (operation.phase === 'unknown' && operation.reconciliation === undefined);
const newest = (a: EditorOperation, b: EditorOperation): number => b.updatedAt - a.updatedAt || b.runId.localeCompare(a.runId);

/** 未解決の確認事項を完了履歴で隠さず、同じ区分では最新の観測を選ぶ。 */
export function selectEditorBoardOperation(operations: EditorOperation[]): EditorOperation | null {
  return operations.filter(unresolved).sort(newest)[0] ?? operations.slice().sort(newest)[0] ?? null;
}

/** カードへ必要な事実だけを射影し、本文・担当・revision・実行IDを公開しない。 */
export function editorBoardOperation(operation: EditorOperation): EditorBoardOperation {
  return { phase: operation.phase, updatedAt: operation.updatedAt,
    applied: operation.confirmed.applied, saved: operation.confirmed.saved, reconciled: operation.reconciliation !== undefined };
}

/**
 * 代表runとは別に、案件内で一度でも適用された全runの人確認を集約する。
 * 採用/却下やsynthetic除外はEditorAgentContext.reviewの既存projectionを正とする。
 */
export function editorBoardHumanReview(
  operations: Pick<PublicEditorOperation, 'confirmed' | 'humanReview'>[],
): EditorBoardHumanReview {
  const applied = operations.filter((operation) => operation.confirmed.applied);
  if (applied.length === 0) return null;
  if (applied.some((operation) => operation.humanReview === 'unavailable')) return 'unavailable';
  if (applied.every((operation) => operation.humanReview === 'reviewed')) return 'reviewed';
  if (applied.every((operation) => operation.humanReview === 'pending')) return 'pending';
  return 'partial';
}
