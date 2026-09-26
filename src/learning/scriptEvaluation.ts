import { z } from 'zod';
import { resolveScriptEditPlan, type ResolvedScriptEditPlan } from '../core/scriptEditModification';
import type { EditorOperation } from '../shared/editorOperations';
import { scriptDecisionOperationId, type ScriptJudgmentExample } from './scriptDecisions';
import type { DecisionLedger } from './preferenceDecisions';
import { preferenceHash } from './preferenceEvaluation';

export const SCRIPT_EVALUATION_RUBRIC = { version: 'script-plan-v1' } as const;
const id = z.string().trim().min(1).max(256);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const caseReferenceSchema = z.object({
  judgmentId: id,
  judgmentHash: sha256,
  kind: z.enum(['caption', 'structure']),
  inputHash: sha256,
  proposalPlanHash: sha256,
  receipt: z.object({ runId: id, receiptHash: sha256 }).strict().nullable(),
}).strict();
const scriptDatasetSchema = z.object({
  schemaVersion: z.literal(1), id, version: z.number().int().positive(),
  frozenAt: z.string().datetime({ offset: true }),
  rubricVersion: z.literal(SCRIPT_EVALUATION_RUBRIC.version),
  labelSource: z.enum(['human', 'synthetic']),
  cases: z.array(caseReferenceSchema).min(1).max(10_000),
  hash: sha256,
}).strict();

export type ScriptEvaluationCaseReference = z.infer<typeof caseReferenceSchema>;
export type ScriptEvaluationDataset = z.infer<typeof scriptDatasetSchema>;
export type ScriptDecisionUnavailableReason =
  | 'NO_LEARNING_CONSENT' | 'DEFERRED' | 'SUPERSEDED' | 'WITHDRAWN'
  | 'HUMAN_LABEL_REQUIRED' | 'SYNTHETIC_NOT_ALLOWED'
  | 'SAVE_RECEIPT_REQUIRED' | 'SAVE_RECEIPT_MISMATCH';

export interface ScriptDecisionAvailability {
  judgmentId: string;
  judgmentHash: string;
  projectId: string;
  projectRevision: string;
  kind: 'caption' | 'structure';
  decision: ScriptJudgmentExample['decision'];
  labelSource: 'human' | 'synthetic';
  inputHash: string;
  proposalPlanHash: string;
  available: boolean;
  reasons: ScriptDecisionUnavailableReason[];
  receipt: { runId: string; receiptHash: string } | null;
}

export interface ResolvedScriptEvaluationCase {
  reference: ScriptEvaluationCaseReference;
  judgment: ScriptJudgmentExample;
  acceptedPlan: ResolvedScriptEditPlan | null;
  rejectedPlan: ResolvedScriptEditPlan | null;
  acceptedPlanHash: string | null;
  rejectedPlanHash: string | null;
}

export interface ResolvedScriptEvaluationDataset {
  dataset: ScriptEvaluationDataset;
  cases: ResolvedScriptEvaluationCase[];
  humanCalibrationStatus: 'human_labeled_exact_cases' | 'not_calibrated';
}

/** Caption edits are a set keyed by telop ID; structure order remains meaningful. */
export function scriptPlanHash(plan: ResolvedScriptEditPlan): string {
  return preferenceHash(plan.kind === 'caption'
    ? { ...plan, changes: [...plan.changes].sort((left, right) => left.telopId - right.telopId) }
    : plan);
}

function receiptFor(judgment: ScriptJudgmentExample, operations: readonly EditorOperation[]) {
  const operationId = scriptDecisionOperationId(judgment.id);
  const operation = operations.find(candidate => candidate.request.operationId === operationId);
  if (!operation) return { receipt: null, mismatch: false };
  const request = operation.request;
  const expectedScript = {
    judgmentId: judgment.id,
    artifact: judgment.artifact,
    ...(judgment.modification ? { modification: judgment.modification } : {}),
  };
  const exactIntent = request.projectId === judgment.projectId
    && request.operationId === operationId
    && request.changes.length === 0
    && JSON.stringify(request.script) === JSON.stringify(expectedScript);
  const saved = operation.phase === 'saved'
    && operation.confirmed.applied && operation.confirmed.saved
    && operation.result?.phase === 'saved'
    && operation.result.applied && operation.result.saved;
  if (!exactIntent || !saved) return { receipt: null, mismatch: true };
  const receipt = { runId: operation.runId, receiptHash: preferenceHash({
    runId: operation.runId,
    request: operation.request,
    result: operation.result,
    confirmed: operation.confirmed,
  }) };
  return { receipt, mismatch: false };
}

