/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';
import { EventBusProvider, useEventChannel, useEventBusProjectId, useEventChannelWithSync, fetchEventsSync } from './eventBus';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  triggerMessage(ch: string, msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ ch, msg }) } as MessageEvent<string>);
  }
  triggerRawMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent<string>);
  }
  triggerError(): void {
    this.onerror?.();
  }
  close(): void {
    this.closed = true;
  }
}

function Listener({ ch, onMsg }: { ch: string; onMsg: (msg: unknown) => void }) {
  useEventChannel(ch, onMsg);
  return null;
}

function ProjectIdSync({ projectId }: { projectId: string }) {
  useEventBusProjectId(projectId);
  return null;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EventBusProvider', () => {
  it('projectId 未指定（既定 ""）は /api/events を張る（ホーム画面）', () => {
    render(<EventBusProvider>{null}</EventBusProvider>);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/events');
  });

  it('projectId 指定は /api/events?id=<projectId> を張る（エディタ画面）', () => {
    render(<EventBusProvider projectId="p1">{null}</EventBusProvider>);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/events?id=p1');
  });

  it('useEventBusProjectId で projectId を切り替えると張り替える', () => {
    // Provider の初期 projectId prop を子の useEventBusProjectId と揃えておくことで、
    // マウント直後の「'' → 'p1'」という（App の初回選択時と同じ）過渡的な張り替えを避け、
    // p1 → p2 の切替えだけを単独で検証する。
    const { rerender } = render(
      <EventBusProvider projectId="p1">
        <ProjectIdSync projectId="p1" />
      </EventBusProvider>,
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/events?id=p1');
    expect(FakeEventSource.instances[0]!.closed).toBe(false);

    rerender(
      <EventBusProvider projectId="p1">
        <ProjectIdSync projectId="p2" />
      </EventBusProvider>,
    );

    // 旧接続は張り替え時に close される。
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toBe('/api/events?id=p2');
  });

  it('マウント直後は Provider の初期 projectId（既定 \'\'）→ 子が伝える projectId の順に接続が張り替わる', () => {
    // App の実運用（main.tsx: <EventBusProvider><App/></EventBusProvider>、App が
    // useEventBusProjectId(selectedId ?? '') で伝える）を模した経路。selectedId が
    // 最初から確定していない一般ケースでは、この過渡的な '' 接続は起きない
    // （selectedId の初期値も '' のため）。ここでは切替えの仕組み自体を確認する。
    render(
      <EventBusProvider>
        <ProjectIdSync projectId="p1" />
      </EventBusProvider>,
    );
    const urls = FakeEventSource.instances.map((es) => es.url);
    expect(urls).toEqual(['/api/events', '/api/events?id=p1']);
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances[1]!.closed).toBe(false);
  });

  it('onerror では close しない（自動再接続に委ねる）', () => {
    render(<EventBusProvider projectId="p1">{null}</EventBusProvider>);
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.triggerError();
    });
    expect(es.closed).toBe(false);
  });

  it('unmount 時のみ close する', () => {
    const { unmount } = render(<EventBusProvider projectId="p1">{null}</EventBusProvider>);
    const es = FakeEventSource.instances[0]!;
    expect(es.closed).toBe(false);
    unmount();
    expect(es.closed).toBe(true);
  });

  it('チャネルごとに配送し、他チャネルのメッセージは無視する', () => {
    const onA = vi.fn();
    const onB = vi.fn();
    render(
      <EventBusProvider projectId="p1">
        <Listener ch="render" onMsg={onA} />
        <Listener ch="denoise" onMsg={onB} />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.triggerMessage('render', { type: 'idle' });
    });
    expect(onA).toHaveBeenCalledWith({ type: 'idle' });
    expect(onB).not.toHaveBeenCalled();
  });

  it('不正な JSON は無視する（例外を投げない）', () => {
    const onMsg = vi.fn();
    render(
      <EventBusProvider projectId="p1">
        <Listener ch="render" onMsg={onMsg} />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    expect(() => {
      act(() => {
        es.triggerRawMessage('not json{{{');
      });
    }).not.toThrow();
    expect(onMsg).not.toHaveBeenCalled();
  });

  it('handler が毎レンダー差し替わっても再購読しない（stale capture しない・最新 handler を呼ぶ）', () => {
    const calls: number[] = [];
    function Probe({ tag }: { tag: number }) {
      useEventChannel('render', () => {
        calls.push(tag);
      });
      return null;
    }
    const { rerender } = render(
      <EventBusProvider projectId="p1">
        <Probe tag={1} />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    rerender(
      <EventBusProvider projectId="p1">
        <Probe tag={2} />
      </EventBusProvider>,
    );
    act(() => {
      es.triggerMessage('render', { type: 'idle' });
    });
    expect(calls).toEqual([2]);
  });
});

describe('useEventChannel — Provider 無し', () => {
  it('EventBusProvider の外で呼んでも例外にならず何も起きない', () => {
    const onMsg = vi.fn();
    expect(() => render(<Listener ch="render" onMsg={onMsg} />)).not.toThrow();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

describe('fetchEventsSync', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('/api/events/sync?id=&ch= を叩き messages 配列を返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ type: 'idle' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const messages = await fetchEventsSync('p1', 'render');
    expect(fetchMock).toHaveBeenCalledWith('/api/events/sync?id=p1&ch=render');
    expect(messages).toEqual([{ type: 'idle' }]);
  });

  it('projectId 空文字は fetch せず空配列を返す', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const messages = await fetchEventsSync('', 'render');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
  });

  it('非 2xx / ネットワーク失敗 / 不正な body は空配列で諦める', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await fetchEventsSync('p1', 'render')).toEqual([]);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await fetchEventsSync('p1', 'render')).toEqual([]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: 'not-an-array' }) }));
    expect(await fetchEventsSync('p1', 'render')).toEqual([]);
  });
});

function SyncProbe({ ch, projectId, onMsg }: { ch: string; projectId: string; onMsg: (msg: unknown) => void }) {
  useEventChannelWithSync(ch, projectId, onMsg);
  return null;
}

describe('useEventChannelWithSync', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('マウント時に sync のメッセージ列を順に apply する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [{ type: 'snapshot', job: { phase: 'rendering' } }, { type: 'idle' }] }),
      }),
    );
    const onMsg = vi.fn();
    render(
      <EventBusProvider projectId="p1">
        <SyncProbe ch="render" projectId="p1" onMsg={onMsg} />
      </EventBusProvider>,
    );
    await waitFor(() => {
      expect(onMsg).toHaveBeenCalledTimes(2);
    });
    expect(onMsg.mock.calls[0]![0]).toEqual({ type: 'snapshot', job: { phase: 'rendering' } });
    expect(onMsg.mock.calls[1]![0]).toEqual({ type: 'idle' });
  });

  it('ライブメッセージも同じ apply へ届く（sync とバスの両方が同じ経路を通る）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) }));
    const onMsg = vi.fn();
    render(
      <EventBusProvider projectId="p1">
        <SyncProbe ch="render" projectId="p1" onMsg={onMsg} />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.triggerMessage('render', { type: 'event', event: { phase: 'rendering' } });
    });
    expect(onMsg).toHaveBeenCalledWith({ type: 'event', event: { phase: 'rendering' } });
  });

  it('projectId 空文字では sync を fetch しない', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <EventBusProvider>
        <SyncProbe ch="render" projectId="" onMsg={vi.fn()} />
      </EventBusProvider>,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
