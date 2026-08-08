/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useProjectWatch } from './useProjectWatch';
import { EventBusProvider } from './eventBus';

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
  triggerError(): void {
    this.onerror?.();
  }
  close(): void {
    this.closed = true;
  }
}

function Probe({ projectId, onChange }: { projectId: string | null; onChange: () => void }) {
  useProjectWatch(projectId, onChange);
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

describe('useProjectWatch', () => {
  it('watch チャネルの change メッセージで onChange を呼ぶ', () => {
    const onChange = vi.fn();
    render(
      <EventBusProvider projectId="p1">
        <Probe projectId="p1" onChange={onChange} />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.triggerMessage('watch', { type: 'change' });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('projectId が null のときは change メッセージが来ても onChange を呼ばない', () => {
    const onChange = vi.fn();
    render(
      <EventBusProvider>
        <Probe projectId={null} onChange={onChange} />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.triggerMessage('watch', { type: 'change' });
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('open メッセージでは onChange を呼ばない', () => {
    const onChange = vi.fn();
    render(
      <EventBusProvider projectId="p1">
        <Probe projectId="p1" onChange={onChange} />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.triggerMessage('watch', { type: 'open' });
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('onerror では close しない（自動再接続に委ねる）', () => {
    render(
      <EventBusProvider projectId="p1">
        <Probe projectId="p1" onChange={vi.fn()} />
      </EventBusProvider>,
    );
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.triggerError();
    });
    expect(es.closed).toBe(false);
  });
});
