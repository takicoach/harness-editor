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
      es.triggerMessage('projects', { type: 'status', id: 'p1', status: 'telop' });
    });
    expect(onStatus).toHaveBeenCalledWith('p1', expect.objectContaining({ status: 'telop' }));
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
      es.triggerMessage('projects', { type: 'status', id: 'p1', status: 'telop' });
    });
    expect(onStatus).not.toHaveBeenCalled();
  });
});

describe('useProjectsWatch の stageManual 配信', () => {
  it('stage 非 null → null に変わったイベントで stageManual が残留しない', () => {
    const patches: Array<Record<string, unknown>> = [];
    render(
      <EventBusProvider>
        <Probe
          enabled={true}
          onStatus={(_id, patch) => {
            patches.push(patch as Record<string, unknown>);
          }}
        />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;

    act(() => {
      // 手動 stage 設定時。サーバは stageManual: true を載せる。
      es.triggerMessage('projects', { type: 'status', id: 'p1', status: 'telop', stageManual: true });
      // 自動判定へ戻したとき。サーバ側は optional なので JSON からキーごと落ちる。
      es.triggerMessage('projects', { type: 'status', id: 'p1', status: 'cut' });
    });

    expect(patches).toHaveLength(2);
    expect(patches[0]!.stageManual).toBe(true);
    // patchProject は {...prev, ...patch} なので、解除には「キーが存在して undefined」が要る。
    expect(Object.prototype.hasOwnProperty.call(patches[1]!, 'stageManual')).toBe(true);
    const merged = { ...patches[0]!, ...patches[1]! };
    expect(merged.stageManual ?? false).toBe(false);
  });
});

describe('useProjectsWatch の steps 配信', () => {
  it('SSE の steps 差分をそのままパッチとして渡す（ホームのステッパーが古いまま残らない）', () => {
    const patches: Array<Record<string, unknown>> = [];
    render(
      <EventBusProvider>
        <Probe
          enabled={true}
          onStatus={(_id, patch) => {
            patches.push(patch as Record<string, unknown>);
          }}
        />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;

    act(() => {
      es.triggerMessage('projects', {
        type: 'status',
        id: 'p1',
        status: 'rendered',
        steps: { transcribe: true, cut: true, telop: 'nonempty', audio: true, rendered: true },
      });
    });

    expect(patches).toHaveLength(1);
    expect((patches[0]!.steps as { rendered?: boolean } | undefined)?.rendered).toBe(true);
  });
});
