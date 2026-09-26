import { z } from 'zod';
import type { DecisionLedger } from './preferenceDecisions';
import { applyPreferenceRuleText, type PreferenceRule } from './preferenceRules';
import { evaluatePreferenceRule, parseEvaluationDataset, preferenceHash, type EvaluationDataset } from './preferenceEvaluation';

export interface PreferenceModelInput {
  schemaVersion: 1 | 2;
  task: 'apply_exact_telop_rule' | 'replace_telop_fragments';
  rule: { id: string; version: number; profile: string; textEquals?: string; textIncludes?: string;
    exceptTextIncludes?: string[]; matchMode?: 'literal'; occurrences?: 'all'; replaceWith: string; excludedProjects: string[] };
  cases: { caseId: string; project: string; profile: string | null; text: string;
    sourceFrameRange: { start: number; end: number } }[];
}
export const preferenceModelOutputSchema = z.object({ schemaVersion: z.literal(1),
  predictions: z.array(z.object({ caseId: z.string().min(1).max(256), after: z.string().min(1).max(10000).nullable() }).strict()).max(10000),
}).strict();
export type PreferenceModelOutput = z.infer<typeof preferenceModelOutputSchema>;

/** A replay file is always replay, even when its metadata names a real model. No credentials enter this contract. */
export interface PreferenceModelAdapter {
  id: string;
  version: string;
  mode: 'replay' | 'live';
  provider: string;
  model: string;
  generate(input: PreferenceModelInput, options: { signal?: AbortSignal }): Promise<unknown>;
}
export interface PreferenceModelReport {
  schemaVersion: 1; id: string; startedAt: string; mode: 'replay' | 'live';
  provider: string; model: string; adapter: { id: string; version: string };
  rule: { id: string; version: number }; rulesetHash: string; datasetHash: string; rubricVersion: string;
  inputHash: string; outputHash: string | null; status: 'completed' | 'invalid_output' | 'failed' | 'cancelled';
  results: { caseId: string; actualAfter: string | null; expectedAfter: string | null; passed: boolean;
    falsePass: boolean; falseFail: boolean; unjudgedAlternative: boolean; violatesRule: boolean }[];
  aggregate: { total: number; passed: number; falsePass: number; falseFail: number; unjudged: number; ruleViolations: number };
  humanCalibrationStatus: 'human_labeled_exact_cases' | 'not_calibrated';
  failures: string[];
  // Model comparison never activates a user's rule; the explicit activation path remains separate.
  activationAuthorized: false;
}

/** Neutral aliases avoid leaking a label encoded in a project or decision's original name to the generator. */
export function buildPreferenceModelInput(rule: PreferenceRule, inputDataset: EvaluationDataset): PreferenceModelInput {
  const dataset = parseEvaluationDataset(inputDataset);
  const projectAlias = (id: string) => `project-${preferenceHash({ project: id }).slice(0, 16)}`;
  const profileAlias = (id: string) => `profile-${preferenceHash({ profile: id }).slice(0, 16)}`;
  const ruleInputHash = preferenceHash({ id: rule.id, version: rule.version, scope: rule.scope,
    conditions: rule.conditions, action: rule.action, exceptions: rule.exceptions });
  return { schemaVersion: rule.schemaVersion, task: rule.schemaVersion === 1 ? 'apply_exact_telop_rule' : 'replace_telop_fragments', rule: { id: rule.id, version: rule.version,
    profile: profileAlias(rule.scope.id), ...structuredClone(rule.conditions),
    ...(rule.schemaVersion === 2 ? {matchMode: 'literal' as const, occurrences: 'all' as const} : {}), replaceWith: rule.action.text,
    excludedProjects: rule.exceptions.projectIds.map(projectAlias) },
    cases: dataset.cases.map((c) => ({ caseId: `case-${preferenceHash({ id: c.id, dataset: dataset.hash, rule: ruleInputHash }).slice(0, 24)}`,
      project: projectAlias(c.projectId), profile: c.scope.kind === 'profile' ? profileAlias(c.scope.id) : null,
      text: c.before, sourceFrameRange: { ...c.sourceFrameRange } })) };
}

export function replayPreferenceAdapter(input: {
  id: string; version: string; provider: string; model: string; output: unknown;
}): PreferenceModelAdapter {
  return { id: input.id, version: input.version, provider: input.provider, model: input.model, mode: 'replay',
    generate: async () => structuredClone(input.output) };
}

