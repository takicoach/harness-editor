import { describe, expect, it } from 'vitest';
import { scriptAdoptionFixture, scriptJudgmentFixture } from '../core/__fixtures__/scriptAdoption';
import { resolveScriptEditPlan } from '../core/scriptEditModification';
import { editorOperationSchema, type EditorOperation } from '../shared/editorOperations';
import { appendDecisionEvent, emptyDecisionLedger, type DecisionLedger } from './preferenceDecisions';
import type { ScriptJudgmentExample } from './scriptDecisions';
import { freezeScriptDataset } from './scriptEvaluation';
import { compareScriptModelOutputs, prepareScriptModelInput } from './scriptModelEvaluation';

function event(id: string, kind: 'caption' | 'structure', decision: ScriptJudgmentExample['decision'],
  modification?: ScriptJudgmentExample['modification']): ScriptJudgmentExample {
  return {
    ...scriptJudgmentFixture(), id, operationId: `record-${id}`, artifact: scriptAdoptionFixture(kind),
    decision, modification, learningConsent: true,
    application: decision === 'accepted' || decision === 'accepted_modified'
      ? { sessionId: 'old-browser', baseRevision: 'old-r1' } : undefined,
  } as ScriptJudgmentExample;
}
function ledgerOf(...events: ScriptJudgmentExample[]): DecisionLedger {
  return events.reduce<DecisionLedger>((ledger, value) => appendDecisionEvent(ledger, value), emptyDecisionLedger());
}
function receipt(value: ScriptJudgmentExample): EditorOperation {
  return editorOperationSchema.parse({
    schemaVersion: 1, runId: `run-${value.id}`, serverInstance: 'server', createdAt: 1, updatedAt: 2,
    request: { schemaVersion: 1, projectId: value.projectId, operationId: `script:${value.id}`, baseRevision: 'new-r2',
      script: { judgmentId: value.id, artifact: value.artifact,
        ...(value.modification ? { modification: value.modification } : {}) }, changes: [] },
    phase: 'saved', cancelRequested: false, confirmed: { applied: true, saved: true },
    claim: { sessionId: 'new-browser', token: 'token' },
    result: { phase: 'saved', revision: 'saved-r3', code: null, applied: true, saved: true },
    lateResult: null, humanReview: 'pending',
  });
}
const generator = { provider: 'provider', model: 'model', promptVersion: 'prompt-1', configHash: 'a'.repeat(64) };

