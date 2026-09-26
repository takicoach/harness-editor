/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { scriptJudgmentFixture } from '../core/__fixtures__/scriptAdoption';
import { usePreferenceWorkspace } from './usePreferenceWorkspace';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });
it('an already mounted sibling recovers the same pending command after the originating view closes', async () => {
  sessionStorage.clear();
  const event = scriptJudgmentFixture();
  const command = { kind: 'decision' as const, operationId: event.operationId, at: event.createdAt, actor: event.actor, event };
  let calls = 0;
  const workspace = { schemaVersion: 1, decisions: { schemaVersion: 1, events: [] }, rules: [], evaluations: [], datasets: [], profiles: [], projectProfiles: {}, operations: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/command')) {
      calls += 1;
      expect(JSON.parse(String(init?.body))).toEqual(command);
      if (calls === 1) throw new TypeError('response lost');
    }
    return new Response(JSON.stringify(workspace), { status: 200 });
  }));
  const origin = renderHook(() => usePreferenceWorkspace());
  const sibling = renderHook(() => usePreferenceWorkspace());
  await waitFor(() => expect(sibling.result.current.state).not.toBeNull());
  await act(async () => { await expect(origin.result.current.execute(command)).rejects.toThrow('response lost'); });
  expect(sibling.result.current.pending?.operationId).toBe(command.operationId);
  origin.unmount();
  await act(async () => { await sibling.result.current.retry(); });
  expect(calls).toBe(2);
  expect(sibling.result.current.pending).toBeNull();
  expect(sessionStorage.getItem('sme-preference-pending-command-v1')).toBeNull();
});
