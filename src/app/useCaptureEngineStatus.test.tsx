/**
 * @vitest-environment jsdom
 */
/**
 * useCaptureEngineStatus の起動時 prefetch が React.StrictMode 下でも着地するかの正対照つきプローブ
 * （M2d T2 修正ラウンド2・I-1）。
 *
 * 旧実装（ref ガード1本の effect）は StrictMode の二重マウント
 * （mount → cleanup → mount）で、1 回目の fetch が cleanup の cancelled で無視され、
 * 2 回目の mount 実行は ref が既に true・exportDialogOpen も false のため
 * early return して新しい fetch を発行しない——結果、起動時 prefetch が一切反映されない。
 * StrictMode 無しだけ緑では「元から動く実装」と区別できないため、有り/無し両方を
 * 同一 assertion で通す必要がある（正対照）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import { useCaptureEngineStatus } from './useCaptureEngineStatus';
import type { CaptureEngineStatus } from './captureEngineStatus';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe({ onStatus }: { onStatus: (v: CaptureEngineStatus | undefined) => void }) {
  const status = useCaptureEngineStatus(false);
  onStatus(status);
  return null;
}

function stubFetchOk(): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, source: 'env' }),
  })));
}

describe('useCaptureEngineStatus — StrictMode 起動時 prefetch（I-1）', () => {
  it('StrictMode 無しでマウント時に captureEngine が着地する', async () => {
    stubFetchOk();
    let latest: CaptureEngineStatus | undefined;
    render(React.createElement(Probe, { onStatus: (v) => { latest = v; } }));
    await waitFor(() => expect(latest?.ok).toBe(true));
  });

  it('StrictMode でラップしてマウントしても captureEngine が着地する（正対照）', async () => {
    stubFetchOk();
    let latest: CaptureEngineStatus | undefined;
    render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(Probe, { onStatus: (v) => { latest = v; } }),
      ),
    );
    await waitFor(() => expect(latest?.ok).toBe(true));
  });
});
