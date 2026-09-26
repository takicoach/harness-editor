import { useEffect, useRef } from 'react';

type EditorOpenStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Home の「変更を確認」リンクだけを、初回の確認画面要求として受け付ける。 */
export function requestedAgentActivityProject(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get('agentActivity') !== 'review') return null;
  const projectId = params.get('project');
  return projectId !== null && projectId !== '' ? projectId : null;
}

/**
 * 初回 URL が指す実在案件の読込完了後に、AI 作業の確認画面を一度だけ開く。
 * 一覧外 ID は破棄し、別案件へ移った後に同じ ID を開いても遅れて発火させない。
 */
export function useInitialAgentActivity(
  requestedProjectId: string | null,
  projectKnown: boolean | null,
  selectedProjectId: string | null,
  openStatus: EditorOpenStatus,
  onOpen: () => void,
): void {
  const pendingRef = useRef(requestedProjectId);
  const sawRequestedProjectRef = useRef(false);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const requested = pendingRef.current;
    if (requested === null) return;
    if (projectKnown === false) {
      pendingRef.current = null;
      return;
    }
    if (projectKnown !== true) return;

    if (selectedProjectId === requested) {
      sawRequestedProjectRef.current = true;
      if (openStatus === 'ready') {
        pendingRef.current = null;
        onOpenRef.current();
      }
      return;
    }

    // 読込中にホームへ戻った場合や別案件を選んだ場合は、初回要求を持ち越さない。
    if (sawRequestedProjectRef.current || selectedProjectId !== null) pendingRef.current = null;
  }, [openStatus, projectKnown, selectedProjectId]);
}
