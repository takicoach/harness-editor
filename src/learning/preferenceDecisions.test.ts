import { describe, expect, it } from 'vitest';
import { appendDecisionEvent, decisionEventSchema, eligibleDecisionExamples, emptyDecisionLedger } from './preferenceDecisions';

function example(overrides: Record<string, unknown> = {}) {
  return decisionEventSchema.parse({
    schemaVersion: 1, type: 'judgment', editKind: 'telop_text', id: 'd1', operationId: 'op1',
    createdAt: '2026-09-07T00:00:00Z', actor: { kind: 'human', id: 'local-user' },
    projectId: 'video-a', projectRevision: 'rev-a', elementId: 'telop-1',
    sourceFrameRange: { start: 0, end: 30 }, before: '素振りする',
    proposedAfter: '素振りをする', actualAfter: '素振りをする', decision: 'accepted',
    reasonCode: 'wording', note: '', scope: { kind: 'profile', id: 'golf' },
    learningConsent: false, provenance: { kind: 'human' }, ...overrides,
  });
}

describe('判断実例と学習同意の分離', () => {
  it('2案件の採用だけでは学習対象にならない', () => {
    let ledger = appendDecisionEvent(emptyDecisionLedger(), example());
    ledger = appendDecisionEvent(ledger, example({ id: 'd2', operationId: 'op2', projectId: 'video-b' }));
    expect(ledger.events).toHaveLength(2);
    expect(eligibleDecisionExamples(ledger)).toEqual([]);
  });

  it('同意した却下は負例として残り、保留は評価ラベルにならない', () => {
    let ledger = appendDecisionEvent(emptyDecisionLedger(), example({ decision: 'rejected', actualAfter: null, learningConsent: true }));
    ledger = appendDecisionEvent(ledger, example({ id: 'd2', operationId: 'op2', decision: 'deferred', actualAfter: null, learningConsent: true }));
    expect(eligibleDecisionExamples(ledger).map((e) => e.decision)).toEqual(['rejected']);
  });

  it('修正採用は提案と実際の本文を区別して保持する', () => {
    const e = example({ decision: 'accepted_modified', actualAfter: '素振りを行う', learningConsent: true });
    expect(eligibleDecisionExamples(appendDecisionEvent(emptyDecisionLedger(), e))[0]?.actualAfter).toBe('素振りを行う');
    expect(() => example({ actualAfter: '提案と異なる' })).toThrow();
    expect(() => example({ decision: 'rejected' })).toThrow();
  });

  it('同一操作の再送は一度だけ記録し、異なる内容は競合になる', () => {
    const e = example();
    const ledger = appendDecisionEvent(emptyDecisionLedger(), e);
    expect(appendDecisionEvent(ledger, JSON.parse(JSON.stringify(e)))).toBe(ledger);
    expect(() => appendDecisionEvent(ledger, example({ note: '変わった内容' }))).toThrow(/OPERATION_CONFLICT/);
    expect(() => appendDecisionEvent(ledger, example({ operationId: 'op2' }))).toThrow(/ID_CONFLICT/);
  });

  it('同意撤回を履歴として保存し、その後の学習から除く', () => {
    const original = example({ learningConsent: true });
    const before = appendDecisionEvent(emptyDecisionLedger(), original);
    const event = decisionEventSchema.parse({ schemaVersion: 1, type: 'withdrawal', id: 'w1', operationId: 'withdraw-1',
      createdAt: '2026-09-07T00:01:00Z', actor: { kind: 'human', id: 'local-user' }, targetId: 'd1', reason: '今回だけの修正だった' });
    const after = appendDecisionEvent(before, event);
    expect(after.events).toHaveLength(2);
    expect(eligibleDecisionExamples(after)).toEqual([]);
    expect(eligibleDecisionExamples(before)).toHaveLength(1);
    expect(() => appendDecisionEvent(emptyDecisionLedger(), event)).toThrow(/TARGET_NOT_FOUND/);
  });

  it('判断訂正は元案件・要素に紐づき、旧実例を二重集計しない', () => {
    const before = appendDecisionEvent(emptyDecisionLedger(), example({ learningConsent: true }));
    const corrected = example({ id: 'd2', operationId: 'op2', supersedes: 'd1', decision: 'rejected', actualAfter: null, learningConsent: true });
    expect(eligibleDecisionExamples(appendDecisionEvent(before, corrected)).map((e) => e.id)).toEqual(['d2']);
    expect(() => appendDecisionEvent(before, example({ id: 'd2', operationId: 'op2', supersedes: 'd1', projectId: '別案件' }))).toThrow(/TARGET_MISMATCH/);
  });

  it('AIや合成の実例を人間の較正済みラベルとして選ばない', () => {
    const e = example({ learningConsent: true, provenance: { kind: 'synthetic' } });
    const ledger = appendDecisionEvent(emptyDecisionLedger(), e);
    expect(eligibleDecisionExamples(ledger)).toEqual([]);
    expect(eligibleDecisionExamples(ledger, { includeSynthetic: true })).toHaveLength(1);
    expect(() => example({ actor: { kind: 'model', id: 'model-a' }, learningConsent: true })).toThrow();
  });

  it('未知版、不正範囲、理由なしother、不要フィールドを受け入れない', () => {
    for (const invalid of [
      { schemaVersion: 2 }, { sourceFrameRange: { start: 30, end: 0 } },
      { reasonCode: 'other', note: '' }, { unrecognizedPermission: true },
      { provenance: { kind: 'model' } }, { editKind: 'cut' },
    ]) expect(() => example(invalid)).toThrow();
  });

  it('合成の訂正で実際の人の学習例を失効させない', () => {
    const before = appendDecisionEvent(emptyDecisionLedger(), example({ learningConsent: true }));
    const synthetic = example({ id: 'synthetic', operationId: 'synthetic', supersedes: 'd1',
      decision: 'rejected', actualAfter: null, learningConsent: true, provenance: { kind: 'synthetic' } });
    const ledger = appendDecisionEvent(before, synthetic);
    expect(eligibleDecisionExamples(ledger).map((event) => event.id)).toEqual(['d1']);
    expect(eligibleDecisionExamples(ledger, { includeSynthetic: true }).map((event) => event.id)).toEqual(['synthetic']);
  });

  it('合成を挟んだ人の再訂正と同意撤回で、古い人の採用例を復活させない', () => {
    let ledger = appendDecisionEvent(emptyDecisionLedger(), example({ learningConsent: true }));
    ledger = appendDecisionEvent(ledger, example({ id: 'synthetic', operationId: 'synthetic', supersedes: 'd1',
      decision: 'rejected', actualAfter: null, learningConsent: true, provenance: { kind: 'synthetic' } }));
    ledger = appendDecisionEvent(ledger, example({ id: 'latest', operationId: 'latest', supersedes: 'synthetic',
      decision: 'rejected', actualAfter: null, learningConsent: true }));
    expect(eligibleDecisionExamples(ledger).map((event) => event.id)).toEqual(['latest']);
    ledger = appendDecisionEvent(ledger, { schemaVersion: 1, type: 'withdrawal', id: 'withdraw-latest', operationId: 'withdraw-latest',
      createdAt: '2026-09-07T00:01:00Z', actor: { kind: 'human', id: 'test' }, targetId: 'latest', reason: '今回だけ' });
    expect(eligibleDecisionExamples(ledger)).toEqual([]);
  });

  it('人が理由を選んでいない判断を、架空の言い回し意図にせず保存できる', () => {
    expect(example({ reasonCode: 'unspecified', note: '' })).toMatchObject({ reasonCode: 'unspecified' });
    expect(example({ reasonCode: 'tone', note: '' })).toMatchObject({ reasonCode: 'tone' });
  });
});
