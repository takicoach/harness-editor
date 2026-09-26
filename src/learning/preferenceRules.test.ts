import { describe, expect, it } from 'vitest';
import { appendDecisionEvent, decisionEventSchema, emptyDecisionLedger, type DecisionLedger } from './preferenceDecisions';
import { createRuleCandidate, proposePreferenceEdits, ruleAvailability, transitionRule, type PreferenceRule } from './preferenceRules';

// Contract fixtures only: these labels are invented for software tests, never calibration evidence.
function ledger(): DecisionLedger {
  return appendDecisionEvent(emptyDecisionLedger(), decisionEventSchema.parse({
    schemaVersion: 1, type: 'judgment', editKind: 'telop_text', id: 'd1', operationId: 'op1',
    createdAt: '2026-09-07T00:00:00Z', actor: { kind: 'human', id: 'test-human' },
    projectId: 'training', projectRevision: 'r1', elementId: '1',
    sourceFrameRange: { start: 0, end: 30 }, before: '素振りする', proposedAfter: '素振りをする',
    actualAfter: '素振りをする', decision: 'accepted', reasonCode: 'wording', note: '',
    scope: { kind: 'profile', id: 'golf' }, learningConsent: true, provenance: { kind: 'human' },
  }));
}
function candidate(l = ledger()): PreferenceRule {
  return createRuleCandidate(l, { id: 'r1', version: 1, evidenceIds: ['d1'], createdAt: '2026-09-07T00:01:00Z' });
}
const activation = { actorId: 'human', evaluationId: 'eval', at: '2026-09-07T00:02:00Z',
  dataset: { id: 'set', version: 1, hash: '0'.repeat(64) },
  caseDependencies: [{ decisionId: 'd1', operationId: 'op1' }] };
const target = { projectId: 'next', projectRevision: 'rev2', profileId: 'golf',
  elements: [{ id: '1', text: '素振りする', sourceFrameRange: { start: 40, end: 70 } }] };

describe('本文置換ルールの安全な提案契約', () => {
  it('同意した採用から候補を作っても有効化までは提案を出さない', () => {
    const l = ledger(); const r = candidate(l);
    expect(r.status).toBe('candidate');
    expect(proposePreferenceEdits([r], l, target).proposals).toEqual([]);
    expect(() => transitionRule(r, 'active', { kind: 'human', id: 'user' })).toThrow(/EVALUATION_REQUIRED/);
  });
  it('今回限り・不同意・保留・合成例から候補を作らない', () => {
    for (const patch of [{ learningConsent: false }, { scope: { kind: 'project', id: 'training' } },
      { decision: 'deferred', actualAfter: null }, { provenance: { kind: 'synthetic' } }]) {
      const l = ledger(); l.events[0] = decisionEventSchema.parse({ ...l.events[0], ...patch });
      expect(() => candidate(l)).toThrow();
    }
  });
  it('完全一致と明示方針のみを対象にし、元本文・範囲・版を提案へ固定する', () => {
    const l = ledger(); const r = { ...candidate(l), status: 'active' as const,
      activation };
    const result = proposePreferenceEdits([r], l, target);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ before: '素振りする', after: '素振りをする',
      projectRevision: 'rev2', sourceFrameRange: { start: 40, end: 70 }, rule: { id: 'r1', version: 1 },
      evidenceIds: ['d1'], activationEvaluationId: 'eval' });
    expect(proposePreferenceEdits([r], l, { ...target, profileId: 'other' }).proposals).toEqual([]);
    expect(proposePreferenceEdits([r], l, { ...target, elements: [{ ...target.elements[0]!, text: '今日も素振りする' }] }).proposals).toEqual([]);
  });
  it('例外案件では提案せず、異なる置換の競合を勝手に選ばない', () => {
    const l = ledger(); const r = { ...candidate(l), status: 'active' as const,
      activation };
    expect(proposePreferenceEdits([{ ...r, exceptions: { projectIds: ['next'] } }], l, target).proposals).toEqual([]);
    const conflictingLedger = appendDecisionEvent(l, { ...l.events[0], id: 'd2', operationId: 'op2',
      projectId: 'training-2', proposedAfter: '素振りを行う', actualAfter: '素振りを行う' });
    const second = { ...r, id: 'r2', evidenceIds: ['d2'], action: { kind: 'replace_text' as const, text: '素振りを行う' },
      activation: { ...activation, caseDependencies: [{ decisionId: 'd2', operationId: 'op2' }] } };
    const result = proposePreferenceEdits([r, second], conflictingLedger, target);
    expect(result.proposals).toEqual([]);
    expect(result.conflicts[0]?.elementId).toBe('1');
  });
  it('根拠への同意が撤回・訂正された瞬間から有効ルールも停止する', () => {
    const l = ledger(); const r = { ...candidate(l), status: 'active' as const,
      activation };
    const withdrawn = appendDecisionEvent(l, { schemaVersion: 1, type: 'withdrawal', id: 'w1', operationId: 'w1',
      createdAt: '2026-09-07T00:03:00Z', actor: { kind: 'human', id: 'user' }, targetId: 'd1', reason: '今回だけ' });
    expect(ruleAvailability(r, withdrawn)).toBe('evidence_invalidated');
    expect(proposePreferenceEdits([r], withdrawn, target).proposals).toEqual([]);
    expect(r.status).toBe('active'); // History is preserved; effective availability is derived.
  });
  it('AIの有効化・撤回操作と失効済み版の再開を拒否する', () => {
    const r = candidate();
    expect(() => transitionRule(r, 'revoked', { kind: 'model', id: 'agent' })).toThrow(/HUMAN_REQUIRED/);
    const revoked = transitionRule(r, 'revoked', { kind: 'human', id: 'user' });
    expect(() => transitionRule(revoked, 'suspended', { kind: 'human', id: 'user' })).toThrow(/RULE_REVOKED/);
  });
});
