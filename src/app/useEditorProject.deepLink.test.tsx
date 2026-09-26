/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useEditorProject } from './useEditorProject';

class FakeEventSource { close() {} }
const project = { id: 'known', name: 'known', dir: '/tmp/known', orientation: 'v', durationLabel: '1:00',
  sizeLabel: '1 MB', videoFile: null, status: 'idle' };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

it('初回project queryが実一覧にあるときだけ、その動画の読込を開始する', async () => {
  window.history.replaceState(null, '', '/?project=known'); vi.stubGlobal('EventSource', FakeEventSource);
  const fetchMock = vi.fn((input: RequestInfo | URL) => String(input) === '/api/projects'
    ? Promise.resolve(new Response(JSON.stringify({ root: '/tmp', projects: [project] }), { status: 200 }))
    : new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetchMock);
  const { result } = renderHook(() => useEditorProject());
  await waitFor(() => expect(result.current.selectedId).toBe('known'));
  expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/project?id=known')).toBe(true);
  expect(fetchMock.mock.calls.every((call) => call.length === 1)).toBe(true);
  act(() => result.current.goHome());
  expect(result.current.selectedId).toBeNull();
  expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/project?id=known')).toHaveLength(1);
});

it('未知project queryは開かず、ホームに説明を残す', async () => {
  window.history.replaceState(null, '', '/?project=missing'); vi.stubGlobal('EventSource', FakeEventSource);
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ root: '/tmp', projects: [project] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const { result } = renderHook(() => useEditorProject());
  await waitFor(() => expect(result.current.projectsLoading).toBe(false));
  expect(result.current.selectedId).toBeNull();
  expect(result.current.projectsError).toBeNull();
  expect(result.current.initialProjectNotice).toMatch(/URL.*一覧/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
