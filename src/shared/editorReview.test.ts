import { describe, expect, it } from 'vitest';
import { decisionEventSchema, type DecisionLedger } from '../learning/preferenceDecisions';
import { editorOperationSchema, publicEditorOperation } from './editorOperations';
import { editorReviewProposal, editorReviewStatus, editorReviewTarget } from './editorReview';
import { scriptJudgmentFixture } from '../core/__fixtures__/scriptAdoption';
import { scriptApplicationRequest } from '../app/edit/scriptAdoption';

const operation = publicEditorOperation(editorOperationSchema.parse({ schemaVersion: 1, runId: 'run', serverInstance: 'server',
  createdAt: 1, updatedAt: 2, phase: 'saved', cancelRequested: false, confirmed: { applied: true, saved: true },
  claim: { sessionId: 'window', token: 'secret' }, result: { phase: 'saved', revision: 'applied', code: null, applied: true, saved: true },
  lateResult: null, humanReview: 'pending', request: { schemaVersion: 1, operationId: 'op', projectId: 'video', baseRevision: 'original',
    changes: [1, 2].map((id) => ({ type: 'set_telop_text', elementId: String(id), before: 'before', after: 'after', sourceFrameRange: { start: id * 30, end: (id + 1) * 30 } })) } }));
function judgment(index = 0, patch = {}) {
  const target = editorReviewTarget(operation, index);
  return decisionEventSchema.parse({ schemaVersion: 1, type: 'judgment', editKind: 'telop_text', id: `d${index}`, operationId: `d${index}`,
    createdAt: '2026-09-07T00:00:00Z', actor: { kind: 'human', id: 'contract-test-only' },
    proposalId: target.proposalId, projectId: target.projectId, projectRevision: target.baseRevision,
    elementId: target.change.elementId, sourceFrameRange: target.change.sourceFrameRange,
    before: target.change.before, proposedAfter: target.change.after, actualAfter: target.change.after,
    decision: 'accepted', reasonCode: 'unspecified', note: '', scope: { kind: 'project', id: 'video' },
    learningConsent: false, provenance: { kind: 'human' }, ...patch });
}
const ledger = (...events: DecisionLedger['events']): DecisionLedger => ({ schemaVersion: 1, events });
describe('実行履歴と人の判断の接続', () => {
  it('採否ごとに判断時の本文を返し、保留を確定した本文にしない', () => {
    const cases = [
      { decision: 'accepted', actualAfter: 'after', recordedText: 'after' },
      { decision: 'accepted_modified', actualAfter: 'human wording', recordedText: 'human wording' },
      { decision: 'rejected', actualAfter: null, recordedText: 'before' },
      { decision: 'deferred', actualAfter: null, recordedText: undefined },
    ];
    for (const { decision, actualAfter, recordedText } of cases) {
      const result = editorReviewStatus(operation, ledger(judgment(0, { decision, actualAfter })));
      expect(result.review.judgments[0]).toEqual(expect.objectContaining({ decision, ...(recordedText === undefined ? {} : { recordedText }) }));
      if (recordedText === undefined) expect(result.review.judgments[0]).not.toHaveProperty('recordedText');
      expect(result.confirmed).toEqual(operation.confirmed);
    }
  });
  it('marks only the exact human-modified script result as reviewed', () => {
    const event = { ...scriptJudgmentFixture(), decision: 'accepted_modified' as const,
      modification: { kind: 'caption' as const, changes: [{ telopId: 1, after: 'はい、確認しました' }] } };
    const scriptOperation = { ...operation, request: scriptApplicationRequest(event) };
    expect(editorReviewStatus(scriptOperation, ledger(event)).humanReview).toBe('pending');
    expect(editorReviewStatus(scriptOperation, ledger(event), true)).toMatchObject({ humanReview: 'reviewed', review: { synthetic: true } });
    scriptOperation.request.script!.modification = { kind: 'caption', changes: [{ telopId: 1, after: '別の内容' }] };
    expect(editorReviewStatus(scriptOperation, ledger(event), true).humanReview).toBe('pending');
  });
  it('採用は同意なしでも確認済みになり、実行・保存状態は変わらない', () => {
    const partial = editorReviewStatus(operation, ledger(judgment()));
    expect(partial.humanReview).toBe('partial'); expect(partial.review.completed).toBe(1);
    const complete = editorReviewStatus(operation, ledger(judgment(), judgment(1, { decision: 'rejected', actualAfter: null })));
    expect(complete.humanReview).toBe('reviewed'); expect(complete.confirmed).toEqual(operation.confirmed);
    expect(operation.humanReview).toBe('pending'); expect(complete.phase).toBe('saved');
  });
  it('保留・本文不一致・別案件・合成は人の確認済みにしない', () => {
    for (const patch of [{ decision: 'deferred', actualAfter: null }, { before: 'wrong' }, { projectRevision: 'wrong' },
      { proposalId: 'another-run' }, { provenance: { kind: 'synthetic' } }]) {
      expect(editorReviewStatus(operation, ledger(judgment(0, patch))).humanReview).toBe('pending');
    }
    expect(editorReviewStatus(operation, ledger(judgment(0, { provenance: { kind: 'synthetic' } })), true).review.synthetic).toBe(true);
  });
  it('学習同意の撤回で過去の採用を消さず、採否の再判断は最新を使う', () => {
    const withdrawal = decisionEventSchema.parse({ schemaVersion: 1, type: 'withdrawal', id: 'w', operationId: 'w',
      createdAt: '2026-09-07T00:01:00Z', actor: { kind: 'human', id: 'test' }, targetId: 'd0', reason: '学習に使わない' });
    expect(editorReviewStatus(operation, ledger(judgment(), withdrawal)).humanReview).toBe('partial');
    const deferred = judgment(0, { id: 'later', operationId: 'later', decision: 'deferred', actualAfter: null });
    expect(editorReviewStatus(operation, ledger(judgment(), deferred)).humanReview).toBe('pending');
  });
  it('元の提案と現在の本文を分け、移動や別案件の字幕を編集対象にしない', () => {
    const review = editorReviewTarget(operation, 0);
    const current = { projectId: 'video', projectRevision: 'now',
      elements: [{ id: '1', text: 'human edited later', sourceFrameRange: { start: 30, end: 60 } }] };
    expect(editorReviewProposal(review, current)).toMatchObject({ before: 'human edited later', after: 'after', projectRevision: 'now' });
    expect(review.change.before).toBe('before');
    expect(() => editorReviewProposal(review, { ...current, projectId: 'other' })).toThrow(/REVIEW_TARGET_CHANGED/);
    expect(() => editorReviewProposal(review, { ...current, elements: [{ ...current.elements[0]!, sourceFrameRange: { start: 31, end: 61 } }] })).toThrow(/REVIEW_TARGET_CHANGED/);
  });
});
