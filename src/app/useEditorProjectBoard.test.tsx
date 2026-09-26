/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useEditorProjectBoard } from './useEditorProjectBoard';

const item = (projectId: string, phase: 'saved' | 'unknown' = 'saved') => ({ projectId,
  editor: { connected: false, ready: false, dirty: false }, operation: { phase, updatedAt: 1, applied: phase === 'saved', saved: phase === 'saved', reconciled: false } });
const response = (items: ReturnType<typeof item>[], total: number, nextOffset: number | null) =>
  new Response(JSON.stringify({ schemaVersion: 1, items, total, nextOffset }), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('最大100件のpageを辿って全案件をprojectId mapへ入れる', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const offset = Number(new URL(String(input), 'http://localhost').searchParams.get('offset'));
    return offset === 0 ? response([item('a')], 2, 1) : response([item('b', 'unknown')], 2, null);
  }));
  const { result } = renderHook(() => useEditorProjectBoard(true));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(Object.keys(result.current.items)).toEqual(['a', 'b']);
});

it('新しい失敗で旧成功を消し、遅い旧応答を成功として着地させない', async () => {
  const pending: Array<{ resolve: (value: Response) => void; reject: (error: Error) => void }> = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }))));
  const { result } = renderHook(() => useEditorProjectBoard(true));
  await waitFor(() => expect(pending).toHaveLength(1));
  act(() => { void result.current.refresh(); });
  await waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => { pending[1]!.reject(new Error('offline')); });
  expect(result.current.status).toBe('error'); expect(result.current.items).toEqual({});
  await act(async () => { pending[0]!.resolve(response([item('stale')], 1, null)); });
  expect(result.current.status).toBe('error'); expect(result.current.items).toEqual({});
});

it('更新失敗時は直前のready表示を残さない', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(response([item('was-ready')], 1, null))
    .mockRejectedValueOnce(new Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  const { result } = renderHook(() => useEditorProjectBoard(true));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(result.current.items['was-ready']).toBeDefined();
  await act(async () => { await result.current.refresh(); });
  expect(result.current.status).toBe('error'); expect(result.current.items).toEqual({});
});

it('更新応答が期限内に返らない場合は直前のready表示を消す', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn((_input: RequestInfo | URL, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  fetchMock.mockResolvedValueOnce(response([item('was-ready')], 1, null));
  vi.stubGlobal('fetch', fetchMock);
  const { result, unmount } = renderHook(() => useEditorProjectBoard(true));
  await act(async () => { await Promise.resolve(); });
  expect(result.current.status).toBe('ready');
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(result.current.status).toBe('error');
  expect(result.current.items).toEqual({});
  unmount();
  vi.useRealTimers();
});
