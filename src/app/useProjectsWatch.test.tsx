/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useProjectsWatch } from './useProjectsWatch';
import { EventBusProvider } from './eventBus';

/** jsdom に EventSource が無いため、テスト用の最小モックを用意する。 */
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

  /** テストからバスのメッセージ（{ch,msg}）受信を模擬する。 */
  triggerMessage(ch: string, msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ ch, msg }) } as MessageEvent<string>);
  }

  triggerError(): void {
    this.onerror?.();
  }

  close(): void {
    this.closed = true;
  }
}

function Probe({
  enabled,
  onStatus,
  onOpen,
}: {
  enabled: boolean;
  onStatus: (id: string, patch: unknown) => void;
  onOpen?: () => void;
}) {
  useProjectsWatch(enabled, onStatus, onOpen);
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

describe('useProjectsWatch', () => {
  it('EventBusProvider が張る EventSource は /api/events（projects チャネル）', () => {
    render(
      <EventBusProvider>
        <Probe enabled={true} onStatus={vi.fn()} />
      </EventBusProvider>,
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/events');
  });

  it('onerror では close しない（EventBusProvider がブラウザ標準の自動再接続に委ねる）', () => {
    render(
      <EventBusProvider>
        <Probe enabled={true} onStatus={vi.fn()} />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.triggerError();
    });
    expect(es.closed).toBe(false);
  });

  it('projects チャネルの open メッセージで onOpen コールバックを呼ぶ', () => {
    const onOpen = vi.fn();
    render(
      <EventBusProvider>
        <Probe enabled={true} onStatus={vi.fn()} onOpen={onOpen} />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.triggerMessage('projects', { type: 'open' });
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('projects チャネルの status メッセージを onStatus へ渡す', () => {
    const onStatus = vi.fn();
    render(
      <EventBusProvider>
        <Probe enabled={true} onStatus={onStatus} />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.triggerMessage('projects', { type: 'status', id: 'p1', status: 'editing' });
    });
    expect(onStatus).toHaveBeenCalledWith('p1', expect.objectContaining({ status: 'editing' }));
  });

  it('他チャネル（watch 等）のメッセージは無視する', () => {
    const onStatus = vi.fn();
    render(
      <EventBusProvider>
        <Probe enabled={true} onStatus={onStatus} />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.triggerMessage('watch', { type: 'change' });
    });
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('enabled=false のときは status メッセージが来ても onStatus を呼ばない', () => {
    const onStatus = vi.fn();
    render(
      <EventBusProvider>
        <Probe enabled={false} onStatus={onStatus} />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.triggerMessage('projects', { type: 'status', id: 'p1', status: 'editing' });
    });
    expect(onStatus).not.toHaveBeenCalled();
  });
});
