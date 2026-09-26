import { describe, expect, it } from 'vitest';
import { appendDecisionEvent, emptyDecisionLedger, type DecisionLedger } from './preferenceDecisions';
import { createRuleCandidate, proposePreferenceEdits, ruleAvailability } from './preferenceRules';
import { activateEvaluatedRule, evaluatePreferenceRule, freezePreferenceDataset, type EvaluationDataset } from './preferenceEvaluation';

// Synthetic test setup pretending to be user actions exercises the contract only. It is NOT a human gold set.
function setup() {
  let ledger = emptyDecisionLedger();
  for (let i = 0; i <= 10; i++) {
    const negative = i > 5;
    ledger = appendDecisionEvent(ledger, {
      schemaVersion: 1, type: 'judgment', editKind: 'telop_text', id: `d${i}`, operationId: `op${i}`,
      createdAt: '2026-09-07T00:00:00Z', actor: { kind: 'human', id: 'test-human' },
      projectId: i === 0 ? 'training' : negative ? 'heldout-negative' : 'heldout-positive', projectRevision: 'r1', elementId: `${i}`,
      sourceFrameRange: { start: i * 30, end: (i + 1) * 30 }, before: negative ? 'そのままでよい' : '素振りする',
      proposedAfter: '素振りをする', actualAfter: negative ? null : '素振りをする',
      decision: negative ? 'rejected' : 'accepted', reasonCode: 'wording', note: '',
      scope: { kind: 'profile', id: 'golf' }, learningConsent: true, provenance: { kind: 'human' },
    });
  }
  const rule = createRuleCandidate(ledger, { id: 'r1', version: 1, evidenceIds: ['d0'], createdAt: '2026-09-07T00:01:00Z' });
  const dataset = freezePreferenceDataset(ledger, { id: 'set1', version: 1,
    caseIds: Array.from({ length: 10 }, (_, i) => `d${i + 1}`), frozenAt: '2026-09-07T00:02:00Z' });
  return { ledger, rule, dataset };
}
const run = { id: 'eval1', startedAt: '2026-09-07T00:03:00Z' };

