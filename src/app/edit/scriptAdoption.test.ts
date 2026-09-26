import { describe, expect, it } from 'vitest';
import { scriptJudgmentFixture } from '../../core/__fixtures__/scriptAdoption';
import { latestScriptJudgment, readScriptApplicationReceipt, scriptApplicationRequest } from './scriptAdoption';

describe('script judgment and execution binding', () => {
  it('refuses a receipt for another human correction despite the same original AI proposal', () => {
    const event = { ...scriptJudgmentFixture(), decision: 'accepted_modified' as const,
      modification: { kind: 'caption' as const, changes: [{ telopId: 1, after: 'はい、確認しました' }] } };
    const request = scriptApplicationRequest(event);
    const receipt = { runId: 'run', request, phase: 'running', result: null, confirmed: { applied: false, saved: false } };
    expect(readScriptApplicationReceipt(receipt, event).request.script?.modification).toEqual(event.modification);
    const wrong = structuredClone(receipt);
    wrong.request.script!.modification = { kind: 'caption', changes: [{ telopId: 1, after: '別の修正です' }] };
    expect(() => readScriptApplicationReceipt(wrong, event)).toThrow();
  });
  it('rebinds a browser revision after reload while retaining one operation ID and identical content', () => {
    const event = scriptJudgmentFixture();
    const original = scriptApplicationRequest(event);
    const rebound = scriptApplicationRequest(event, 'reloaded:1');
    expect(rebound).toEqual({ ...original, baseRevision: 'reloaded:1' });
    const value = { runId: 'run', request: rebound, phase: 'running', result: null, confirmed: { applied: false, saved: false } };
    expect(readScriptApplicationReceipt(value, event).request).toEqual(rebound);
    expect(() => readScriptApplicationReceipt({ ...value, request: { ...rebound, operationId: 'another' } }, event)).toThrow();
  });
  it('does not treat a 2xx object or incomplete applied result as successful saving', () => {
    const event = scriptJudgmentFixture(), request = scriptApplicationRequest(event);
    expect(() => readScriptApplicationReceipt({ ok: true }, event)).toThrow();
    expect(() => readScriptApplicationReceipt({ runId: 'run', request, phase: 'saved', result: null,
      confirmed: { applied: true, saved: false } }, event)).toThrow();
  });
  it('uses the latest judgment without confusing learning withdrawal with edit rejection', () => {
    const first = scriptJudgmentFixture();
    const corrected = { ...first, id: 'new', operationId: 'new-record', supersedes: first.id, decision: 'rejected' as const };
    const ledger = { schemaVersion: 1 as const, events: [first, corrected] };
    expect(latestScriptJudgment(ledger, first.artifact)?.id).toBe('new');
    expect(latestScriptJudgment({ ...ledger, events: [...ledger.events, { schemaVersion: 1, type: 'withdrawal', id: 'withdraw',
      operationId: 'withdraw-op', createdAt: first.createdAt, actor: first.actor, targetId: corrected.id, reason: 'fixture withdrawal' }] }, first.artifact)?.id).toBe('new');
  });
  it('never inherits approval for another model proposal with the same input and proposal ID', () => {
    const event = scriptJudgmentFixture();
    const different = structuredClone(event.artifact);
    different.proposal.generator.model = 'another-model';
    expect(latestScriptJudgment({ schemaVersion: 1, events: [event] }, different)).toBeNull();
  });
});
