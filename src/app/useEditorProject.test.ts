/**
 * @vitest-environment jsdom
 */
/**
 * useEditorProject フックのユニットテスト。
 *
 * isCurrent(id) が「今もそのプロジェクトを見ているか」を正しく返すことを検証する。
 * fetch はモックし、useProjectWatch の EventSource 依存も jsdom スタブで無害化する。
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {}
}

describe('useEditorProject().isCurrent', () => {
  it('isCurrent は選択中プロジェクトのみ true', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/api/projects')) {
        return Promise.resolve({ ok: true, json: async () => ({ root: '/tmp', projects: [] }) });
      }
      // /api/project?id=... は解決しないまま保留（本テストでは selectProject の
      // 内部読込完了を待たず、同期的に更新される selectedIdRef のみ検証する）。
      return new Promise(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);

    const { useEditorProject } = await import('./useEditorProject');
    const { result } = renderHook(() => useEditorProject());

    expect(result.current.isCurrent('a')).toBe(false);
    act(() => {
      result.current.selectProject('a');
    });
    expect(result.current.isCurrent('a')).toBe(true);
    expect(result.current.isCurrent('b')).toBe(false);
  });
});
