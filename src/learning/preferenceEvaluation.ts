import { createHash } from 'node:crypto';
import { z } from 'zod';
import { decisionEventSchema, eligibleDecisionExamples, type DecisionLedger, type JudgmentExample } from './preferenceDecisions';
import { applyPreferenceRuleText, preferenceRuleSchema, ruleEvidence, type PreferenceRule } from './preferenceRules';

/** Fixed before running a candidate; changing policy requires a new rubric version. */
export const PREFERENCE_RUBRIC = { version: 'exact-text-v1', minimumCases: 10, minimumHeldoutProjects: 2,
  maximumFalsePass: 0, maximumFalseFail: 0 } as const;
const identifier = z.string().trim().min(1).max(256);
const datasetSchema = z.object({
  schemaVersion: z.literal(1), id: identifier, version: z.number().int().positive(),
  frozenAt: z.string().datetime({ offset: true }), rubricVersion: z.literal(PREFERENCE_RUBRIC.version),
  cases: z.array(decisionEventSchema).min(1).max(10000), hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export interface EvaluationDataset {
  schemaVersion: 1; id: string; version: number; frozenAt: string;
  rubricVersion: typeof PREFERENCE_RUBRIC.version; cases: JudgmentExample[]; hash: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function preferenceHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function freezePreferenceDataset(ledger: DecisionLedger, input: {
  id: string; version: number; caseIds: string[]; frozenAt: string;
}): EvaluationDataset {
  if (new Set(input.caseIds).size !== input.caseIds.length) throw new Error('DUPLICATE_CASE: 同じ評価実例を重複して指定できません');
  const eligible = eligibleDecisionExamples(ledger, { includeSynthetic: true });
  const cases = input.caseIds.map((key) => {
    const example = eligible.find((e) => e.id === key);
    if (!example) throw new Error(`CASE_UNAVAILABLE: 評価に利用できない記録です: ${key}`);
    return structuredClone(example);
  });
  const body = { schemaVersion: 1 as const, id: input.id, version: input.version, frozenAt: input.frozenAt,
    rubricVersion: PREFERENCE_RUBRIC.version, cases };
  return parseEvaluationDataset({ ...body, hash: preferenceHash(body) });
}

export function parseEvaluationDataset(input: unknown): EvaluationDataset {
  const parsed = datasetSchema.parse(input);
  if (parsed.cases.some((e) => e.type !== 'judgment' || !e.learningConsent || e.decision === 'deferred')) {
    throw new Error('INVALID_CASE: 評価には同意のある採否実例が必要です');
  }
  if (new Set(parsed.cases.map((e) => e.id)).size !== parsed.cases.length) throw new Error('DUPLICATE_CASE: 評価実例が重複しています');
  const { hash, ...body } = parsed;
  if (preferenceHash(body) !== hash) throw new Error('DATASET_HASH_MISMATCH: 固定後に評価データが変更されています');
  return parsed as EvaluationDataset;
}

export interface PreferenceEvaluation {
  schemaVersion: 1; id: string; startedAt: string; mode: 'deterministic';
  rule: { id: string; version: number }; rulesetHash: string;
  datasetId: string; datasetVersion: number; datasetHash: string; rubricVersion: string;
  provider: null; model: null; adapterVersion: 'exact-text-1' | 'literal-fragment-1'; inputHash: string; outputHash: string;
  results: { caseId: string; expectedAfter: string | null; actualAfter: string | null;
    passed: boolean; falsePass: boolean; falseFail: boolean; unjudgedAlternative: boolean }[];
  aggregate: { total: number; passed: number; falsePass: number; falseFail: number };
  humanCalibrationStatus: 'human_labeled_exact_cases' | 'not_calibrated';
  failures: string[]; activationEligible: boolean;
}

/** Exact replacement evaluation, not an LLM judge and not a claim about general editorial taste. */
export function evaluatePreferenceRule(inputRule: PreferenceRule, ledger: DecisionLedger, inputDataset: EvaluationDataset,
  run: { id: string; startedAt: string }): PreferenceEvaluation {
  const rule = preferenceRuleSchema.parse(inputRule);
  const dataset = parseEvaluationDataset(inputDataset);
  identifier.parse(run.id); z.string().datetime({ offset: true }).parse(run.startedAt);
  const failures: string[] = [];
  const evidence = ruleEvidence(rule, ledger);
  if (!evidence) failures.push('EVIDENCE_INVALIDATED');
  if (rule.status === 'revoked') failures.push('RULE_REVOKED');
  const eligible = eligibleDecisionExamples(ledger, { includeSynthetic: true });
  if (dataset.cases.some((c) => !eligible.some((e) => e.id === c.id && preferenceHash(e) === preferenceHash(c)))) {
    failures.push('CASE_INVALIDATED');
  }
  const humanLabeled = dataset.cases.every((c) => c.actor.kind === 'human'
    && (c.provenance.kind === 'human' || c.provenance.kind === 'imported_human'));
  if (!humanLabeled) failures.push('HUMAN_LABELS_REQUIRED');
  if (dataset.cases.length < PREFERENCE_RUBRIC.minimumCases) failures.push('INSUFFICIENT_CASES');
  if (new Set(dataset.cases.map((c) => c.projectId)).size < PREFERENCE_RUBRIC.minimumHeldoutProjects) failures.push('INSUFFICIENT_HELDOUT_PROJECTS');
  if (dataset.cases.some((c) => evidence?.some((e) => e.projectId === c.projectId))) failures.push('TRAIN_EVAL_PROJECT_OVERLAP');
  if (!dataset.cases.some((c) => c.decision === 'rejected') || !dataset.cases.some((c) => c.actualAfter !== null)) failures.push('POSITIVE_AND_NEGATIVE_REQUIRED');
  const results = dataset.cases.map((c) => {
    const inScope = c.scope.kind === 'profile' && c.scope.id === rule.scope.id && !rule.exceptions.projectIds.includes(c.projectId);
    const actualAfter = inScope ? applyPreferenceRuleText(rule, c.before) : null;
    // Rejection is a negative for the recorded suggestion, not an invented preference for a different text.
    const expectedAfter = c.actualAfter;
    const unjudgedAlternative = c.decision === 'rejected' && actualAfter !== null && actualAfter !== c.proposedAfter;
    const passed = c.decision === 'rejected' ? actualAfter === null : actualAfter === expectedAfter;
    return { caseId: c.id, expectedAfter, actualAfter, passed,
      falsePass: actualAfter !== null && !passed && !unjudgedAlternative,
      falseFail: expectedAfter !== null && !passed, unjudgedAlternative };
  });
  const aggregate = { total: results.length, passed: results.filter((r) => r.passed).length,
    falsePass: results.filter((r) => r.falsePass).length, falseFail: results.filter((r) => r.falseFail).length };
  if (aggregate.falsePass > PREFERENCE_RUBRIC.maximumFalsePass) failures.push('FALSE_PASS');
  if (aggregate.falseFail > PREFERENCE_RUBRIC.maximumFalseFail) failures.push('FALSE_FAIL');
  if (results.some((r) => r.unjudgedAlternative)) failures.push('UNJUDGED_ALTERNATIVE');
  const rulesetHash = preferenceHash({ id: rule.id, version: rule.version, editKind: rule.editKind,
    scope: rule.scope, conditions: rule.conditions, action: rule.action, exceptions: rule.exceptions, evidenceIds: rule.evidenceIds });
  return { schemaVersion: 1, ...run, mode: 'deterministic', rule: { id: rule.id, version: rule.version }, rulesetHash,
    datasetId: dataset.id, datasetVersion: dataset.version, datasetHash: dataset.hash, rubricVersion: dataset.rubricVersion,
    provider: null, model: null, adapterVersion: rule.schemaVersion === 1 ? 'exact-text-1' : 'literal-fragment-1', inputHash: preferenceHash({ rulesetHash, datasetHash: dataset.hash }),
    outputHash: preferenceHash(results), results, aggregate,
    humanCalibrationStatus: humanLabeled ? 'human_labeled_exact_cases' : 'not_calibrated',
    failures, activationEligible: failures.length === 0 };
}

/** Recompute at activation time, so stale success cannot bypass new withdrawal, rule edits, or a changed dataset. */
export function activateEvaluatedRule(rule: PreferenceRule, ledger: DecisionLedger, dataset: EvaluationDataset,
  request: { id: string; startedAt: string; actor: { kind: 'human' | 'model'; id: string } }): {
    rule: PreferenceRule; evaluation: PreferenceEvaluation;
  } {
  if (request.actor.kind !== 'human') throw new Error('HUMAN_REQUIRED: 有効化は人が評価結果を確認して行います');
  const evaluation = evaluatePreferenceRule(rule, ledger, dataset, { id: request.id, startedAt: request.startedAt });
  if (!evaluation.activationEligible) throw new Error(`EVALUATION_FAILED: ${evaluation.failures.join(', ')}`);
  return { rule: preferenceRuleSchema.parse({ ...rule, status: 'active', activation: {
    actorId: request.actor.id, evaluationId: evaluation.id, at: request.startedAt,
    dataset: { id: dataset.id, version: dataset.version, hash: dataset.hash },
    caseDependencies: dataset.cases.map((evaluationCase) => ({
      decisionId: evaluationCase.id, operationId: evaluationCase.operationId,
    })),
  } }), evaluation };
}
