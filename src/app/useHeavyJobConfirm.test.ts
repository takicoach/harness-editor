/**
 * @vitest-environment jsdom
 */
/**
 * useHeavyJobConfirm フックのユニットテスト。
 *
 * useRenderJob.test.ts の流儀（renderHook + jsdom、start() の非同期挙動検証）を踏襲する。
 * fetch をモックし、409 confirmation-required → confirm()/dismiss() の分岐と、
 * 200 素通りを検証する。
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

/** 409 confirmation-required 応答のモック（clone() 込み・実 Response API を模す）。 */
function confirmationRequiredResponse(running: number, recommendedMax: number) {
  const body = { error: 'confirmation-required', confirmationRequired: true, running, recommendedMax };
  return {
    ok: false,
    status: 409,
    json: async () => body,
    clone() {
      return confirmationRequiredResponse(running, recommendedMax);
    },
  };
}

describe('useHeavyJobConfirm', () => {
  it('200 なら素通り（ダイアログを出さず、その Response をそのまま返す）', async () => {
    const { useHeavyJobConfirm } = await import('./useHeavyJobConfirm');
    const okResponse = { ok: true, status: 200, json: async () => ({}) };
    const fetchMock = vi.fn().mockResolvedValue(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useHeavyJobConfirm());

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.start('/api/render?id=p1', { method: 'POST' });
    });

    expect(outcome).toBe(okResponse);
    expect(result.current.pendingConfirm).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('通常の 409（already-running 等・confirmationRequired なし）も素通り', async () => {
    const { useHeavyJobConfirm } = await import('./useHeavyJobConfirm');
    const alreadyRunning = {
      ok: false,
      status: 409,
      json: async () => ({ error: 'already-running' }),
      clone() {
        return alreadyRunning;
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(alreadyRunning);
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useHeavyJobConfirm());

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.start('/api/render?id=p1', { method: 'POST' });
    });

    expect(outcome).toBe(alreadyRunning);
    expect(result.current.pendingConfirm).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('409 confirmation-required → confirm() で force=1 付き再送', async () => {
    const { useHeavyJobConfirm } = await import('./useHeavyJobConfirm');
    const forcedOk = { ok: true, status: 200, json: async () => ({}) };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(confirmationRequiredResponse(2, 2))
      .mockResolvedValueOnce(forcedOk);
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useHeavyJobConfirm());

    let startPromise!: Promise<unknown>;
    act(() => {
      startPromise = result.current.start('/api/render?id=p1', { method: 'POST' });
    });

    await waitFor(() => {
      expect(result.current.pendingConfirm).toEqual({ running: 2, recommendedMax: 2 });
    });

    act(() => {
      result.current.confirm();
    });

    const outcome = await startPromise;

    expect(outcome).toBe(forcedOk);
    expect(result.current.pendingConfirm).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCallUrl = fetchMock.mock.calls[1]?.[0] as string;
    expect(secondCallUrl).toBe('/api/render?id=p1&force=1');
    const secondCallInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(secondCallInit).toEqual({ method: 'POST' });
    vi.unstubAllGlobals();
  });

  it('409 confirmation-required → dismiss() で再送なし・cancelled を返す', async () => {
    const { useHeavyJobConfirm } = await import('./useHeavyJobConfirm');
    const fetchMock = vi.fn().mockResolvedValueOnce(confirmationRequiredResponse(3, 2));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useHeavyJobConfirm());

    let startPromise!: Promise<unknown>;
    act(() => {
      startPromise = result.current.start('/api/denoise?id=p1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strength: 'mid' }),
      });
    });

    await waitFor(() => {
      expect(result.current.pendingConfirm).toEqual({ running: 3, recommendedMax: 2 });
    });

    act(() => {
      result.current.dismiss();
    });

    const outcome = await startPromise;

    expect(outcome).toBe('cancelled');
    expect(result.current.pendingConfirm).toBeNull();
    // dismiss は再送しない＝呼び出し回数は最初の1回のまま。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('force=1 の付与は既存クエリの有無で ? / & を出し分ける', async () => {
    const { useHeavyJobConfirm } = await import('./useHeavyJobConfirm');
    const forcedOk = { ok: true, status: 200, json: async () => ({}) };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(confirmationRequiredResponse(1, 1))
      .mockResolvedValueOnce(forcedOk);
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useHeavyJobConfirm());

    let startPromise!: Promise<unknown>;
    act(() => {
      startPromise = result.current.start('/api/preview-proxy', { method: 'POST' });
    });

    await waitFor(() => {
      expect(result.current.pendingConfirm).not.toBeNull();
    });

    act(() => {
      result.current.confirm();
    });

    await startPromise;

    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/preview-proxy?force=1');
    vi.unstubAllGlobals();
  });
});
