import { z } from 'zod';
import { validateScriptEditArtifact } from '../core/scriptEditArtifact';
import {
  scriptEditModificationSchema,
  validateScriptEditModification,
} from '../core/scriptEditModification';

const id = z.string().trim().min(1).max(256);
const scriptJudgmentObjectSchema = z.object({
  schemaVersion: z.literal(1), type: z.literal('script_judgment'),
  id, operationId: id, createdAt: z.string().datetime({ offset: true }),
  actor: z.object({ kind: z.enum(['human', 'model']), id }).strict(),
  projectId: id, projectRevision: id,
  artifact: z.unknown().transform((value, ctx) => {
    try { return validateScriptEditArtifact(value); }
    catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: '台本変更案の構造が不正です' }); return z.NEVER; }
  }),
  decision: z.enum(['accepted', 'accepted_modified', 'rejected', 'deferred']),
  modification: scriptEditModificationSchema.optional(),
  reasonCode: z.enum(['unspecified', 'wording', 'meaning', 'timing', 'take_selection', 'structure', 'readability', 'one_off', 'other']),
  note: z.string().max(4000), learningConsent: z.boolean(),
  // Persist the original delivery identity with the human decision. This is
  // intent, never evidence that the editor applied or saved the proposal.
  application: z.object({ sessionId: id, baseRevision: id }).strict().optional(),
  scope: z.object({ kind: z.enum(['project', 'profile']), id }).strict(),
  provenance: z.object({ kind: z.enum(['human', 'imported_human', 'synthetic', 'model']) }).strict(),
  supersedes: id.optional(),
}).strict();

export const scriptJudgmentSchema = scriptJudgmentObjectSchema.superRefine((event, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (event.decision === 'accepted_modified') {
    if (event.modification === undefined) {
      fail('SCRIPT_MODIFICATION_REQUIRED: 修正採用には人が直した内容が必要です');
      return;
    }
    try { validateScriptEditModification(event.artifact, event.modification); }
    catch (error) { fail(error instanceof Error ? error.message : 'INVALID_SCRIPT_MODIFICATION: 修正内容が不正です'); }
  } else if (event.modification !== undefined) {
    fail('SCRIPT_MODIFICATION_NOT_ALLOWED: 修正内容は「直して採用」の判断だけに保存できます');
  }
});

export type ScriptJudgmentExample = z.infer<typeof scriptJudgmentSchema>;

/** Stable operation identity for one human decision. A retry never creates a second edit. */
export function scriptDecisionOperationId(judgmentId: string): string { return `script:${judgmentId}`; }

export function validateScriptJudgment(event: ScriptJudgmentExample): void {
  if (event.actor.kind !== 'human') throw new Error('HUMAN_REQUIRED: 台本案の採否は人が確認します');
  if (event.projectId !== event.artifact.input.alignment.packet.projectId
    || event.projectRevision !== event.artifact.input.alignment.packet.editRevision) {
    throw new Error('SCRIPT_JUDGMENT_TARGET: 判断と変更案の案件・内容版が一致しません');
  }
  if (event.scope.kind === 'project' && event.scope.id !== event.projectId) throw new Error('SCRIPT_JUDGMENT_SCOPE: 当該案件を指定してください');
  if (event.provenance.kind === 'model') throw new Error('HUMAN_REQUIRED: モデル出力を人の採否として記録できません');
  if (event.reasonCode === 'other' && !event.note.trim()) throw new Error('SCRIPT_JUDGMENT_REASON: その他の理由には説明が必要です');
  if (event.decision === 'accepted_modified') {
    if (event.modification === undefined) throw new Error('SCRIPT_MODIFICATION_REQUIRED: 修正採用には人が直した内容が必要です');
    validateScriptEditModification(event.artifact, event.modification);
  } else if (event.modification !== undefined) {
    throw new Error('SCRIPT_MODIFICATION_NOT_ALLOWED: 修正内容は「直して採用」の判断だけに保存できます');
  }
}
