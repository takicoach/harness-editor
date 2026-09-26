import { z } from 'zod';
import type { ScriptEditArtifact } from '../../core/scriptEditArtifact';
import type { DecisionLedger } from '../../learning/preferenceDecisions';
import { scriptDecisionOperationId, type ScriptJudgmentExample } from '../../learning/scriptDecisions';
import { editorChangeSetSchema, type EditorChangeSet } from '../../shared/editorCommands';
import { editorOperationPhaseSchema, editorOperationResultSchema } from '../../shared/editorOperations';

export function latestScriptJudgment(ledger: DecisionLedger, artifact: ScriptEditArtifact): ScriptJudgmentExample | null {
  const content = JSON.stringify(artifact);
  // Withdrawing learning consent does not withdraw approval of an edit.
  const invalid = new Set(ledger.events.flatMap(e => e.type !== 'withdrawal' && e.supersedes ? [e.supersedes] : []));
  return [...ledger.events].reverse().find((e): e is ScriptJudgmentExample => e.type === 'script_judgment'
    && !invalid.has(e.id) && e.projectId === artifact.input.alignment.packet.projectId
    && e.artifact.proposal.proposalId === artifact.proposal.proposalId
    && e.artifact.input.inputHash === artifact.input.inputHash && JSON.stringify(e.artifact) === content) ?? null;
}

export function scriptApplicationRequest(judgment: ScriptJudgmentExample, baseRevision = judgment.application?.baseRevision): EditorChangeSet {
  if (!isScriptAdoptionDecision(judgment.decision) || !judgment.application) throw new Error('この判断には編集の依頼が記録されていません');
  return editorChangeSetSchema.parse({ schemaVersion: 1, projectId: judgment.projectId,
    operationId: scriptDecisionOperationId(judgment.id), baseRevision,
    script: { judgmentId: judgment.id, artifact: judgment.artifact, ...(judgment.modification ? { modification: judgment.modification } : {}) }, changes: [] });
}

export function isScriptAdoptionDecision(decision: string | undefined): boolean {
  return decision === 'accepted' || decision === 'accepted_modified';
}

const receiptSchema = z.object({
  runId: z.string().min(1), request: editorChangeSetSchema, phase: editorOperationPhaseSchema,
  confirmed: z.object({ applied: z.boolean(), saved: z.boolean() }),
  result: editorOperationResultSchema.nullable(),
});
export type ScriptApplicationReceipt = z.infer<typeof receiptSchema>;

/** A successful HTTP response is insufficient: bind the receipt to the exact intent. */
export function readScriptApplicationReceipt(value: unknown, judgment: ScriptJudgmentExample): ScriptApplicationReceipt {
  const receipt = receiptSchema.parse(value);
  // A reload can rebind an as-yet-undelivered intent to a fresh browser revision.
  // The operation ID and every content-bearing field must still match exactly.
  if (JSON.stringify(receipt.request) !== JSON.stringify(scriptApplicationRequest(judgment, receipt.request.baseRevision))) throw new Error('編集結果が依頼した変更案と一致しません');
  if (receipt.phase === 'saved' && (!receipt.confirmed.saved || !receipt.confirmed.applied || receipt.result?.phase !== 'saved'
    || !receipt.result.saved || !receipt.result.applied)) throw new Error('保存完了を確認できません');
  return receipt;
}
