import { z } from 'zod';
import {
  resolveScriptEditCandidatePlan,
  scriptEditCandidatePlanSchema,
  type ResolvedScriptEditPlan,
  type ScriptEditCandidatePlan,
} from '../core/scriptEditModification';
import type { ScriptEditInput } from '../core/scriptEditProposal';
import type { EditorOperation } from '../shared/editorOperations';
import type { DecisionLedger } from './preferenceDecisions';
import { preferenceHash } from './preferenceEvaluation';
import {
  resolveScriptDataset,
  scriptPlanHash,
  type ResolvedScriptEvaluationCase,
  type ScriptEvaluationDataset,
} from './scriptEvaluation';

const id = z.string().trim().min(1).max(256);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const scriptModelGeneratorSchema = z.object({
  provider: id,
  model: id,
  promptVersion: id,
  configHash: sha256,
}).strict();
export type ScriptModelGenerator = z.infer<typeof scriptModelGeneratorSchema>;

export const scriptModelOutputSchema = z.object({
  schemaVersion: z.literal(1),
  inputHash: sha256,
  generator: scriptModelGeneratorSchema,
  predictions: z.array(z.object({
    caseId: id,
    plan: scriptEditCandidatePlanSchema.nullable(),
  }).strict()).max(10_000),
}).strict();
export type ScriptModelOutput = z.infer<typeof scriptModelOutputSchema>;

type ScriptModelCaseTarget = {
  kind: 'caption';
  changes: Array<{ telopId: number; before: string }>;
} | {
  kind: 'structure';
  totalFrames: number;
};

export interface ScriptModelInput {
  schemaVersion: 1;
  task: 'propose_script_plan';
  cases: Array<{
    caseId: string;
    kind: 'caption' | 'structure';
    input: ScriptEditInput;
    target: ScriptModelCaseTarget;
  }>;
}

export interface PreparedScriptModelInput {
  schemaVersion: 1;
  dataset: { id: string; version: number; hash: string };
  input: ScriptModelInput;
  inputHash: string;
  rubricVersion: string;
  humanCalibrationStatus: 'human_labeled_exact_cases' | 'not_calibrated';
}

export type ScriptModelClassification = 'known_accepted' | 'known_rejected' | 'unjudged' | 'invalid';
export interface ScriptModelCaseResult {
  caseId: string;
  kind: 'caption' | 'structure';
  classification: ScriptModelClassification;
  candidatePlan: ResolvedScriptEditPlan | null;
  candidatePlanHash: string | null;
  referencePlan: ResolvedScriptEditPlan;
  referenceDecision: 'accepted' | 'accepted_modified' | 'rejected';
  error: string | null;
}
export interface ScriptModelReport {
  schemaVersion: 1;
  mode: 'replay';
  generator: ScriptModelGenerator | null;
  inputHash: string;
  datasetHash: string;
  rubricVersion: string;
  humanCalibrationStatus: 'human_labeled_exact_cases' | 'not_calibrated';
  outputHash: string;
  status: 'completed' | 'invalid_output';
  failures: string[];
  results: ScriptModelCaseResult[];
  aggregate: ScriptModelCounts & { byKind: { caption: ScriptModelCounts; structure: ScriptModelCounts } };
  activationAuthorized: false;
}
export interface ScriptModelCounts {
  total: number;
  knownAccepted: number;
  knownRejected: number;
  unjudged: number;
  invalid: number;
}

function neutralCaseId(inputHash: string, target: ScriptModelCaseTarget, index: number): string {
  return `case-${preferenceHash({ inputHash, target, index }).slice(0, 24)}`;
}

export function prepareScriptModelInput(
  dataset: ScriptEvaluationDataset,
  ledger: DecisionLedger,
  operations: readonly EditorOperation[],
  options: { includeSynthetic?: boolean } = {},
): PreparedScriptModelInput {
  const resolved = resolveScriptDataset(dataset, ledger, operations, options);
  const input: ScriptModelInput = {
    schemaVersion: 1,
    task: 'propose_script_plan',
    cases: resolved.cases.map((item, index) => {
      const artifact = item.judgment.artifact;
      const target: ScriptModelCaseTarget = artifact.proposal.kind === 'caption'
        ? { kind: 'caption', changes: artifact.proposal.changes.map(change => ({ telopId: change.telopId, before: change.before }))
          .sort((left, right) => left.telopId - right.telopId) }
        : { kind: 'structure', totalFrames: artifact.input.editing.totalFrames };
      return {
        caseId: neutralCaseId(artifact.input.inputHash, target, index),
        kind: artifact.proposal.kind,
        input: structuredClone(artifact.input),
        target,
      };
    }),
  };
  return {
    schemaVersion: 1,
    dataset: { id: resolved.dataset.id, version: resolved.dataset.version, hash: resolved.dataset.hash },
    input,
    inputHash: preferenceHash(input),
    rubricVersion: resolved.dataset.rubricVersion,
    humanCalibrationStatus: resolved.humanCalibrationStatus,
  };
}

function counts(results: ScriptModelCaseResult[]): ScriptModelCounts {
  return {
    total: results.length,
    knownAccepted: results.filter(result => result.classification === 'known_accepted').length,
    knownRejected: results.filter(result => result.classification === 'known_rejected').length,
    unjudged: results.filter(result => result.classification === 'unjudged').length,
    invalid: results.filter(result => result.classification === 'invalid').length,
  };
}
function aggregate(results: ScriptModelCaseResult[]): ScriptModelReport['aggregate'] {
  return { ...counts(results), byKind: {
    caption: counts(results.filter(result => result.kind === 'caption')),
    structure: counts(results.filter(result => result.kind === 'structure')),
  } };
}

