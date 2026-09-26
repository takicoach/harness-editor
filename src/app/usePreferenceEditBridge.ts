import { useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { PreferenceProposal, PreferenceTarget } from '../learning/preferenceRules';
import type { EditSession } from './useEditSession';
import { applyPreferenceEdit } from './edit/preferenceEdit';
import { putJsonPost } from './fetchJson';

/** Shares the editor's live session, undo stack and save path. No project file writes or second editor state. */
export function usePreferenceEditBridge(session: EditSession | null, projectId: string | null) {
  const epoch = useRef({ id: crypto.randomUUID(), counter: 0, sessionState: session?.state, projectId });
  if (epoch.current.sessionState !== session?.state || epoch.current.projectId !== projectId) {
    epoch.current = { ...epoch.current, counter: epoch.current.counter + 1, sessionState: session?.state, projectId };
  }
  const projectRevision = `${epoch.current.id}:${epoch.current.counter}`;
  const live = useRef({ session, projectId, projectRevision });
  live.current = { session, projectId, projectRevision };

  const target = useCallback((): Omit<PreferenceTarget, 'profileId'> => {
    const current = live.current;
    if (!current.session || !current.projectId) throw new Error('案件を開いてください');
    return { projectId: current.projectId, projectRevision: current.projectRevision,
      elements: current.session.state.telops.filter((t) => t.text.length > 0).map((t) => ({ id: String(t.id), text: t.text,
        sourceFrameRange: { start: t.originalStart, end: t.originalEnd } })) };
  }, []);
  const apply = useCallback(async (proposal: PreferenceProposal, after: string, validateRule: boolean): Promise<void> => {
    const captured = live.current;
    if (!captured.session || !captured.projectId) throw new Error('案件を開いてください');
    const context = { projectId: captured.projectId, projectRevision: captured.projectRevision };
    applyPreferenceEdit(captured.session.state, proposal, context, after); // Validate before any network or UI mutation.
    if (validateRule) await putJsonPost('/api/preferences/validate', { target: target(), proposal });
    if (live.current.session?.state !== captured.session.state || live.current.projectId !== captured.projectId) {
      throw new Error('編集状態が変わりました。字幕の提案を更新してください');
    }
    // Recording approval of an already applied AI edit must not add a duplicate Undo entry or dirty state.
    if (proposal.before === after) return;
    // Commit before recording an accepted judgment; a rejected/stale edit must never become a learning example.
    flushSync(() => captured.session!.apply((prev) => prev === captured.session!.state
      ? applyPreferenceEdit(prev, proposal, context, after) : prev));
    const applied = live.current.session?.state.telops.find((t) => String(t.id) === proposal.elementId);
    if (live.current.projectId !== proposal.projectId || applied?.text !== after
      || applied.originalStart !== proposal.sourceFrameRange.start || applied.originalEnd !== proposal.sourceFrameRange.end) {
      throw new Error('字幕へ反映できませんでした。現在の編集内容を確認してください');
    }
  }, [target]);
  return { projectRevision, target, apply };
}