describe('script model replay evaluation', () => {
  it('keeps model input independent of judgment labels, notes, corrections and receipt identity', () => {
    const first = event('first', 'caption', 'accepted_modified', { kind: 'caption', changes: [{ telopId: 1, after: '人の修正A' }] });
    const second = { ...event('second', 'caption', 'rejected'), note: '別の判断理由' };
    function prepare(value: ScriptJudgmentExample) {
      const ledger = ledgerOf(value), operations = value.decision === 'rejected' ? [] : [receipt(value)];
      const dataset = freezeScriptDataset(ledger, operations, { id: value.id, version: 1,
        frozenAt: '2026-09-08T03:00:00Z', caseIds: [value.id] }, { includeSynthetic: true });
      return { dataset, prepared: prepareScriptModelInput(dataset, ledger, operations, { includeSynthetic: true }) };
    }
    const a = prepare(first), b = prepare(second);
    expect(a.dataset.hash).not.toBe(b.dataset.hash);
    expect(a.prepared.input).toEqual(b.prepared.input);
    expect(a.prepared.inputHash).toBe(b.prepared.inputHash);
    expect(JSON.stringify(a.prepared.input)).not.toContain(a.dataset.hash);
  });

  it('withholds labels and classifies both kinds without inventing a right answer for alternatives', async () => {
    const modified = event('modified', 'caption', 'accepted_modified', {
      kind: 'caption', changes: [{ telopId: 1, after: '人が直した表記' }],
    });
    const rejected = event('rejected', 'caption', 'rejected');
    const structure = event('structure', 'structure', 'accepted');
    const ledger = ledgerOf(modified, rejected, structure);
    const operations = [receipt(modified), receipt(structure)];
    const dataset = freezeScriptDataset(ledger, operations, {
      id: 'models', version: 1, frozenAt: '2026-09-08T03:00:00Z',
      caseIds: [modified.id, rejected.id, structure.id],
    }, { includeSynthetic: true });
    const prepared = prepareScriptModelInput(dataset, ledger, operations, { includeSynthetic: true });

    expect(prepared.humanCalibrationStatus).toBe('not_calibrated');
    expect(prepared.input.cases[0]?.target).toEqual({ kind: 'caption', changes: [{ telopId: 1, before: 'ハイ' }] });
    expect(JSON.stringify(prepared.input)).not.toContain('人が直した表記');
    expect(JSON.stringify(prepared.input)).not.toContain('"decision"');

    const [modifiedCase, rejectedCase, structureCase] = prepared.input.cases;
    const structurePlan = resolveScriptEditPlan(structure.artifact);
    if (structurePlan.kind !== 'structure') throw new Error('fixture kind');
    const first = { schemaVersion: 1 as const, inputHash: prepared.inputHash, generator, predictions: [
      { caseId: modifiedCase!.caseId, plan: { kind: 'caption' as const, changes: [{ telopId: 1, after: '人が直した表記' }] } },
      { caseId: rejectedCase!.caseId, plan: { kind: 'caption' as const, changes: [{ telopId: 1, after: 'はい' }] } },
      { caseId: structureCase!.caseId, plan: { kind: 'structure' as const, cutOrder: [{ originalStart: 0, originalEnd: 61 }] } },
    ] };
    const second = { schemaVersion: 1 as const, inputHash: prepared.inputHash, generator: { ...generator, model: 'model-b' }, predictions: [
      // Reproducing the current input is valid evaluation output, but was never labeled as correct.
      { caseId: modifiedCase!.caseId, plan: { kind: 'caption' as const, changes: [{ telopId: 1, after: 'ハイ' }] } },
      { caseId: rejectedCase!.caseId, plan: null },
      { caseId: structureCase!.caseId, plan: { kind: 'structure' as const, cutOrder: structurePlan.cutOrder } },
    ] };
    const comparison = await compareScriptModelOutputs(dataset, ledger, operations, {
      inputHash: prepared.inputHash,
      outputs: [{ label: 'A', output: first }, { label: 'B', output: second }],
    }, { includeSynthetic: true });

    expect(comparison.reports[0]!.results.map(result => result.classification))
      .toEqual(['known_accepted', 'known_rejected', 'invalid']);
    expect(comparison.reports[0]!.aggregate).toMatchObject({ total: 3, knownAccepted: 1, knownRejected: 1, unjudged: 0, invalid: 1,
      byKind: { caption: { total: 2 }, structure: { total: 1 } } });
    expect(comparison.reports[1]!.results.map(result => result.classification))
      .toEqual(['unjudged', 'unjudged', 'known_accepted']);
    expect(comparison.reports.every(report => report.activationAuthorized === false)).toBe(true);
  });

  it('rejects outputs for another prepared input and reports strict case-set errors', async () => {
    const accepted = event('accepted', 'caption', 'accepted');
    const ledger = ledgerOf(accepted), operations = [receipt(accepted)];
    const dataset = freezeScriptDataset(ledger, operations, {
      id: 'strict', version: 1, frozenAt: '2026-09-08T03:00:00Z', caseIds: [accepted.id],
    }, { includeSynthetic: true });
    const prepared = prepareScriptModelInput(dataset, ledger, operations, { includeSynthetic: true });
    const badHash = { schemaVersion: 1, inputHash: '0'.repeat(64), generator, predictions: [] };
    const missing = { schemaVersion: 1, inputHash: prepared.inputHash, generator, predictions: [] };
    const comparison = await compareScriptModelOutputs(dataset, ledger, operations, {
      inputHash: prepared.inputHash, outputs: [{ label: 'bad-hash', output: badHash }, { label: 'missing', output: missing }],
    }, { includeSynthetic: true });
    expect(comparison.reports.map(report => [report.status, report.failures[0], report.aggregate.invalid]))
      .toEqual([['invalid_output', 'OUTPUT_INPUT_MISMATCH', 1], ['invalid_output', 'OUTPUT_CASES_MISMATCH', 1]]);
    await expect(compareScriptModelOutputs(dataset, ledger, operations, {
      inputHash: 'f'.repeat(64), outputs: [{ label: 'a', output: missing }, { label: 'b', output: missing }],
    }, { includeSynthetic: true })).rejects.toThrow(/MODEL_INPUT_MISMATCH/);
  });
});