function referenceOf(item: ResolvedScriptEvaluationCase) {
  const referencePlan = item.acceptedPlan ?? item.rejectedPlan;
  if (!referencePlan || item.judgment.decision === 'deferred') throw new Error('INVALID_CASE: 評価できる人の判断がありません');
  return { referencePlan, referenceDecision: item.judgment.decision } as {
    referencePlan: ResolvedScriptEditPlan;
    referenceDecision: 'accepted' | 'accepted_modified' | 'rejected';
  };
}

function invalidResults(prepared: PreparedScriptModelInput, resolvedCases: ResolvedScriptEvaluationCase[], error: string): ScriptModelCaseResult[] {
  return prepared.input.cases.map((item, index) => ({
    caseId: item.caseId,
    kind: item.kind,
    classification: 'invalid',
    candidatePlan: null,
    candidatePlanHash: null,
    ...referenceOf(resolvedCases[index]!),
    error,
  }));
}

function evaluateOneOutput(
  prepared: PreparedScriptModelInput,
  resolvedCases: ResolvedScriptEvaluationCase[],
  raw: unknown,
): ScriptModelReport {
  const outputHash = preferenceHash(raw === undefined ? null : raw);
  const base = {
    schemaVersion: 1 as const,
    mode: 'replay' as const,
    inputHash: prepared.inputHash,
    datasetHash: prepared.dataset.hash,
    rubricVersion: prepared.rubricVersion,
    humanCalibrationStatus: prepared.humanCalibrationStatus,
    outputHash,
    activationAuthorized: false as const,
  };
  const parsed = scriptModelOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const results = invalidResults(prepared, resolvedCases, 'OUTPUT_SCHEMA_INVALID');
    return { ...base, generator: null, status: 'invalid_output', failures: ['OUTPUT_SCHEMA_INVALID'], results, aggregate: aggregate(results) };
  }
  const output = parsed.data;
  if (output.inputHash !== prepared.inputHash) {
    const results = invalidResults(prepared, resolvedCases, 'OUTPUT_INPUT_MISMATCH');
    return { ...base, generator: output.generator, status: 'invalid_output', failures: ['OUTPUT_INPUT_MISMATCH'], results, aggregate: aggregate(results) };
  }
  const expectedIds = new Set(prepared.input.cases.map(item => item.caseId));
  const actualIds = output.predictions.map(item => item.caseId);
  if (actualIds.length !== expectedIds.size || new Set(actualIds).size !== actualIds.length
    || actualIds.some(caseId => !expectedIds.has(caseId))) {
    const results = invalidResults(prepared, resolvedCases, 'OUTPUT_CASES_MISMATCH');
    return { ...base, generator: output.generator, status: 'invalid_output', failures: ['OUTPUT_CASES_MISMATCH'], results, aggregate: aggregate(results) };
  }
  const byId = new Map(output.predictions.map(prediction => [prediction.caseId, prediction]));
  const results = prepared.input.cases.map((inputCase, index): ScriptModelCaseResult => {
    const prediction = byId.get(inputCase.caseId)!;
    const resolved = resolvedCases[index]!;
    const reference = referenceOf(resolved);
    if (prediction.plan === null) return { caseId: inputCase.caseId, kind: inputCase.kind,
      classification: 'unjudged', candidatePlan: null, candidatePlanHash: null, ...reference, error: null };
    try {
      const candidate = resolveScriptEditCandidatePlan(resolved.judgment.artifact, prediction.plan as ScriptEditCandidatePlan);
      const candidatePlanHash = scriptPlanHash(candidate);
      const classification = candidatePlanHash === resolved.acceptedPlanHash ? 'known_accepted'
        : candidatePlanHash === resolved.rejectedPlanHash ? 'known_rejected' : 'unjudged';
      return { caseId: inputCase.caseId, kind: inputCase.kind, classification,
        candidatePlan: candidate, candidatePlanHash, ...reference, error: null };
    } catch (error) {
      return { caseId: inputCase.caseId, kind: inputCase.kind, classification: 'invalid',
        candidatePlan: null, candidatePlanHash: null, ...reference,
        error: error instanceof Error ? error.message : 'INVALID_PLAN' };
    }
  });
  const totals = aggregate(results);
  return { ...base, generator: output.generator, status: 'completed',
    failures: totals.invalid > 0 ? ['INVALID_PLAN'] : [], results, aggregate: totals };
}

export async function compareScriptModelOutputs(
  dataset: ScriptEvaluationDataset,
  ledger: DecisionLedger,
  operations: readonly EditorOperation[],
  request: { inputHash: string; outputs: Array<{ label: string; output: unknown }> },
  options: { includeSynthetic?: boolean } = {},
) {
  const resolved = resolveScriptDataset(dataset, ledger, operations, options);
  const prepared = prepareScriptModelInput(dataset, ledger, operations, options);
  if (request.inputHash !== prepared.inputHash) throw new Error('MODEL_INPUT_MISMATCH: 固定したモデル入力と一致しません');
  if (request.outputs.length !== 2 || new Set(request.outputs.map(item => item.label)).size !== request.outputs.length) {
    throw new Error('MODEL_OUTPUT_PAIR_REQUIRED: 異なる名前の出力を2件指定してください');
  }
  id.array().length(2).parse(request.outputs.map(item => item.label));
  return {
    schemaVersion: 1 as const,
    mode: 'replay' as const,
    inputHash: prepared.inputHash,
    datasetHash: prepared.dataset.hash,
    rubricVersion: prepared.rubricVersion,
    humanCalibrationStatus: prepared.humanCalibrationStatus,
    reports: request.outputs.map(item => ({ label: item.label,
      ...evaluateOneOutput(prepared, resolved.cases, item.output) })),
  };
}
