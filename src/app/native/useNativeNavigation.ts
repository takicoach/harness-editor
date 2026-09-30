import {useCallback, useEffect, useRef, useState} from 'react';

/** Keep the application and event connection alive while leaving each workspace cleanly. */
export function useNativeNavigation() {
  const [projectId, setProjectId] = useState(() => new URL(location.href).searchParams.get('project'));
  const beforeLeave = useRef<null | ((nextProjectId: string | null) => Promise<boolean>)>(null);
  const current = useRef(projectId), currentUrl = useRef(location.href), pending = useRef(false);
  const move = useCallback(async (id: string | null, historyUrl?: string) => {
    if (id === current.current) return true;
    if (pending.current) { if (historyUrl) history.replaceState(null, '', currentUrl.current); return false; }
    pending.current = true;
    try {
      if (beforeLeave.current && !await beforeLeave.current(id)) {
        if (historyUrl) history.replaceState(null, '', currentUrl.current);
        return false;
      }
      const url = new URL(historyUrl ?? location.href);
      if (id) url.searchParams.set('project', id); else url.searchParams.delete('project');
      if (!historyUrl) history.pushState(null, '', url);
      current.current = id; currentUrl.current = url.href; beforeLeave.current = null;
      setProjectId(id); return true;
    } catch {
      // The workspace owns the save error; leave its fields and URL intact.
      if (historyUrl) history.replaceState(null, '', currentUrl.current);
      return false;
    } finally { pending.current = false; }
  }, []);
  useEffect(() => {
    const pop = () => { void move(new URL(location.href).searchParams.get('project'), location.href); };
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, [move]);
  return {projectId, beforeLeave, navigate:move};
}
export type NativeNavigation = ReturnType<typeof useNativeNavigation>;
