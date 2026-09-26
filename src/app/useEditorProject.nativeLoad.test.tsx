/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEditorProject } from './useEditorProject';

const watch = vi.hoisted(() => ({ change: () => {} }));
vi.mock('./useProjectWatch', () => ({ useProjectWatch: (_id: string | null, change: () => void) => { watch.change = change; } }));
const pending: { url: string; resolve(response: Response): void }[] = [];
const response = (name: string) => new Response(JSON.stringify({ project: { telopDataSource: name }, validation: {}, save: {}, seLibrary: [], imageLibrary: [], videoLibrary: [], bgmLibrary: [], assetVersions: {} }));
const settle = async (index: number, name: string) => act(async () => { pending[index]!.resolve(response(name)); });
beforeEach(() => {
  pending.length = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/projects'
    ? Promise.resolve(new Response(JSON.stringify({ root: '/tmp', projects: [] })))
    : url.startsWith('/api/project?id=')
      ? new Promise<Response>(resolve => pending.push({ url, resolve }))
      : Promise.reject(new Error(`Legacy component request forbidden: ${url}`))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('opens from project JSON alone and keeps the successful revision stable through ordinary renders and library updates', async () => {
  const { result, rerender } = renderHook(() => useEditorProject());
  act(() => result.current.selectProject('A'));
  await settle(0, 'A');
  expect(result.current.open.status).toBe('ready');
  const revision = result.current.open.componentRevision;
  expect(revision).toBeTruthy();
  rerender();
  act(() => result.current.patchLibraries({ seLibrary: [], imageLibrary: ['new.png'], videoLibrary: [], bgmLibrary: [], assetVersions: {} }));
  expect(result.current.open.componentRevision).toBe(revision);
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/api/projects', '/api/project?id=A']);
});

it('retires both old project and same-project reload responses, even across A → B → A', async () => {
  const { result } = renderHook(() => useEditorProject());
  act(() => result.current.selectProject('A'));
  act(() => result.current.selectProject('B'));
  act(() => result.current.selectProject('A'));
  await settle(2, 'latest A');
  const revision = result.current.open.componentRevision;
  await settle(0, 'old A'); await settle(1, 'old B');
  expect(result.current.open.project?.telopDataSource).toBe('latest A');
  expect(result.current.open.componentRevision).toBe(revision);
  act(() => result.current.reload());
  act(() => result.current.reload());
  await settle(4, 'latest reload');
  const reloaded = result.current.open.componentRevision;
  expect(reloaded).not.toBe(revision);
  await settle(3, 'old reload');
  expect(result.current.open.project?.telopDataSource).toBe('latest reload');
  expect(result.current.open.componentRevision).toBe(reloaded);
});

it('waits for an accepted reload after SSE, preserving the dirty snapshot until then', async () => {
  const { result } = renderHook(() => useEditorProject());
  act(() => result.current.selectProject('A')); await settle(0, 'A');
  const revision = result.current.open.componentRevision;
  act(() => watch.change());
  expect(result.current.externallyChanged).toBe(true);
  act(() => { expect(result.current.reloadIfSafe('A', true)).toBe(false); });
  expect(result.current.open.componentRevision).toBe(revision);
  expect(pending).toHaveLength(1);
  act(() => { expect(result.current.reloadIfSafe('A', false)).toBe(true); });
  await settle(1, 'updated A');
  expect(result.current.externallyChanged).toBe(false);
  expect(result.current.open.componentRevision).not.toBe(revision);
});

it('surfaces project API failure without a revision and discards responses after Home', async () => {
  const { result } = renderHook(() => useEditorProject());
  act(() => result.current.selectProject('A'));
  await settle(0, 'A');
  expect(result.current.open.componentRevision).toBeTruthy();
  act(() => result.current.reload());
  expect(result.current.open.componentRevision).toBeNull();
  await act(async () => { pending[1]!.resolve(new Response(JSON.stringify({ error: 'project source unreadable' }), { status: 500 })); });
  expect(result.current.open.status).toBe('error');
  expect(result.current.open.error).toBe('project source unreadable');
  expect(result.current.open.componentRevision).toBeNull();
  act(() => result.current.reload()); act(() => result.current.goHome());
  await settle(2, 'late A');
  expect(result.current.open.status).toBe('idle');
  expect(result.current.open.componentRevision).toBeNull();
});
