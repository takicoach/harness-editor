import { judgmentSourceAllowed, supersededDecisionIds, type DecisionLedger, type JudgmentExample } from '../learning/preferenceDecisions';
import type { PreferenceProposal, PreferenceTarget } from '../learning/preferenceRules';
import type { EditorTextChange } from './editorCommands';
import type { EditorOperation, PublicEditorOperation } from './editorOperations';

export interface EditorReviewTarget {
  proposalId: string; runId: string; projectId: string; baseRevision: string; change: EditorTextChange;
}
export function editorReviewTarget(operation: Pick<EditorOperation, 'runId' | 'request'>, index: number): EditorReviewTarget {
  const change = operation.request.changes[index];
  if (!change) throw new Error('REVIEW_TARGET_MISSING: 対象の変更がありません');
  return { proposalId: `editor:${operation.runId}:${index}`, runId: operation.runId,
    projectId: operation.request.projectId, baseRevision: operation.request.baseRevision, change };
}

/** Original proposal stays historical. Only the explicitly shown current text can be edited. */
export function editorReviewProposal(review: EditorReviewTarget, current: Omit<PreferenceTarget, 'profileId'>): PreferenceProposal {
  const element = current.elements.find((entry) => entry.id === review.change.elementId);
  if (current.projectId !== review.projectId || !element
    || element.sourceFrameRange.start !== review.change.sourceFrameRange.start
    || element.sourceFrameRange.end !== review.change.sourceFrameRange.end) {
    throw new Error('REVIEW_TARGET_CHANGED: 字幕が移動・削除されています。現在の動画を確認してください');
  }
  return { projectId: current.projectId, projectRevision: current.projectRevision, elementId: element.id,
    before: element.text, after: review.change.after, sourceFrameRange: { ...element.sourceFrameRange },
    rule: { id: 'agent-review', version: 1 }, evidenceIds: [] };
}

/** Execution never changes because of adoption. Learning withdrawal does not erase a past human judgment. */
export function editorReviewStatus(operation: PublicEditorOperation, ledger: DecisionLedger, includeSynthetic = false) {
  if(operation.request.sequence)return {...operation,humanReview:'pending' as const,
    review:{completed:0,total:operation.request.sequence.commands.length,synthetic:false,judgments:operation.request.sequence.commands.map(()=>null)}};
  if (operation.request.script) {
    const judgment = ledger.events.find(e => e.id === operation.request.script!.judgmentId);
    const known = judgment?.type === 'script_judgment' && ['accepted', 'accepted_modified'].includes(judgment.decision) && judgment.actor.kind === 'human'
      && JSON.stringify(judgment.modification) === JSON.stringify(operation.request.script.modification)
      && judgment.projectId === operation.request.projectId
      && JSON.stringify(judgment.artifact) === JSON.stringify(operation.request.script.artifact)
      && !ledger.events.some(e => e.type === 'script_judgment' && e.supersedes === judgment.id
        && (e.provenance.kind === 'human' || e.provenance.kind === 'imported_human' || (includeSynthetic && e.provenance.kind === 'synthetic')))
      && (judgment.provenance.kind === 'human' || judgment.provenance.kind === 'imported_human'
        || (includeSynthetic && judgment.provenance.kind === 'synthetic'));
    return { ...operation, humanReview: known ? 'reviewed' as const : 'pending' as const,
      review: { completed: known ? 1 : 0, total: 1, synthetic: known && judgment.provenance.kind === 'synthetic',
        judgments: [known ? { id: judgment.id, decision: judgment.decision, provenance: judgment.provenance.kind } : null] } };
  }
  const eligible = ledger.events.filter((event): event is JudgmentExample => event.type === 'judgment'
    && judgmentSourceAllowed(event, includeSynthetic));
  // An excluded model/synthetic event cannot alter the production projection through supersedes either.
  const superseded = supersededDecisionIds(ledger, includeSynthetic);
  const judgments = operation.request.changes.map((_, index) => {
    const target = editorReviewTarget(operation, index);
    return eligible.filter((event) => !superseded.has(event.id)
      && event.proposalId === target.proposalId && event.projectId === target.projectId
      && event.projectRevision === target.baseRevision && event.elementId === target.change.elementId
      && event.before === target.change.before && event.proposedAfter === target.change.after
      && event.sourceFrameRange.start === target.change.sourceFrameRange.start
      && event.sourceFrameRange.end === target.change.sourceFrameRange.end).at(-1);
  });
  const completed = judgments.filter((event) => event && event.decision !== 'deferred');
  const humanReview = completed.length === 0 ? 'pending' : completed.length === judgments.length ? 'reviewed' : 'partial';
  return { ...operation, humanReview,
    review: { completed: completed.length, total: judgments.length,
      synthetic: completed.some((event) => event?.provenance.kind === 'synthetic'),
      judgments: judgments.map((event) => event ? { id: event.id, decision: event.decision, provenance: event.provenance.kind,
        ...(event.decision === 'rejected' ? { recordedText: event.before }
          : event.actualAfter !== null && event.decision !== 'deferred' ? { recordedText: event.actualAfter } : {}) } : null) },
  } as const;
}
