import type { PreferenceProposal } from '../../learning/preferenceRules';
import type { EditState } from './editState';
import { setTelopText } from './textOps';

/** Shared UI edit operation. A matching ID alone cannot authorize changing a moved or edited subtitle. */
export function applyPreferenceEdit(state: EditState, proposal: PreferenceProposal,
  context: { projectId: string; projectRevision: string }, after = proposal.after): EditState {
  if (proposal.projectId !== context.projectId || proposal.projectRevision !== context.projectRevision) {
    throw new Error('STALE_PROPOSAL: 案件か編集状態が変わりました。提案を更新してください');
  }
  const telop = state.telops.find((t) => String(t.id) === proposal.elementId);
  if (!telop || telop.text !== proposal.before || telop.originalStart !== proposal.sourceFrameRange.start
    || telop.originalEnd !== proposal.sourceFrameRange.end) throw new Error('STALE_PROPOSAL: 字幕の本文か範囲が変わりました。提案を更新してください');
  if (!after.trim() || after.length > 10000) throw new Error('INVALID_TEXT: 字幕の本文を入力してください');
  return setTelopText(state, telop.id, after);
}
