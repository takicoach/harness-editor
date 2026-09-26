// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentActivityDialog } from './AgentActivityDialog';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('応答がpoll間隔より遅くても完了した履歴を表示する', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({
    ok: true, json: async () => ({ operations: [], total: 0, nextOffset: null }),
  }), 3100))));
  render(<AgentActivityDialog projectId="video" credentials={{ sessionId: 'session', sessionKey: 'key' }}
    connection="connected" connectionError={null} onClose={() => {}} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
  expect(screen.queryByText('履歴を読み込んでいます…')).toBeNull();
  expect(screen.queryByText('この動画には、まだAIの編集記録がありません。')).not.toBeNull();
});
