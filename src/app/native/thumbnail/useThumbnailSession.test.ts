// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { thumbnailFixture } from '../../../core/thumbnail/fixtures';
import { useThumbnailSession } from './useThumbnailSession';

// 変更の通知（サーバから届く 'thumbnail' チャネル）を試験から送れるように、購読を差し替える。
const bus = vi.hoisted(() => ({ emit: (_raw: unknown) => {} }));
vi.mock('../../eventBus', () => ({ useEventChannel: (ch: string, handler: (raw: unknown) => void) => { if (ch === 'thumbnail') bus.emit = handler; } }));

type Reply = { status?: number; json: unknown };
const state = (revision = 0, savedRevision = revision) => ({ sessionId: 's', document: { ...thumbnailFixture(), revision }, savedRevision, savedContentHash: 'h',
  canUndo: false, canRedo: false, dirty: revision !== savedRevision, pageHashes: {} });
function respond(routes: Record<string, (body: unknown) => Reply | Promise<Reply>>) {
  const calls: Array<{ route: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const route = new URL(input, 'http://localhost').pathname.replace('/api/thumbnail', ''), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ route, body });
    const handler = routes[route];
    if (!handler) throw new Error(`想定外の経路: ${route}`);
    const reply = await handler(body);
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200 });
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('useThumbnailSession', () => {
  it('使っていない間は通信しない。開くと、無ければ作る', async () => {
    const calls = respond({ '': () => ({ json: { status: 'missing', backupAvailable: false, preservedFiles: [] } }), '/create': () => ({ json: state() }) });
    const { result, rerender } = renderHook(({ active }) => useThumbnailSession('p', active, true), { initialProps: { active: false } });
    expect(calls).toEqual([]);
    rerender({ active: true });
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(calls.map(call => call.route)).toEqual(['', '/create']);
  });
  it('サムネに切り替えても、動画の文書が読み込まれるまでは何も呼ばない（移行待ち・読み込み失敗の案件でサムネのファイルを作らない）', async () => {
    const calls = respond({ '': () => ({ json: { status: 'missing', backupAvailable: false, preservedFiles: [] } }), '/create': () => ({ json: state() }) });
    const { result, rerender } = renderHook(({ open, videoReady }) => useThumbnailSession('p', open, videoReady), { initialProps: { open: true, videoReady: false } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toEqual([]);
    expect(result.current.phase).toBe('idle');
    rerender({ open: false, videoReady: true });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toEqual([]);
    rerender({ open: true, videoReady: true });
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(calls.map(call => call.route)).toEqual(['', '/create']);
  });
  it('壊れていれば選択を待つ', async () => {
    respond({ '': () => ({ json: { status: 'broken', backupAvailable: true, preservedFiles: ['thumbnail.v1.broken-x.json'] } }) });
    const { result } = renderHook(() => useThumbnailSession('p', true, true));
    await waitFor(() => expect(result.current.phase).toBe('broken'));
    expect(result.current.broken).toEqual({ backupAvailable: true, preservedFiles: ['thumbnail.v1.broken-x.json'] });
  });
  it('保存の応答が途切れたら、同じ実行 ID で再送する（受け入れ 10）', async () => {
    let attempts = 0;
    const calls = respond({ '': () => ({ json: { status: 'saved', savedRevision: 0, contentHash: 'h' } }), '/session': () => ({ json: state(1, 0) }),
      '/save': () => { attempts++; if (attempts === 1) throw new TypeError('Failed to fetch'); return { json: { ...state(1, 1), replayed: false } }; } });
    const { result } = renderHook(() => useThumbnailSession('p', true, true));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    await act(async () => { expect(await result.current.save()).toBe(false); });
    await act(async () => { expect(await result.current.save()).toBe(true); });
    const ids = calls.filter(call => call.route === '/save').map(call => (call.body as { executionId: string }).executionId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(result.current.state!.dirty).toBe(false);
  });
  it('衝突で退避したら退避先を知らせて読み直す', async () => {
    const calls = respond({ '': () => ({ json: { status: 'saved', savedRevision: 0, contentHash: 'h' } }), '/session': () => ({ json: state(1, 0) }),
      '/save': () => ({ status: 409, json: { error: '衝突', code: 'REVISION_CONFLICT', evacuatedFile: 'thumbnail.v1.unsaved-x.json' } }) });
    const { result } = renderHook(() => useThumbnailSession('p', true, true));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    await act(async () => { expect(await result.current.save()).toBe(false); });
    await waitFor(() => expect(result.current.notice).toContain('.harness/thumbnail.v1.unsaved-x.json'));
    await waitFor(() => expect(calls.filter(call => call.route === '/session')).toHaveLength(2));
  });
  it('コマンドは実行時点の最新の版で送る', async () => {
    let revision = 0;
    const calls = respond({ '': () => ({ json: { status: 'saved', savedRevision: 0, contentHash: 'h' } }), '/session': () => ({ json: state(0) }),
      '/command': () => ({ json: state(++revision, 0) }) });
    const { result } = renderHook(() => useThumbnailSession('p', true, true));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    await act(async () => { await Promise.all([result.current.execute({ type: 'undo' }), result.current.execute({ type: 'redo' })]); });
    expect(calls.filter(call => call.route === '/command').map(call => (call.body as { expectedRevision: number }).expectedRevision)).toEqual([0, 1]);
  });
  it('変更の通知が続けて届いて状態の取得が重なっても、最後の版まで追い付く（先に返った取得で後の取得を捨てない）', async () => {
    const gate = () => { let resolve!: (reply: Reply) => void; const promise = new Promise<Reply>(done => { resolve = done; }); return { promise, resolve }; };
    const gates = [gate(), gate()];
    let statusCalls = 0;
    respond({ '': () => ({ json: { status: 'saved', savedRevision: 0, contentHash: 'h' } }), '/session': () => ({ json: state(0, 0) }),
      '/session/status': () => gates[statusCalls++]?.promise ?? { json: state(2, 0) } });
    const { result } = renderHook(() => useThumbnailSession('p', true, true));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    // 外から版 1 → 版 2 と続けて書かれ、通知が 2 回届く。
    act(() => { bus.emit({ type: 'change' }); bus.emit({ type: 'change' }); });
    await act(async () => { gates[0]!.resolve({ json: state(1, 0) }); });
    await waitFor(() => expect(result.current.state?.document.revision).toBeGreaterThanOrEqual(1));
    // 2 回目の取得が出ていれば（重なっていても、あとから出し直されても）、その応答で版 2 になる。
    await waitFor(() => expect(statusCalls).toBeGreaterThanOrEqual(2));
    await act(async () => { gates[1]!.resolve({ json: state(2, 0) }); });
    await waitFor(() => expect(result.current.state?.document.revision).toBe(2));
  });
});
