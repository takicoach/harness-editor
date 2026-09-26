// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestedAgentActivityProject, useInitialAgentActivity } from './useInitialAgentActivity';

interface HarnessProps {
  requested: string | null;
  known: boolean | null;
  selected: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  onOpen: () => void;
}

function useHarness(props: HarnessProps): void {
  useInitialAgentActivity(props.requested, props.known, props.selected, props.status, props.onOpen);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('requestedAgentActivityProject', () => {
  it('確認リンクの案件だけを受け付ける', () => {
    expect(requestedAgentActivityProject('?project=video-a&agentActivity=review')).toBe('video-a');
    expect(requestedAgentActivityProject('?project=video-a')).toBeNull();
    expect(requestedAgentActivityProject('?project=video-a&agentActivity=unknown')).toBeNull();
    expect(requestedAgentActivityProject('?agentActivity=review')).toBeNull();
  });
});

describe('useInitialAgentActivity', () => {
  it('実在案件が ready になった時だけ一度開く', async () => {
    const onOpen = vi.fn();
    const { rerender } = renderHook((props: HarnessProps) => useHarness(props), {
      initialProps: { requested: 'video-a', known: null, selected: null, status: 'idle', onOpen },
    });
    rerender({ requested: 'video-a', known: true, selected: 'video-a', status: 'loading', onOpen });
    expect(onOpen).not.toHaveBeenCalled();
    rerender({ requested: 'video-a', known: true, selected: 'video-a', status: 'ready', onOpen });
    expect(onOpen).toHaveBeenCalledTimes(1);
    rerender({ requested: 'video-a', known: true, selected: 'video-a', status: 'ready', onOpen });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('読込エラーでは開かず、同じ案件の再試行成功時に開く', async () => {
    const onOpen = vi.fn();
    const { rerender } = renderHook((props: HarnessProps) => useHarness(props), {
      initialProps: { requested: 'video-a', known: true, selected: 'video-a', status: 'error', onOpen },
    });
    expect(onOpen).not.toHaveBeenCalled();
    rerender({ requested: 'video-a', known: true, selected: 'video-a', status: 'ready', onOpen });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('一覧外案件は破棄し、後で同じIDが選ばれても開かない', async () => {
    const onOpen = vi.fn();
    const { rerender } = renderHook((props: HarnessProps) => useHarness(props), {
      initialProps: { requested: 'missing', known: false, selected: null, status: 'idle', onOpen },
    });
    rerender({ requested: 'missing', known: true, selected: 'missing', status: 'ready', onOpen });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('対象の読込中に別案件へ移った場合は遅れて開かない', async () => {
    const onOpen = vi.fn();
    const { rerender } = renderHook((props: HarnessProps) => useHarness(props), {
      initialProps: { requested: 'video-a', known: true, selected: 'video-a', status: 'loading', onOpen },
    });
    rerender({ requested: 'video-a', known: true, selected: 'video-b', status: 'ready', onOpen });
    rerender({ requested: 'video-a', known: true, selected: 'video-a', status: 'ready', onOpen });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