/** Same fixed inputs, withheld human labels, strict outputs, and the same machine rubric across providers. */
export async function runPreferenceModelEvaluation(rule: PreferenceRule, ledger: DecisionLedger, dataset: EvaluationDataset,
  adapter: PreferenceModelAdapter, run: { id: string; startedAt: string; signal?: AbortSignal }): Promise<PreferenceModelReport> {
  const baseline = evaluatePreferenceRule(rule, ledger, dataset, { id: run.id, startedAt: run.startedAt });
  // Do not send withdrawn consent or training-set contamination to any provider, including replay adapters.
  const forbidden = baseline.failures.filter((f) => ['EVIDENCE_INVALIDATED', 'CASE_INVALIDATED', 'TRAIN_EVAL_PROJECT_OVERLAP', 'RULE_REVOKED'].includes(f));
  if (forbidden.length) throw new Error(`EVALUATION_INPUT_INVALID: ${forbidden.join(', ')}`);
  const input = buildPreferenceModelInput(rule, dataset);
  const report: PreferenceModelReport = { schemaVersion: 1, id: run.id, startedAt: run.startedAt, mode: adapter.mode,
    provider: adapter.provider, model: adapter.model, adapter: { id: adapter.id, version: adapter.version },
    rule: { id: rule.id, version: rule.version }, rulesetHash: baseline.rulesetHash, datasetHash: baseline.datasetHash,
    rubricVersion: baseline.rubricVersion, inputHash: preferenceHash(input), outputHash: null, status: 'completed',
    results: [], aggregate: { total: dataset.cases.length, passed: 0, falsePass: 0, falseFail: 0, unjudged: 0, ruleViolations: 0 },
    humanCalibrationStatus: baseline.humanCalibrationStatus,
    failures: baseline.failures.filter((f) => !['FALSE_PASS', 'FALSE_FAIL', 'UNJUDGED_ALTERNATIVE'].includes(f)), activationAuthorized: false };
  if (run.signal?.aborted) return { ...report, status: 'cancelled', failures: [...report.failures, 'CANCELLED'] };
  let raw: unknown;
  let onAbort: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('CANCELLED'));
      run.signal?.addEventListener('abort', onAbort, { once: true });
    });
    raw = await Promise.race([adapter.generate(structuredClone(input), { signal: run.signal }), interrupted]);
  } catch {
    const cancelled = run.signal?.aborted === true;
    return { ...report, status: cancelled ? 'cancelled' : 'failed', failures: [...report.failures, cancelled ? 'CANCELLED' : 'ADAPTER_FAILED'] };
  } finally {
    if (onAbort) run.signal?.removeEventListener('abort', onAbort);
  }
  const parsed = preferenceModelOutputSchema.safeParse(raw);
  if (!parsed.success) return { ...report, status: 'invalid_output', failures: [...report.failures, 'OUTPUT_SCHEMA_INVALID'] };
  const output = parsed.data;
  const expectedIds = new Set(input.cases.map((c) => c.caseId));
  if (output.predictions.length !== expectedIds.size || new Set(output.predictions.map((p) => p.caseId)).size !== expectedIds.size
    || output.predictions.some((p) => !expectedIds.has(p.caseId))) {
    return { ...report, outputHash: preferenceHash(output), status: 'invalid_output', failures: [...report.failures, 'OUTPUT_CASES_MISMATCH'] };
  }
  report.outputHash = preferenceHash(output);
  report.results = dataset.cases.map((c, index) => {
    const aliased = input.cases[index]!;
    const prediction = output.predictions.find((p) => p.caseId === aliased.caseId)!;
    const actualAfter = prediction.after;
    const inScope = c.scope.kind === 'profile' && c.scope.id === rule.scope.id && !rule.exceptions.projectIds.includes(c.projectId);
    const permittedAfter = inScope ? applyPreferenceRuleText(rule, c.before) : null;
    const violatesRule = actualAfter !== null && actualAfter !== permittedAfter;
    const unjudgedAlternative = c.decision === 'rejected' && actualAfter !== null && actualAfter !== c.proposedAfter;
    const passed = !violatesRule && (c.decision === 'rejected' ? actualAfter === null : actualAfter === c.actualAfter);
    return { caseId: c.id, actualAfter, expectedAfter: c.actualAfter, passed, violatesRule, unjudgedAlternative,
      falsePass: actualAfter !== null && !passed && !unjudgedAlternative, falseFail: c.actualAfter !== null && !passed };
  });
  report.aggregate = { total: report.results.length, passed: report.results.filter((r) => r.passed).length,
    falsePass: report.results.filter((r) => r.falsePass).length, falseFail: report.results.filter((r) => r.falseFail).length,
    unjudged: report.results.filter((r) => r.unjudgedAlternative).length, ruleViolations: report.results.filter((r) => r.violatesRule).length };
  if (report.aggregate.falsePass) report.failures.push('FALSE_PASS');
  if (report.aggregate.falseFail) report.failures.push('FALSE_FAIL');
  if (report.aggregate.unjudged) report.failures.push('UNJUDGED_ALTERNATIVE');
  if (report.aggregate.ruleViolations) report.failures.push('RULE_VIOLATION');
  return report;
}
