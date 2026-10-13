// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { THUMBNAIL_AI_STATUS_LABEL, type ThumbnailAiLatest, type ThumbnailAiRequest, type ThumbnailAiStatus } from '../../../shared/thumbnailAi';
import { THUMBNAIL_AI_IDLE_POLL_MS, THUMBNAIL_AI_POLL_MS, THUMBNAIL_AI_STALE_MS, useThumbnailAi } from './useThumbnailAi';

/** 端末から直接頼まれた依頼（受け箱の記録なし）。状態は phase か確定の結果で決まる。 */
const direct = (status: ThumbnailAiStatus, updatedAt = new Date().toISOString()): ThumbnailAiLatest => ({
  status, label: THUMBNAIL_AI_STATUS_LABEL[status], message: null,
  request: { requestId: 'd-1', route: 'direct', projectId: 'p', documentId: 'doc', kind: 'new', targetPageId: null, targetPageName: null, targetFingerprint: null, cutout: 'auto', note: '',
    phase: status === 'reviewing' ? 'reviewing' : 'working', frames: [], nextFrame: 1, previews: 0, apply: null, createdAt: updatedAt, updatedAt } satisfies ThumbnailAiRequest,
});
const NONE: ThumbnailAiLatest = { request: null, status: null, label: null, message: null };

/** サーバの代わり。照会の返事は server.latest、回数は server.polls に数える。 */
function stubServer(initial: ThumbnailAiLatest) {
  const server = { latest: initial, polls: 0, hold: null as null | Promise<void>, post: null as null | ThumbnailAiLatest };
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/ai/presence') return new Response(JSON.stringify({ terminal: 'running', tool: 'claude', mcp: true, connected: true, focus: {} }));
    if (url.pathname === '/api/ai/thumbnail-requests' && init?.method === 'POST') return new Response(JSON.stringify(server.post));
    if (url.pathname === '/api/ai/thumbnail-requests') {
      server.polls += 1;
      const snapshot = server.latest, hold = server.hold;
      if (hold) await hold;
      return new Response(JSON.stringify(snapshot));
    }
    throw new Error(`想定外の経路: ${url.pathname}`);
  }));
  return server;
}
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('useThumbnailAi: 状態の表示', () => {
  it('依頼が 1 件も無い欄でも、端末から直接の依頼が始まれば拾い、作業中 → 確認中 → 完了と追う', async () => {
    const server = stubServer(NONE);
    const { result } = renderHook(() => useThumbnailAi('p'));
    await tick(0);
    expect(result.current.latest?.status).toBeNull();
    server.latest = direct('working');
    await tick(THUMBNAIL_AI_IDLE_POLL_MS);
    expect(result.current.latest?.status).toBe('working');
    server.latest = direct('reviewing');
    await tick(THUMBNAIL_AI_POLL_MS);
    expect(result.current.latest?.status).toBe('reviewing');
    server.latest = { ...direct('working'), status: 'done', label: THUMBNAIL_AI_STATUS_LABEL.done };
    await tick(THUMBNAIL_AI_POLL_MS);
    expect(result.current.latest?.status).toBe('done');
  });
  it('直前が「完了」のままでも、続けて端末から直接頼んだ依頼を拾う', async () => {
    const server = stubServer({ ...direct('working'), status: 'done', label: THUMBNAIL_AI_STATUS_LABEL.done });
    const { result } = renderHook(() => useThumbnailAi('p'));
    await tick(0);
    expect(result.current.latest?.status).toBe('done');
    server.latest = { ...direct('working'), request: { ...direct('working').request!, requestId: 'd-2' } };
    await tick(THUMBNAIL_AI_IDLE_POLL_MS);
    expect(result.current.latest).toMatchObject({ status: 'working', request: { requestId: 'd-2' } });
  });
  it('動いている依頼は 2 秒ごと、動いていない間は 5 秒ごと。動きが止まった未確定の依頼で 2 秒の照会を続けない', async () => {
    const server = stubServer(direct('working'));
    renderHook(() => useThumbnailAi('p'));
    await tick(0);
    const start = server.polls;
    await tick(THUMBNAIL_AI_IDLE_POLL_MS);
    expect(server.polls - start).toBe(2);
    server.latest = direct('working', new Date(Date.now() - THUMBNAIL_AI_STALE_MS - 1000).toISOString());
    await tick(THUMBNAIL_AI_POLL_MS);
    await tick(THUMBNAIL_AI_POLL_MS);
    const settled = server.polls;
    await tick(THUMBNAIL_AI_IDLE_POLL_MS * 2);
    expect(server.polls - settled).toBe(2);
  });
  it('照会の返事を待つ間にボタンの依頼が返ってきたら、古い返事で上書きしない', async () => {
    const server = stubServer(NONE);
    const { result } = renderHook(() => useThumbnailAi('p'));
    await tick(0);
    let release = () => {};
    server.hold = new Promise<void>(resolve => { release = resolve; });
    await tick(THUMBNAIL_AI_IDLE_POLL_MS);
    server.post = { ...direct('working'), status: 'pending', label: THUMBNAIL_AI_STATUS_LABEL.pending };
    await act(async () => { await result.current.send({ kind: 'new', pageId: null, cutout: 'auto', note: '' }); });
    expect(result.current.latest?.status).toBe('pending');
    release(); server.hold = null;
    await tick(0);
    expect(result.current.latest?.status).toBe('pending');
  });
});