function invalidationSets(ledger: DecisionLedger, includeSynthetic: boolean) {
  const judgments = ledger.events.filter((event): event is ScriptJudgmentExample => event.type === 'script_judgment');
  const byId = new Map(judgments.map(event => [event.id, event]));
  const withdrawn = new Set(ledger.events.filter(event => event.type === 'withdrawal').map(event => event.targetId));
  const superseded = new Set<string>();
  const sourceAllowed = (event: ScriptJudgmentExample) => event.actor.kind === 'human'
    && (event.provenance.kind === 'human' || event.provenance.kind === 'imported_human'
      || (includeSynthetic && event.provenance.kind === 'synthetic'));
  for (const event of judgments.filter(sourceAllowed)) {
    let previous = event.supersedes;
    while (previous && !superseded.has(previous)) {
      superseded.add(previous);
      previous = byId.get(previous)?.supersedes;
    }
  }
  return { withdrawn, superseded };
}

export function listScriptDecisionAvailability(
  ledger: DecisionLedger,
  operations: readonly EditorOperation[],
  options: { includeSynthetic?: boolean } = {},
): ScriptDecisionAvailability[] {
  const includeSynthetic = options.includeSynthetic === true;
  const { withdrawn, superseded } = invalidationSets(ledger, includeSynthetic);
  return ledger.events.filter((event): event is ScriptJudgmentExample => event.type === 'script_judgment').map((event) => {
    const reasons: ScriptDecisionUnavailableReason[] = [];
    const human = event.actor.kind === 'human'
      && (event.provenance.kind === 'human' || event.provenance.kind === 'imported_human');
    const synthetic = event.actor.kind === 'human' && event.provenance.kind === 'synthetic';
    if (!event.learningConsent) reasons.push('NO_LEARNING_CONSENT');
    if (event.decision === 'deferred') reasons.push('DEFERRED');
    if (superseded.has(event.id)) reasons.push('SUPERSEDED');
    if (withdrawn.has(event.id)) reasons.push('WITHDRAWN');
    if (!human && !synthetic) reasons.push('HUMAN_LABEL_REQUIRED');
    if (synthetic && !includeSynthetic) reasons.push('SYNTHETIC_NOT_ALLOWED');
    let receipt: { runId: string; receiptHash: string } | null = null;
    if (event.decision === 'accepted' || event.decision === 'accepted_modified') {
      const checked = receiptFor(event, operations);
      receipt = checked.receipt;
      if (!receipt) reasons.push(checked.mismatch ? 'SAVE_RECEIPT_MISMATCH' : 'SAVE_RECEIPT_REQUIRED');
    }
    return {
      judgmentId: event.id,
      judgmentHash: preferenceHash(event),
      projectId: event.projectId,
      projectRevision: event.projectRevision,
      kind: event.artifact.proposal.kind,
      decision: event.decision,
      labelSource: synthetic ? 'synthetic' : 'human',
      inputHash: event.artifact.input.inputHash,
      proposalPlanHash: scriptPlanHash(resolveScriptEditPlan(event.artifact)),
      available: reasons.length === 0,
      reasons,
      receipt,
    };
  });
}

export function parseScriptDataset(value: unknown): ScriptEvaluationDataset {
  const parsed = scriptDatasetSchema.parse(value);
  if (new Set(parsed.cases.map(item => item.judgmentId)).size !== parsed.cases.length) {
    throw new Error('DUPLICATE_CASE: 同じ台本判断を重複して指定できません');
  }
  const { hash, ...body } = parsed;
  if (preferenceHash(body) !== hash) throw new Error('DATASET_HASH_MISMATCH: 固定後に台本評価データが変更されています');
  return parsed;
}

/** Verify only immutable ledger references. This is safe during journal replay/import
 * without an editor-operation store and does not make later withdrawals corrupt history. */
export function verifyScriptDatasetReferences(
  datasetValue: unknown,
  ledger: DecisionLedger,
): ScriptEvaluationDataset {
  const dataset = parseScriptDataset(datasetValue);
  const judgments = new Map(ledger.events.filter((event): event is ScriptJudgmentExample => event.type === 'script_judgment')
    .map(event => [event.id, event]));
  for (const reference of dataset.cases) {
    const judgment = judgments.get(reference.judgmentId);
    if (!judgment) throw new Error(`CASE_REFERENCE_MISSING: 固定した台本判断が履歴にありません: ${reference.judgmentId}`);
    const synthetic = judgment.provenance.kind === 'synthetic';
    const expectedSource = synthetic ? 'synthetic' : 'human';
    const expectsReceipt = judgment.decision === 'accepted' || judgment.decision === 'accepted_modified';
    if (dataset.labelSource !== expectedSource
      || reference.judgmentHash !== preferenceHash(judgment)
      || reference.kind !== judgment.artifact.proposal.kind
      || reference.inputHash !== judgment.artifact.input.inputHash
      || reference.proposalPlanHash !== scriptPlanHash(resolveScriptEditPlan(judgment.artifact))
      || expectsReceipt !== (reference.receipt !== null)) {
      throw new Error(`CASE_REFERENCE_MISMATCH: 固定した台本判断と履歴が一致しません: ${reference.judgmentId}`);
    }
  }
  return dataset;
}

