import { useRef } from 'react';
import { flushSync } from 'react-dom';
import type { EditSession } from './useEditSession';
import { createEditorCommandSession, type LiveEditorSnapshot } from './edit/editorCommandSession';
import { applyEditorChanges } from './edit/editorCommands';
import { isAgentEditBlocked } from './isModalOpen';

/** One live browser session: typed requests share the normal editor's history and guarded save. */
export function useEditorCommandBridge(session: EditSession | null, projectId: string | null) {
  const epoch = useRef({ id: crypto.randomUUID(), count: 0, state: session?.state, projectId });
  if (epoch.current.state !== session?.state || epoch.current.projectId !== projectId) {
    epoch.current = { ...epoch.current, count: epoch.current.count + 1, state: session?.state, projectId };
  }
  const revision = `${epoch.current.id}:${epoch.current.count}`;
  const live = useRef({ session, projectId, revision });
  live.current = { session, projectId, revision };
  const bridge = useRef<ReturnType<typeof createEditorCommandSession> | null>(null);
  const read = (): LiveEditorSnapshot | null => {
    const current = live.current;
    if (!current.session || !current.projectId) return null;
    return { projectId: current.projectId, revision: current.revision, state: current.session.state,
      dirty: current.session.dirty, saving: current.session.saveStatus === 'saving', humanBusy: isAgentEditBlocked() };
  };
  if (bridge.current === null) bridge.current = createEditorCommandSession({
    read,
    apply: (request) => {
      const captured = live.current;
      if (!captured.session || !captured.projectId) throw new Error('EDITOR_UNAVAILABLE: 案件を開いてください');
      const context = { projectId: captured.projectId, revision: captured.revision };
      flushSync(() => captured.session!.apply((state) => {
        if (state !== captured.session!.state) throw new Error('REVISION_CONFLICT: 編集状態が変わりました');
        return applyEditorChanges(state, context, request);
      }));
    },
    save: async (expectedState, delivery) => {
      const current = live.current.session;
      if (!current) throw new Error('EDITOR_UNAVAILABLE: 編集画面が閉じられました');
      return current.save({ expectedState, delivery }); // Never call saveOverwrite from an agent delivery.
    },
  });
  return { sessionId: epoch.current.id, revision, read, apply: bridge.current.apply, save: bridge.current.save, hasApplied: bridge.current.hasApplied };
}
