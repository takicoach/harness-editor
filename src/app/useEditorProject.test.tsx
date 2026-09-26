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

/**
 * 上書き保存が成功したら外部変更バナーは消える（サイクル 2 レビュー Important）。
 *
 * 上書き保存が通った時点でディスクと画面は一致している。にもかかわらず
 * 「外部で更新されました…再読込」バナーが残り、直前の成功トーストと矛盾していた。
 * 初心者は「まだ何かおかしい」と再読込（＝自分の編集の破棄）を押しかねない。
 */
describe('useEditorProject().clearExternalChange', () => {
  it('watch の change でバナーが立ち、clearExternalChange で消える', async () => {
    class BusEventSource {
      static last: BusEventSource | null = null;
      onmessage: ((e: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        BusEventSource.last = this;
      }
      close(): void {}
      change(): void {
        this.onmessage?.({
          data: JSON.stringify({ ch: 'watch', msg: { type: 'change' } }),
        } as MessageEvent<string>);
      }
    }
    vi.stubGlobal('EventSource', BusEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.startsWith('/api/projects')) {
          return Promise.resolve({ ok: true, json: async () => ({ root: '/tmp', projects: [] }) });
        }
        return new Promise(() => {});
      }),
    );

    const { useEditorProject } = await import('./useEditorProject');
    const { EventBusProvider } = await import('./eventBus');
    const { result } = renderHook(() => useEditorProject(), {
      wrapper: ({ children }) => <EventBusProvider projectId="a">{children}</EventBusProvider>,
    });

    act(() => {
      result.current.selectProject('a');
    });
    expect(result.current.externallyChanged).toBe(false);

    act(() => {
      BusEventSource.last?.change();
    });
    expect(result.current.externallyChanged).toBe(true);

    // 上書き保存の成功時に App が呼ぶ導線。再読込せずにバナーだけを畳む。
    act(() => {
      result.current.clearExternalChange();
    });
    expect(result.current.externallyChanged).toBe(false);
  });
});

describe('useEditorProject().projectsLoading（status-ia-1）', () => {
  it('初期は true で、一覧の取得完了後に false になる', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    let resolveProjects: ((v: unknown) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.startsWith('/api/projects')) {
          return new Promise((res) => {
            resolveProjects = res;
          });
        }
        return new Promise(() => {});
      }),
    );

    const { useEditorProject } = await import('./useEditorProject');
    const { result } = renderHook(() => useEditorProject());

    expect(result.current.projectsLoading).toBe(true);

    await act(async () => {
      resolveProjects?.({ ok: true, json: async () => ({ root: '/tmp', projects: [] }) });
      await Promise.resolve();
    });

    expect(result.current.projectsLoading).toBe(false);
  });

  it('一覧の取得に失敗しても false になる（読込中で固まらない）', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.startsWith('/api/projects')) return Promise.reject(new Error('boom'));
        return new Promise(() => {});
      }),
    );

    const { useEditorProject } = await import('./useEditorProject');
    const { result } = renderHook(() => useEditorProject());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.projectsLoading).toBe(false);
    expect(result.current.projectsError).toBe('boom');
  });
});
