// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { slidesFixture } from '../../../core/slides/fixtures';
import { useSlidesSession } from './useSlidesSession';

type Reply = { status?: number; json: unknown };
const state = (revision = 0, savedRevision = revision) => ({ sessionId: 's', document: { ...slidesFixture(), revision }, savedRevision, savedContentHash: 'h',
  canUndo: false, canRedo: false, dirty: revision !== savedRevision, pageHashes: {} });
function respond(routes: Record<string, (body: unknown) => Reply | Promise<Reply>>) {
  const calls: Array<{ route: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const route = new URL(input, 'http://localhost').pathname.replace('/api/slides', ''), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ route, body });
    const handler = routes[route];
    if (!handler) throw new Error(`想定外の経路: ${route}`);
    const reply = await handler(body);
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200 });
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('useSlidesSession', () => {
  it('開くと状態を確かめてセッションを読む', async () => {
    const calls = respond({ '': () => ({ json: { status: 'saved', savedRevision: 0, contentHash: 'h' } }), '/session': () => ({ json: state() }) });
    const { result } = renderHook(() => useSlidesSession('講義'));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(calls.map(call => call.route)).toEqual(['', '/session']);
  });
  it('壊れていれば選択を待つ', async () => {
    respond({ '': () => ({ json: { status: 'broken', backupAvailable: true, preservedFiles: ['slides.v1.broken-x.json'] } }) });
    const { result } = renderHook(() => useSlidesSession('講義'));
    await waitFor(() => expect(result.current.phase).toBe('broken'));
    expect(result.current.broken).toEqual({ backupAvailable: true, preservedFiles: ['slides.v1.broken-x.json'] });
  });
  it('コマンドは最新の版で送る。応答が届かなかった時だけ同じ実行 ID で 1 回再送する', async () => {
    let failed = false;
    const calls = respond({ '': () => ({ json: { status: 'saved', savedRevision: 0, contentHash: 'h' } }), '/session': () => ({ json: state() }),
      '/command': () => { if (!failed) { failed = true; throw new TypeError('network'); } return { json: state(1, 0) }; } });
    const { result } = renderHook(() => useSlidesSession('講義'));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    await act(async () => { expect(await result.current.execute({ type: 'set-notes', pageId: 'page-1', notes: 'x' })).toBe(true); });
    const sent = calls.filter(call => call.route === '/command').map(call => call.body as { executionId: string; expectedRevision: number });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.executionId).toBe(sent[1]!.executionId);
    expect(sent[0]!.expectedRevision).toBe(0);
    expect(result.current.state?.dirty).toBe(true);
  });
  it('保存の結果が分からなかったら、次の保存で同じ保存 ID を先に照合する', async () => {
    let first = true;
    const calls = respond({ '': () => ({ json: { status: 'saved', savedRevision: 0, contentHash: 'h' } }), '/session': () => ({ json: state(1, 0) }),
      '/save': () => { if (first) { first = false; throw new TypeError('network'); } return { json: state(1, 1) }; } });
    const { result } = renderHook(() => useSlidesSession('講義'));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    await act(async () => { expect(await result.current.save()).toBe(false); });
    await act(async () => { expect(await result.current.save()).toBe(true); });
    const saves = calls.filter(call => call.route === '/save').map(call => (call.body as { executionId: string }).executionId);
    expect(saves).toHaveLength(2);
    expect(saves[0]).toBe(saves[1]);
    expect(result.current.state?.dirty).toBe(false);
  });
  it('衝突で退避したら、退避先を知らせて読み直す', async () => {
    let loads = 1;
    respond({ '': () => ({ json: { status: 'saved', savedRevision: 0, contentHash: 'h' } }), '/session': () => ({ json: state(loads++, 0) }),
      '/save': () => ({ status: 409, json: { error: '衝突', code: 'REVISION_CONFLICT', evacuatedFile: 'slides.v1.unsaved-x.json' } }) });
    const { result } = renderHook(() => useSlidesSession('講義'));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    await act(async () => { await result.current.save(); });
    await waitFor(() => expect(result.current.notice).toContain('slides.v1.unsaved-x.json'));
  });
  it('コマンドが版の衝突（409）で断られたら、最新の状態を取り直して次の編集は新しい版で送る', async () => {
    let server = 3;
    const calls = respond({ '': () => ({ json: { status: 'saved', savedRevision: 0, contentHash: 'h' } }), '/session': () => ({ json: state(1, 1) }),
      '/session/status': () => ({ json: state(server, server) }),
      '/command': body => (body as { expectedRevision: number }).expectedRevision === server ? { json: state(server + 1, server) } : { status: 409, json: { error: '版が違います', code: 'REVISION_CONFLICT' } } });
    const { result } = renderHook(() => useSlidesSession('講義'));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    await act(async () => { expect(await result.current.execute({ type: 'set-notes', pageId: 'page-1', notes: 'x' })).toBe(false); });
    await waitFor(() => expect(result.current.state?.document.revision).toBe(3));
    await act(async () => { expect(await result.current.execute({ type: 'set-notes', pageId: 'page-1', notes: 'y' })).toBe(true); });
    expect(calls.filter(call => call.route === '/command').map(call => (call.body as { expectedRevision: number }).expectedRevision)).toEqual([1, 3]);
  });
});
