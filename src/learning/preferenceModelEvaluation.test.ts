import { describe, expect, it, vi } from 'vitest';
import { appendDecisionEvent, emptyDecisionLedger } from './preferenceDecisions';
import { createRuleCandidate } from './preferenceRules';
import { freezePreferenceDataset } from './preferenceEvaluation';
import { buildPreferenceModelInput, replayPreferenceAdapter, runPreferenceModelEvaluation, type PreferenceModelAdapter } from './preferenceModelEvaluation';

const run = { id: 'comparison-1', startedAt: '2026-09-07T00:03:00Z' };
function fixture() {
  // Invented software fixtures. The training actor simulates a human action; no real human calibration is claimed.
  let ledger = emptyDecisionLedger();
  for (let i = 0; i <= 10; i++) {
    const negative = i > 5;
    ledger = appendDecisionEvent(ledger, { schemaVersion: 1, type: 'judgment', editKind: 'telop_text', id: `label-${i}`, operationId: `op-${i}`,
      createdAt: '2026-09-07T00:00:00Z', actor: { kind: 'human', id: 'test-actor' },
      projectId: i === 0 ? 'train' : negative ? 'label-negative-secret-name' : 'label-positive-secret-name',
      projectRevision: 'revision', elementId: String(i), sourceFrameRange: { start: i * 30, end: i * 30 + 30 },
      before: negative ? 'このまま' : '素振りする', proposedAfter: '素振りをする', actualAfter: negative ? null : '素振りをする',
      decision: negative ? 'rejected' : 'accepted', reasonCode: 'wording', note: 'owner-label-secret-note',
      scope: { kind: 'profile', id: 'golf' }, learningConsent: true, provenance: { kind: i === 0 ? 'human' : 'synthetic' } });
  }
  const rule = createRuleCandidate(ledger, { id: 'rule', version: 1, evidenceIds: ['label-0'], createdAt: '2026-09-07T00:01:00Z' });
  const dataset = freezePreferenceDataset(ledger, { id: 'heldout', version: 1, caseIds: Array.from({ length: 10 }, (_, i) => `label-${i + 1}`), frozenAt: '2026-09-07T00:02:00Z' });
  const input = buildPreferenceModelInput(rule, dataset);
  const output = { schemaVersion: 1, predictions: input.cases.map((c) => ({ caseId: c.caseId, after: c.text === '素振りする' ? '素振りをする' : null })) };
  return { ledger, rule, dataset, input, output };
}
function replay(output: unknown, model = 'recorded-model-a') {
  return replayPreferenceAdapter({ id: model, version: '1', provider: 'test-replay', model, output });
}

describe('固定された本文評価を別モデルの出力へ使う契約', () => {
  it('生成入力に正解・却下内容・理由・由来ラベルやラベルを含む案件名を渡さない', () => {
    const { input } = fixture();
    const encoded = JSON.stringify(input);
    for (const forbidden of ['proposedAfter', 'actualAfter', 'decision', 'provenance', 'owner-label-secret-note',
      'label-negative-secret-name', 'label-positive-secret-name', 'label-1']) expect(encoded).not.toContain(forbidden);
    expect(input.cases).toHaveLength(10);
    expect(input.rule.replaceWith).toBe('素振りをする'); // The authorized rule is input; held-out judgments are not.
  });
  it('出力を差し替えても入力hashと基準を固定し、リプレイをliveと呼ばない', async () => {
    const { ledger, rule, dataset, output } = fixture();
    const bad = { schemaVersion: 1, predictions: output.predictions.map((p) => ({ ...p, after: '望まない変更' })) };
    const first = await runPreferenceModelEvaluation(rule, ledger, dataset, replay(output), run);
    const second = await runPreferenceModelEvaluation(rule, ledger, dataset, replay(bad, 'recorded-model-b'), { ...run, id: 'comparison-2' });
    expect(first.inputHash).toBe(second.inputHash);
    expect(first.datasetHash).toBe(second.datasetHash);
    expect(first.rubricVersion).toBe(second.rubricVersion);
    expect(first.mode).toBe('replay'); expect(second.mode).toBe('replay');
    expect(first.aggregate.passed).toBe(10); expect(second.aggregate.passed).toBe(0);
    expect(first.activationAuthorized).toBe(false);
    expect(first.humanCalibrationStatus).toBe('not_calibrated');
  });
  it('欠落・重複・未知ケース・不要フィールドを好結果だけ抜き出して採点しない', async () => {
    const { ledger, rule, dataset, output } = fixture();
    for (const invalid of [
      { ...output, predictions: output.predictions.slice(1) },
      { ...output, predictions: output.predictions.map(() => output.predictions[0]) },
      { ...output, predictions: output.predictions.map((p, i) => i === 0 ? { ...p, caseId: 'invented' } : p) },
      { ...output, hiddenPermission: true },
    ]) {
      const result = await runPreferenceModelEvaluation(rule, ledger, dataset, replay(invalid), run);
      expect(result.status).toBe('invalid_output'); expect(result.aggregate.passed).toBe(0);
    }
  });
  it('同意が撤回された入力はprovider呼出し前に拒否する', async () => {
    const { ledger, rule, dataset } = fixture();
    const withdrawn = appendDecisionEvent(ledger, { schemaVersion: 1, type: 'withdrawal', id: 'w', operationId: 'w', createdAt: run.startedAt,
      actor: { kind: 'human', id: 'test-actor' }, targetId: 'label-1', reason: 'test withdrawal' });
    const adapter = { ...replay(null), generate: vi.fn() };
    await expect(runPreferenceModelEvaluation(rule, withdrawn, dataset, adapter, run)).rejects.toThrow(/CASE_INVALIDATED/);
    expect(adapter.generate).not.toHaveBeenCalled();
  });
  it('同じ評価データでも別版のルール向けの古い出力を混ぜない', async () => {
    const { ledger, rule, dataset, output } = fixture();
    const revised = { ...rule, version: 2 };
    const result = await runPreferenceModelEvaluation(revised, ledger, dataset, replay(output), run);
    expect(result.status).toBe('invalid_output');
    expect(result.failures).toContain('OUTPUT_CASES_MISMATCH');
    expect(result.aggregate.passed).toBe(0);
  });
  it('キャンセル後の遅い結果を完了・採点へ変えない', async () => {
    const { ledger, rule, dataset, output } = fixture();
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    const adapter: PreferenceModelAdapter = { ...replay(null), generate: () => new Promise((resolve) => { finish = resolve; }) };
    const promise = runPreferenceModelEvaluation(rule, ledger, dataset, adapter, { ...run, signal: controller.signal });
    controller.abort();
    const cancelled = await promise; finish(output);
    expect(cancelled.status).toBe('cancelled'); expect(cancelled.aggregate.passed).toBe(0);
    expect(cancelled.outputHash).toBeNull();
  });
  it('providerの失敗文に機密があっても評価記録へコピーしない', async () => {
    const { ledger, rule, dataset } = fixture();
    const adapter = { ...replay(null), generate: async () => { throw new Error('api-key-secret'); } };
    const result = await runPreferenceModelEvaluation(rule, ledger, dataset, adapter, run);
    expect(result.status).toBe('failed');
    expect(result.failures).toContain('ADAPTER_FAILED');
    expect(JSON.stringify(result)).not.toContain('api-key-secret');
  });
});