describe('固定した独立案件での本文ルール評価', () => {
  it('固定入力・出力・ルール・基準のhashと実測件数を残す', () => {
    const { ledger, rule, dataset } = setup();
    const result = evaluatePreferenceRule(rule, ledger, dataset, run);
    expect(result.mode).toBe('deterministic');
    expect(result.aggregate).toMatchObject({ total: 10, passed: 10, falsePass: 0, falseFail: 0 });
    expect(result.activationEligible).toBe(true);
    expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.datasetHash).toBe(dataset.hash);
    expect(result.humanCalibrationStatus).toBe('human_labeled_exact_cases');
  });
  it('合格があってもモデルによる有効化を拒否し、人の操作でのみ有効化する', () => {
    const { ledger, rule, dataset } = setup();
    expect(() => activateEvaluatedRule(rule, ledger, dataset, { ...run, actor: { kind: 'model', id: 'model' } })).toThrow(/HUMAN_REQUIRED/);
    const result = activateEvaluatedRule(rule, ledger, dataset, { ...run, actor: { kind: 'human', id: 'owner' } });
    expect(result.rule.status).toBe('active');
    expect(result.rule.activation?.evaluationId).toBe('eval1');
    expect(rule.status).toBe('candidate');
  });
  it('有効化に使った評価ケースの撤回・訂正後は履歴を残したまま提案を停止する', () => {
    const target = { projectId: 'next', projectRevision: 'r2', profileId: 'golf',
      elements: [{ id: '1', text: '素振りする', sourceFrameRange: { start: 0, end: 30 } }] };
    for (const kind of ['withdrawal', 'correction'] as const) {
      const { ledger, rule, dataset } = setup();
      const active = activateEvaluatedRule(rule, ledger, dataset, { ...run, actor: { kind: 'human', id: 'owner' } }).rule;
      const original = ledger.events.find((event) => event.id === 'd1');
      if (!original || original.type !== 'judgment') throw new Error('fixture missing');
      const invalidated = appendDecisionEvent(ledger, kind === 'withdrawal'
        ? { schemaVersion: 1, type: 'withdrawal', id: 'w1', operationId: 'w1', createdAt: run.startedAt,
          actor: { kind: 'human', id: 'owner' }, targetId: 'd1', reason: '撤回' }
        : { ...original, id: 'd1-fixed', operationId: 'fix-d1', createdAt: run.startedAt,
          supersedes: 'd1', decision: 'rejected', actualAfter: null });
      expect(ruleAvailability(active, invalidated)).toBe('evaluation_invalidated');
      expect(proposePreferenceEdits([active], invalidated, target).proposals).toEqual([]);
      expect(active.status).toBe('active');
      expect(evaluatePreferenceRule(active, invalidated, dataset, { ...run, id: `reevaluate-${kind}` }).failures)
        .toContain('CASE_INVALIDATED');
    }
  });
  it('同一案件の別クリップを独立評価として認めない', () => {
    const { ledger, rule } = setup();
    const dataset = freezePreferenceDataset(ledger, { id: 'leak', version: 1, caseIds: ['d0'], frozenAt: run.startedAt });
    expect(evaluatePreferenceRule(rule, ledger, dataset, run).failures).toContain('TRAIN_EVAL_PROJECT_OVERLAP');
    expect(() => activateEvaluatedRule(rule, ledger, dataset, { ...run, actor: { kind: 'human', id: 'owner' } })).toThrow(/EVALUATION_FAILED/);
  });
  it('合成ラベル、件数不足、片側だけのラベルでは有効化できない', () => {
    const { ledger, rule } = setup();
    const synthetic: DecisionLedger = { ...ledger, events: ledger.events.map((e, i) => i === 0 ? e : ({ ...e, provenance: { kind: 'synthetic' } } as typeof e)) };
    const set = freezePreferenceDataset(synthetic, { id: 'synthetic', version: 1, caseIds: ['d1', 'd6'], frozenAt: run.startedAt });
    const result = evaluatePreferenceRule(rule, synthetic, set, run);
    expect(result.failures).toEqual(expect.arrayContaining(['HUMAN_LABELS_REQUIRED', 'INSUFFICIENT_CASES']));
    expect(result.humanCalibrationStatus).toBe('not_calibrated');
    const positiveOnly = freezePreferenceDataset(ledger, { id: 'positive-only', version: 1, caseIds: ['d1'], frozenAt: run.startedAt });
    expect(evaluatePreferenceRule(rule, ledger, positiveOnly, run).failures).toContain('POSITIVE_AND_NEGATIVE_REQUIRED');
  });
  it('データ改変・同意撤回・根拠撤回を検出して、過去の合格を流用しない', () => {
    const { ledger, rule, dataset } = setup();
    const tampered = structuredClone(dataset); tampered.cases[0]!.before = '都合よく変更';
    expect(() => evaluatePreferenceRule(rule, ledger, tampered, run)).toThrow(/DATASET_HASH_MISMATCH/);
    for (const targetId of ['d0', 'd1']) {
      const withdrawn = appendDecisionEvent(ledger, { schemaVersion: 1, type: 'withdrawal', id: 'w1', operationId: 'w1',
        createdAt: run.startedAt, actor: { kind: 'human', id: 'owner' }, targetId, reason: '撤回' });
      expect(evaluatePreferenceRule(rule, withdrawn, dataset, run).activationEligible).toBe(false);
    }
  });
  it('拒否された置換を出すとfalse-pass、採用例を落とすとfalse-failになる', () => {
    const { ledger, rule, dataset } = setup();
    const negativeRule = { ...rule, conditions: { textEquals: 'そのままでよい' } };
    const result = evaluatePreferenceRule(negativeRule, ledger, dataset, run);
    expect(result.aggregate.falsePass).toBe(5);
    expect(result.aggregate.falseFail).toBe(5);
    expect(result.activationEligible).toBe(false);
  });
  it('凍結データの重複・未知版・未同意ラベルを拒否する', () => {
    const { ledger, rule, dataset } = setup();
    expect(() => freezePreferenceDataset(ledger, { id: 'dup', version: 1, caseIds: ['d1', 'd1'], frozenAt: run.startedAt })).toThrow(/DUPLICATE_CASE/);
    expect(() => evaluatePreferenceRule(rule, ledger, { ...dataset, schemaVersion: 2 } as unknown as EvaluationDataset, run)).toThrow();
  });
  it('却下済み提案と異なる本文を、勝手に人の却下ラベルへ拡張しない', () => {
    const { ledger, rule, dataset } = setup();
    const changed = { ...rule, conditions: { textEquals: 'そのままでよい' }, action: { kind: 'replace_text' as const, text: '人がまだ判断していない別案' } };
    const result = evaluatePreferenceRule(changed, ledger, dataset, run);
    expect(result.failures).toContain('UNJUDGED_ALTERNATIVE');
    expect(result.results.filter((r) => r.unjudgedAlternative)).toHaveLength(5);
    expect(result.aggregate.falsePass).toBe(0);
    expect(result.activationEligible).toBe(false);
  });
});
