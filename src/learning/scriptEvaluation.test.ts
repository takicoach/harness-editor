import { describe, expect, it } from 'vitest';
import { scriptAdoptionFixture, scriptJudgmentFixture } from '../core/__fixtures__/scriptAdoption';
import { createScriptEditArtifact, sealScriptEditInput } from '../server/scriptEditArtifacts';
import { editorOperationSchema, type EditorOperation } from '../shared/editorOperations';
import { appendDecisionEvent, emptyDecisionLedger, type DecisionLedger } from './preferenceDecisions';
import type { ScriptJudgmentExample } from './scriptDecisions';
import {
  freezeScriptDataset,
  listScriptDecisionAvailability,
  parseScriptDataset,
  resolveScriptDataset,
  verifyScriptDatasetReferences,
} from './scriptEvaluation';

function judgment(id: string, kind: 'caption' | 'structure', decision: ScriptJudgmentExample['decision'] = 'accepted',
  overrides: Partial<ScriptJudgmentExample> = {}): ScriptJudgmentExample {
  const base = scriptJudgmentFixture();
  const modification = decision === 'accepted_modified'
    ? kind === 'caption'
      ? { kind: 'caption' as const, changes: [{ telopId: 1, after: '人が直した表記' }] }
      : { kind: 'structure' as const, cutOrder: [{ originalStart: 0, originalEnd: 30 }] }
    : undefined;
  return {
    ...base,
    id,
    operationId: `record-${id}`,
    artifact: scriptAdoptionFixture(kind),
    decision,
    learningConsent: true,
    actor: { kind: 'human', id: 'owner' },
    provenance: { kind: 'human' },
    ...(decision === 'accepted' || decision === 'accepted_modified'
      ? { application: { sessionId: 'original-browser', baseRevision: 'original-r1' } }
      : { application: undefined }),
    ...(modification ? { modification } : { modification: undefined }),
    ...overrides,
  } as ScriptJudgmentExample;
}

function ledgerOf(...events: unknown[]): DecisionLedger {
  return events.reduce<DecisionLedger>((ledger, event) => appendDecisionEvent(ledger, event), emptyDecisionLedger());
}

function savedOperation(event: ScriptJudgmentExample, overrides: Record<string, unknown> = {}): EditorOperation {
  return editorOperationSchema.parse({
    schemaVersion: 1,
    runId: `run-${event.id}`,
    request: {
      schemaVersion: 1,
      projectId: event.projectId,
      operationId: `script:${event.id}`,
      // A queued request may be rebound before delivery.
      baseRevision: 'rebound-r2',
      script: { judgmentId: event.id, artifact: event.artifact,
        ...(event.modification ? { modification: event.modification } : {}) },
      changes: [],
    },
    serverInstance: 'server', createdAt: 1, updatedAt: 2,
    phase: 'saved', cancelRequested: false,
    confirmed: { applied: true, saved: true },
    claim: { sessionId: 'rebound-browser', token: 'token' },
    result: { phase: 'saved', revision: 'saved-r3', code: null, applied: true, saved: true },
    lateResult: null, humanReview: 'pending',
    ...overrides,
  });
}

