// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiScreen } from '../shared/aiFocus';
import { aiPageId, useAiFocus } from './useAiFocus';

const screen = (projectId: string, mode: AiScreen['mode'] = 'video'): AiScreen => ({ projectId, projectName: projectId, mode, target: null, playheadSec: null, selection: [], materials: '' });
const bodies = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter(([url]) => url === '/api/ai/focus').map(([, init]) => JSON.parse(String((init as RequestInit).body)));

describe('useAiFocus', () => {
  let fetchMock: ReturnType<typeof vi.fn>, beacon: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ primary: false }) }));
    beacon = vi.fn(() => true);
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('すぐ送り、案件・モードが変わったらすぐ送り直す。連番は増え続ける', () => {
    const view = renderHook(({ value }) => useAiFocus(value), { initialProps: { value: screen('a') } });
    view.rerender({ value: screen('a', 'thumbnail') });
    const sent = bodies(fetchMock);
    expect(sent[0]).toMatchObject({ pageId: aiPageId(), screen: { projectId: 'a', mode: 'video' } });
    expect(sent.at(-1)).toMatchObject({ screen: { projectId: 'a', mode: 'thumbnail' } });
    expect(sent.at(-1).seq).toBeGreaterThan(sent[0].seq);
    expect(view.result.current.pageId).toBe(aiPageId());
  });
  it('2 秒ごとに送る。外したら「ホーム」（null）を送る', () => {
    vi.useFakeTimers();
    const view = renderHook(() => useAiFocus(screen('a')));
    const before = bodies(fetchMock).length;
    vi.advanceTimersByTime(2000);
    expect(bodies(fetchMock).length).toBe(before + 1);
    view.unmount();
    expect(bodies(fetchMock).at(-1)).toMatchObject({ screen: null });
  });
  it('ページを閉じる時は release を beacon で送る', () => {
    renderHook(() => useAiFocus(screen('a')));
    window.dispatchEvent(new Event('pagehide'));
    expect(beacon).toHaveBeenCalledWith('/api/ai/focus/release', expect.any(Blob));
  });
  it('beat() は毎回新しい連番の報告を作る（AI タブの起動で主画面を登録する時に使う）', () => {
    const view = renderHook(() => useAiFocus(screen('a')));
    const first = view.result.current.beat(), second = view.result.current.beat();
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(first).toMatchObject({ pageId: aiPageId(), screen: { projectId: 'a' } });
  });
});
