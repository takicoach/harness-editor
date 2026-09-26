import { useCallback, useEffect, useRef, useState } from 'react';
import { editorProjectBoardPageSchema, type EditorProjectBoardItem } from '../shared/editorBoard';
import { extractErrorMessage } from './fetchJson';

export interface EditorProjectBoardState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: Record<string, EditorProjectBoardItem>;
  error: string | null;
  refresh(): Promise<void>;
}

const EMPTY: Pick<EditorProjectBoardState, 'items' | 'error'> = { items: {}, error: null };
const BOARD_REQUEST_TIMEOUT_MS = 4000;

async function readPage(offset: number, signal: AbortSignal) {
  const url = `/api/editor/board?offset=${offset}&limit=100`;
  const response = await fetch(url, { signal });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(extractErrorMessage(body));
  return editorProjectBoardPageSchema.parse(body);
}

export function useEditorProjectBoard(enabled: boolean): EditorProjectBoardState {
  const [state, setState] = useState<Omit<EditorProjectBoardState, 'refresh'>>({ status: enabled ? 'loading' : 'idle', ...EMPTY });
  const generation = useRef(0); const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const current = ++generation.current;
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    setState((previous) => previous.status === 'ready' ? previous : { status: 'loading', ...EMPTY });
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      request.abort();
    }, BOARD_REQUEST_TIMEOUT_MS);
    try {
      const items: EditorProjectBoardItem[] = []; let offset = 0; let expectedTotal: number | null = null;
      const offsets = new Set<number>();
      for (;;) {
        if (offsets.has(offset)) throw new Error('案件状態の続き位置が循環しています');
        offsets.add(offset);
        const page = await readPage(offset, request.signal);
        if (expectedTotal === null) expectedTotal = page.total;
        else if (page.total !== expectedTotal) throw new Error('案件状態が取得中に変わりました');
        items.push(...page.items);
        if (page.nextOffset === null) break;
        if (page.nextOffset <= offset || page.nextOffset > page.total) throw new Error('案件状態の続き位置が不正です');
        offset = page.nextOffset;
      }
      if (items.length !== expectedTotal || new Set(items.map((item) => item.projectId)).size !== items.length) {
        throw new Error('案件状態の件数が一致しません');
      }
      if (!mounted.current || current !== generation.current) return;
      setState({ status: 'ready', items: Object.fromEntries(items.map((item) => [item.projectId, item])), error: null });
    } catch (error) {
      if (!mounted.current || current !== generation.current || (request.signal.aborted && !timedOut)) return;
      setState({
        status: 'error',
        items: {},
        error: timedOut ? '案件状態の応答がありません' : error instanceof Error ? error.message : String(error),
      });
    } finally {
      window.clearTimeout(timeout);
    }
  }, [enabled]);
  useEffect(() => {
    mounted.current = true;
    if (!enabled) {
      generation.current += 1; controller.current?.abort(); controller.current = null;
      setState({ status: 'idle', ...EMPTY }); return;
    }
    void refresh(); const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => { mounted.current = false; generation.current += 1; controller.current?.abort(); window.clearInterval(timer); };
  }, [enabled, refresh]);
  return { ...state, refresh };
}