describe('script evaluation datasets', () => {
  it('freezes references only and resolves caption and structure labels through exact saved receipts', () => {
    const caption = judgment('caption-human', 'caption', 'accepted_modified');
    const structure = judgment('structure-human', 'structure');
    const ledger = ledgerOf(caption, structure);
    const operations = [savedOperation(caption), savedOperation(structure)];
    const dataset = freezeScriptDataset(ledger, operations, {
      id: 'scripts', version: 1, frozenAt: '2026-09-08T01:00:00Z', caseIds: [caption.id, structure.id],
    });

    expect(dataset.cases.map(item => item.kind)).toEqual(['caption', 'structure']);
    expect(JSON.stringify(dataset)).not.toContain('artifact');
    expect(dataset.cases.every(item => item.receipt?.receiptHash.length === 64)).toBe(true);
    const resolved = resolveScriptDataset(dataset, ledger, operations);
    expect(resolved.cases.every(item => item.acceptedPlanHash?.length === 64)).toBe(true);
    expect(resolved.humanCalibrationStatus).toBe('human_labeled_exact_cases');
  });

  it('distinguishes a missing receipt from a mismatched or unfinished receipt', () => {
    const event = judgment('accepted', 'caption');
    const ledger = ledgerOf(event);
    expect(listScriptDecisionAvailability(ledger, [])[0]?.reasons).toContain('SAVE_RECEIPT_REQUIRED');
    const wrong = savedOperation(event);
    wrong.request.script!.artifact = scriptAdoptionFixture('structure');
    expect(listScriptDecisionAvailability(ledger, [wrong])[0]?.reasons).toContain('SAVE_RECEIPT_MISMATCH');
    const running = savedOperation(event, { phase: 'running', confirmed: { applied: false, saved: false },
      result: null });
    expect(listScriptDecisionAvailability(ledger, [running])[0]?.reasons).toContain('SAVE_RECEIPT_MISMATCH');
  });

  it('keeps frozen history parseable while current withdrawal invalidates its use', () => {
    const event = judgment('accepted', 'caption');
    const operation = savedOperation(event);
    const ledger = ledgerOf(event);
    const dataset = freezeScriptDataset(ledger, [operation], {
      id: 'scripts', version: 1, frozenAt: '2026-09-08T01:00:00Z', caseIds: [event.id],
    });
    const withdrawal = { schemaVersion: 1 as const, type: 'withdrawal' as const, id: 'withdraw', operationId: 'withdraw',
      createdAt: '2026-09-08T02:00:00Z', actor: { kind: 'human' as const, id: 'owner' }, targetId: event.id, reason: '撤回' };
    const withdrawn = ledgerOf(event, withdrawal);

    expect(parseScriptDataset(dataset)).toEqual(dataset);
    expect(verifyScriptDatasetReferences(dataset, withdrawn)).toEqual(dataset);
    expect(() => resolveScriptDataset(dataset, withdrawn, [operation])).toThrow(/CASE_INVALIDATED/);
  });

  it('keeps synthetic fixtures separate and never reports them as human calibrated', () => {
    const event = { ...scriptJudgmentFixture(), learningConsent: true };
    const ledger = ledgerOf(event);
    const operation = savedOperation(event);
    expect(listScriptDecisionAvailability(ledger, [operation])[0]?.reasons).toContain('SYNTHETIC_NOT_ALLOWED');
    const dataset = freezeScriptDataset(ledger, [operation], {
      id: 'synthetic', version: 1, frozenAt: '2026-09-08T01:00:00Z', caseIds: [event.id],
    }, { includeSynthetic: true });
    expect(dataset.labelSource).toBe('synthetic');
    expect(resolveScriptDataset(dataset, ledger, [operation], { includeSynthetic: true }).humanCalibrationStatus)
      .toBe('not_calibrated');
    expect(() => resolveScriptDataset(dataset, ledger, [operation])).toThrow(/SYNTHETIC_NOT_ALLOWED/);
  });

  it('rejects contradictory accepted and rejected labels for the same model input', () => {
    const accepted = judgment('accepted', 'caption');
    const rejected = judgment('rejected', 'caption', 'rejected');
    const ledger = ledgerOf(accepted, rejected);
    expect(() => freezeScriptDataset(ledger, [savedOperation(accepted)], {
      id: 'conflict', version: 1, frozenAt: '2026-09-08T01:00:00Z', caseIds: [accepted.id, rejected.id],
    })).toThrow(/CONTRADICTORY_LABELS/);
  });

  it('treats different caption target sets on the same input as separate tasks', () => {
    const original = scriptAdoptionFixture('caption');
    if (original.proposal.kind !== 'caption') throw new Error('fixture kind');
    const input = sealScriptEditInput({ ...original.input, inputHash: '0'.repeat(64), editing: {
      ...original.input.editing,
      telops: [...original.input.editing.telops, { ...original.input.editing.telops[0]!, id: 2 }],
    } });
    const proposal = { ...original.proposal, inputHash: input.inputHash,
      proposalId: `script-edit:caption:${input.inputHash}` };
    const firstArtifact = createScriptEditArtifact(input, proposal);
    const secondArtifact = createScriptEditArtifact(input, { ...proposal,
      changes: proposal.changes.map(change => ({ ...change, telopId: 2 })) });
    const first = judgment('target-one', 'caption', 'accepted', { artifact: firstArtifact });
    const second = judgment('target-two', 'caption', 'accepted', { artifact: secondArtifact });
    const ledger = ledgerOf(first, second);

    expect(() => freezeScriptDataset(ledger, [savedOperation(first), savedOperation(second)], {
      id: 'separate-targets', version: 1, frozenAt: '2026-09-08T01:00:00Z', caseIds: [first.id, second.id],
    })).not.toThrow();
  });
});
