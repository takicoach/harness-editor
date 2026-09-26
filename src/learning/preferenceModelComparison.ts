import { z } from 'zod';
import type { PreferenceWorkspace } from './preferenceWorkspaceStore';
import { evaluatePreferenceRule, preferenceHash } from './preferenceEvaluation';
import { buildPreferenceModelInput, replayPreferenceAdapter, runPreferenceModelEvaluation } from './preferenceModelEvaluation';

const id = z.string().trim().min(1).max(256);
export const modelSelectionSchema = z.object({ ruleId: id, ruleVersion: z.number().int().positive(),
  datasetId: id, datasetVersion: z.number().int().positive() }).strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export const modelComparisonSchema = modelSelectionSchema.extend({ inputHash: id,
  outputs: z.array(z.object({ label: z.string().trim().min(1).max(100), output: z.unknown() }).strict()).length(2),
}).strict();

function selected(state: PreferenceWorkspace, selection: ModelSelection) {
  const rule = state.rules.find((r) => r.id === selection.ruleId && r.version === selection.ruleVersion);
  const dataset = state.datasets.find((d) => d.id === selection.datasetId && d.version === selection.datasetVersion);
  if (!rule || !dataset) throw new Error('MODEL_SELECTION_NOT_FOUND: ルールと評価データを選び直してください');
  return { rule, dataset };
}

/** A fresh journal snapshot gates both export and replay. No model or journal writes are performed. */
export function preparePreferenceModelInput(state: PreferenceWorkspace, selection: ModelSelection) {
  const { rule, dataset } = selected(state, selection);
  const baseline = evaluatePreferenceRule(rule, state.decisions, dataset,
    { id: 'readonly-model-input', startedAt: new Date().toISOString() });
  if (baseline.failures.some((f) => ['EVIDENCE_INVALIDATED', 'CASE_INVALIDATED', 'TRAIN_EVAL_PROJECT_OVERLAP', 'RULE_REVOKED'].includes(f))) {
    throw new Error('EVALUATION_INPUT_INVALID: 同意の撤回・実例の訂正・候補づくりとの案件重複があります。実例とルールを確認してください');
  }
  const input = buildPreferenceModelInput(rule, dataset);
  return { schemaVersion: 1 as const, input, inputHash: preferenceHash(input), rubricVersion: baseline.rubricVersion,
    humanCalibrationStatus: baseline.humanCalibrationStatus, failures: baseline.failures };
}
export type PreparedModelInput = ReturnType<typeof preparePreferenceModelInput>;

export async function comparePreferenceModelOutputs(state: PreferenceWorkspace, request: z.infer<typeof modelComparisonSchema>) {
  const prepared = preparePreferenceModelInput(state, request);
  if (prepared.inputHash !== request.inputHash) {
    throw new Error('MODEL_INPUT_CHANGED: 比較する入力が変わりました。入力を書き出し直し、同じ入力への出力を選んでください');
  }
  const { rule, dataset } = selected(state, request);
  const createdAt = new Date().toISOString();
  const reports = await Promise.all(request.outputs.map(({ label, output }) => runPreferenceModelEvaluation(rule,
    state.decisions, dataset, replayPreferenceAdapter({ id: 'editor-file-replay', version: '1',
      provider: 'user-supplied-file', model: label, output }), { id: crypto.randomUUID(), startedAt: createdAt })));
  return { schemaVersion: 1 as const, mode: 'replay' as const, createdAt, prepared, reports,
    selection: modelSelectionSchema.parse({ ruleId: request.ruleId, ruleVersion: request.ruleVersion,
      datasetId: request.datasetId, datasetVersion: request.datasetVersion }),
    outputs: request.outputs, activationAuthorized: false as const };
}
export type ModelComparison = Awaited<ReturnType<typeof comparePreferenceModelOutputs>>;
