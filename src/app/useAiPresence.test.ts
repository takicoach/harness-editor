// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAiPresence } from './useAiPresence';

const presence = { terminal: 'running', tool: 'claude', mcp: true, connected: true, focus: { primary: null, request: null, lastRead: null } };
afterEach(() => { vi.unstubAllGlobals(); });

describe('useAiPresence', () => {
  it('動いている間だけ /api/ai/presence を取る', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => presence }));
    vi.stubGlobal('fetch', fetchMock);
    const off = renderHook(() => useAiPresence(false));
    expect(off.result.current).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const on = renderHook(() => useAiPresence(true));
    await waitFor(() => expect(on.result.current).toEqual(presence));
    expect(fetchMock).toHaveBeenCalledWith('/api/ai/presence');
  });
  it('取れなかった時は前の値のまま', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => presence }).mockRejectedValue(new Error('down'));
    vi.stubGlobal('fetch', fetchMock);
    const view = renderHook(() => useAiPresence(true));
    await waitFor(() => expect(view.result.current).toEqual(presence));
  });
});