function assertNoContradictoryLabels(cases: ResolvedScriptEvaluationCase[]): void {
  const groups = new Map<string, ResolvedScriptEvaluationCase[]>();
  for (const item of cases) {
    const targetIdentity = item.judgment.artifact.proposal.kind === 'caption'
      ? item.judgment.artifact.proposal.changes.map(change => change.telopId).sort((a, b) => a - b).join(',')
      : 'structure';
    const key = `${item.reference.kind}:${item.reference.inputHash}:${targetIdentity}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const group of groups.values()) {
    const accepted = new Set(group.flatMap(item => item.acceptedPlanHash ? [item.acceptedPlanHash] : []));
    const rejected = new Set(group.flatMap(item => item.rejectedPlanHash ? [item.rejectedPlanHash] : []));
    if (accepted.size > 1 || [...accepted].some(hash => rejected.has(hash))) {
      throw new Error('CONTRADICTORY_LABELS: 同じモデル入力に一致しない人の判断があります');
    }
  }
}

export function freezeScriptDataset(
  ledger: DecisionLedger,
  operations: readonly EditorOperation[],
  input: { id: string; version: number; frozenAt: string; caseIds: string[] },
  options: { includeSynthetic?: boolean } = {},
): ScriptEvaluationDataset {
  id.parse(input.id);
  z.number().int().positive().parse(input.version);
  z.string().datetime({ offset: true }).parse(input.frozenAt);
  if (new Set(input.caseIds).size !== input.caseIds.length) throw new Error('DUPLICATE_CASE: 同じ台本判断を重複して指定できません');
  const available = listScriptDecisionAvailability(ledger, operations, options);
  const selected = input.caseIds.map(caseId => {
    const item = available.find(candidate => candidate.judgmentId === caseId);
    if (!item || !item.available) throw new Error(`CASE_UNAVAILABLE: 評価に利用できない台本判断です: ${caseId}`);
    return item;
  });
  const sources = new Set(selected.map(item => item.labelSource));
  if (sources.size !== 1) throw new Error('LABEL_SOURCE_MIXED: 人の判断と合成fixtureを同じ評価データに混ぜられません');
  const body = {
    schemaVersion: 1 as const,
    id: input.id,
    version: input.version,
    frozenAt: input.frozenAt,
    rubricVersion: SCRIPT_EVALUATION_RUBRIC.version,
    labelSource: selected[0]!.labelSource,
    cases: selected.map(item => ({
      judgmentId: item.judgmentId,
      judgmentHash: item.judgmentHash,
      kind: item.kind,
      inputHash: item.inputHash,
      proposalPlanHash: item.proposalPlanHash,
      receipt: item.receipt,
    })),
  };
  const dataset = parseScriptDataset({ ...body, hash: preferenceHash(body) });
  resolveScriptDataset(dataset, ledger, operations, options);
  return dataset;
}

export function resolveScriptDataset(
  datasetValue: unknown,
  ledger: DecisionLedger,
  operations: readonly EditorOperation[],
  options: { includeSynthetic?: boolean } = {},
): ResolvedScriptEvaluationDataset {
  const dataset = verifyScriptDatasetReferences(datasetValue, ledger);
  if (dataset.labelSource === 'synthetic' && options.includeSynthetic !== true) {
    throw new Error('SYNTHETIC_NOT_ALLOWED: 合成fixtureは専用検証環境でだけ利用できます');
  }
  const available = listScriptDecisionAvailability(ledger, operations, options);
  const judgments = new Map(ledger.events.filter((event): event is ScriptJudgmentExample => event.type === 'script_judgment')
    .map(event => [event.id, event]));
  const cases = dataset.cases.map(reference => {
    const state = available.find(item => item.judgmentId === reference.judgmentId);
    const judgment = judgments.get(reference.judgmentId);
    if (!state || !judgment || !state.available) throw new Error(`CASE_INVALIDATED: 台本判断を現在は利用できません: ${reference.judgmentId}`);
    const expectedReference = {
      judgmentId: state.judgmentId,
      judgmentHash: state.judgmentHash,
      kind: state.kind,
      inputHash: state.inputHash,
      proposalPlanHash: state.proposalPlanHash,
      receipt: state.receipt,
    };
    if (preferenceHash(reference) !== preferenceHash(expectedReference)) {
      throw new Error(`CASE_REFERENCE_MISMATCH: 固定した台本判断と現在の記録が一致しません: ${reference.judgmentId}`);
    }
    const acceptedPlan = judgment.decision === 'accepted' || judgment.decision === 'accepted_modified'
      ? resolveScriptEditPlan(judgment.artifact, judgment.modification) : null;
    const rejectedPlan = judgment.decision === 'rejected' ? resolveScriptEditPlan(judgment.artifact) : null;
    const acceptedPlanHash = acceptedPlan ? scriptPlanHash(acceptedPlan) : null;
    const rejectedPlanHash = rejectedPlan ? scriptPlanHash(rejectedPlan) : null;
    return { reference, judgment, acceptedPlan, rejectedPlan, acceptedPlanHash, rejectedPlanHash };
  });
  assertNoContradictoryLabels(cases);
  return { dataset, cases, humanCalibrationStatus: dataset.labelSource === 'human'
    ? 'human_labeled_exact_cases' : 'not_calibrated' };
}
