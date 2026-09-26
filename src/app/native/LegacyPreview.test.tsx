/** @vitest-environment jsdom */
import { createRef, StrictMode } from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { EditorProject } from '../../core/types';
import type { NativePreviewHandle, NativePreviewProps } from './NativePreview';
import { LegacyPreview } from './LegacyPreview';
import { useLegacyPreview, type LegacyPreviewState } from './useLegacyPreview';

const native = vi.hoisted(() => ({ render: vi.fn(), seek: vi.fn() }));
vi.mock('./NativePreview', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return { NativePreview: forwardRef((props: NativePreviewProps, ref) => {
    native.render(props); useImperativeHandle(ref, () => ({ seek: native.seek })); return <div>native ready</div>;
  }) };
});
vi.mock('../../core/sequence/legacyPreview', () => ({
  legacyPreviewReferences: (p: EditorProject) => ({ main: p.videoConfig.videoFile }),
  legacyPreviewResourceKey: JSON.stringify,
  projectLegacyPreview: (_p: EditorProject, _catalog: unknown, id: string, revision: number) => ({ document: { id, revision }, notices: [] }),
}));
const project = { videoConfig: { videoFile: 'A.mp4' } } as EditorProject;
const body = (token: string) => ({ ok: true, json: async () => ({ token, catalog: {} }) });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('never mounts native without a ready lease, exposes failure retry, and forwards frame/seek unchanged', async () => {
  let finish!: (response: unknown) => void;
  const fetcher = vi.fn((_url: string, options?: RequestInit) => options?.method === 'POST'
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  const ref = createRef<NativePreviewHandle>(), onFrame = vi.fn();
  function Host() { const preview = useLegacyPreview('legacy', project, 0); return <LegacyPreview ref={ref} preview={preview} onFrame={onFrame} initialFrame={20} bypassLut={false}/>; }
  const view = render(<Host/>);
  expect(view.getByRole('status').textContent).toContain('準備中'); expect(native.render).not.toHaveBeenCalled(); expect(ref.current).toBeNull();
  await act(async () => finish({ ok: false, json: async () => ({ error: '準備失敗' }) }));
  expect(view.getByRole('alert').textContent).toContain('プレビューを準備できませんでした');
  expect(view.getByRole('alert').textContent).toContain('編集内容は失われていません');
  const detail = view.container.querySelector('details');
  expect(detail?.open).toBe(false); expect(detail?.textContent).toContain('準備失敗');
  expect(native.render).not.toHaveBeenCalled();
  await act(async () => view.getByRole('button', { name: '素材を再読み込み' }).click());
  await act(async () => finish(body('lease-A')));
  expect(native.render.mock.lastCall![0]).toMatchObject({ projectId: 'legacy', legacyContext: 'lease-A', initialFrame: 20, onFrame });
  ref.current!.seek(27); expect(native.seek).toHaveBeenCalledWith(27);
});

it('reports expiry and only retries after a user click; ordinary errors do not reload', async () => {
  let preparations = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => options?.method === 'POST' ? body(`lease-${++preparations}`) : { ok: true }));
  const onError = vi.fn();
  function Host() { return <LegacyPreview preview={useLegacyPreview('legacy', project, 0)} onFrame={() => {}} bypassLut={false} onError={onError}/>; }
  const view = render(<Host/>); await waitFor(() => expect(native.render).toHaveBeenCalled());
  await act(async () => native.render.mock.lastCall![0].onError({ kind: 'render', message: 'decode failed' }));
  expect(view.queryByRole('button')).toBeNull(); expect(preparations).toBe(1);
  await act(async () => native.render.mock.lastCall![0].onError({ kind: 'context-unavailable', message: 'expired', status: 404, resource: 'component' }));
  expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'context-unavailable' }));
  expect(preparations).toBe(1);
  await act(async () => view.getByRole('button', { name: '素材を再読み込み' }).click());
  await waitFor(() => expect(native.render.mock.lastCall![0].legacyContext).toBe('lease-2'));
  expect(preparations).toBe(2); expect(view.queryByRole('button')).toBeNull();
});

it('rejects released A on A→B→A, including a late completion, and does not prepare for text edits', async () => {
  const pending: Array<(response: unknown) => void> = [];
  const fetcher = vi.fn((_url: string, options?: RequestInit) => options?.method === 'POST' ? new Promise(resolve => pending.push(resolve)) : Promise.resolve({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  const hook = renderHook(({ project }) => useLegacyPreview('legacy', project, 0), { initialProps: { project } });
  await act(async () => pending[0]!(body('A-old'))); expect(hook.result.current.status).toBe('ready');
  hook.rerender({ project: { ...project, videoConfig: { ...project.videoConfig, videoFile: 'B.mp4' } } });
  expect(hook.result.current.status).toBe('pending');
  hook.rerender({ project }); expect(hook.result.current.status).toBe('pending'); expect(hook.result.current.legacyContext).toBeUndefined();
  await act(async () => pending[1]!(body('B-late'))); expect(hook.result.current.status).toBe('pending');
  await act(async () => pending[2]!(body('A-new'))); expect(hook.result.current.legacyContext).toBe('A-new');
  hook.rerender({ project: { ...project, telops: [] } }); expect(pending).toHaveLength(3);
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'DELETE').map(([url]) => url)).toEqual(expect.arrayContaining([
    expect.stringContaining('context=A-old'), expect.stringContaining('context=B-late'),
  ]));
});

it('StrictMode preparation cleanup cannot adopt its late lease', async () => {
  const pending: Array<(response: unknown) => void> = [];
  vi.stubGlobal('fetch', vi.fn((_url: string, options?: RequestInit) => options?.method === 'POST' ? new Promise(resolve => pending.push(resolve)) : Promise.resolve({ ok: true })));
  const hook = renderHook(() => useLegacyPreview('legacy', project, 0), { wrapper: StrictMode });
  expect(pending).toHaveLength(2);
  await act(async () => pending[1]!(body('current')));
  await act(async () => pending[0]!(body('released')));
  expect(hook.result.current.legacyContext).toBe('current');
});

it.each([404, 500, 'network'] as const)('heartbeat %s fails visibly without automatic preparation loops', async status => {
  vi.useFakeTimers(); let posts = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return body(`lease-${++posts}`);
    if (status === 'network') throw new TypeError('Failed to fetch');
    return { ok: false, status };
  }));
  const hook = renderHook(() => useLegacyPreview('legacy', project, 0));
  await act(async () => {}); expect(hook.result.current.status).toBe('ready');
  await act(async () => vi.advanceTimersByTimeAsync(40 * 60 * 1000));
  expect(hook.result.current.status).toBe('failed'); expect(hook.result.current.document).toBeNull(); expect(posts).toBe(1);
});

// Compile-time contract: callers must narrow the hook state before using native.
function readyContract(state: LegacyPreviewState) {
  // @ts-expect-error A pending/failed draft cannot be passed to NativePreview.
  const unsafe: Pick<NativePreviewProps, 'document'> = state;
  void unsafe;
  if (state.status === 'ready') {
    const ready: Pick<NativePreviewProps, 'document'> & { legacyContext: string } = state;
    return ready;
  }
  return null;
}
void readyContract;
