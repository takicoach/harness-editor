/**
 * @vitest-environment jsdom
 */
/**
 * useAgentConnected フックのユニットテスト。
 * useHeavyJobConfirm.test.ts の流儀（renderHook + jsdom、fetch モック）を踏襲する。
 * projectId 未指定は従来通り（dedicated 常に null）、指定時は `?id=` 付きで叩き
 * 応答の dedicated.connected を返すことを検証する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAgentConnected } from './useAgentConnected';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAgentConnected', () => {
  it('active=false のときは fetch せず global/dedicated とも null のまま', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAgentConnected(false));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toEqual({ global: null, dedicated: null });
  });

  it('projectId 未指定は従来通り /api/agent-status を叩き、dedicated は常に null', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ connected: true, waiting: 1, lastPollAt: Date.now(), processing: false }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAgentConnected(true));

    await waitFor(() => {
      expect(result.current.global).toBe(true);
    });
    expect(result.current.dedicated).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/agent-status');
  });

  it('projectId 指定時は ?id= 付きで叩き、応答の dedicated.connected を返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        connected: false,
        waiting: 0,
        lastPollAt: null,
        processing: false,
        dedicated: { connected: true },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAgentConnected(true, 'sample-project'));

    await waitFor(() => {
      expect(result.current.dedicated).toBe(true);
    });
    expect(result.current.global).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('/api/agent-status?id=sample-project');
  });

  it('projectId 指定時、応答に dedicated フィールドが無ければ dedicated は false', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ connected: true, waiting: 0, lastPollAt: null, processing: false }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAgentConnected(true, 'p1'));

    await waitFor(() => {
      expect(result.current.global).toBe(true);
    });
    expect(result.current.dedicated).toBe(false);
  });

  it('projectId は URL エンコードされる', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ connected: true, waiting: 0, lastPollAt: null, processing: false, dedicated: { connected: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useAgentConnected(true, 'a b/c'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/agent-status?id=a%20b%2Fc');
    });
  });
});
