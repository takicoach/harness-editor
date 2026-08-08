/**
 * @vitest-environment jsdom
 */
/**
 * useRenderJob フックのユニットテスト。
 *
 * useDenoise.test.ts の流儀を踏襲: 純関数 nextRenderState を中心に
 * 状態遷移を検証する。フックそのものは DOM 依存のため型/純関数を主対象とする。
 * start() の同期ロック検証のみ、renderHook + jsdom を用いる。
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import type { RenderState } from './useRenderJob';

// jsdom には EventSource が実装されていないため、フック mount 時の
// `new EventSource(...)` が例外にならない最小スタブを用意する。
class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {}
}

const INITIAL: RenderState = { status: 'idle' };

describe('parseRenderEvent', () => {
  it('idle メッセージを返す', async () => {
    const { parseRenderEvent } = await import('./useRenderJob');
    const result = parseRenderEvent(JSON.stringify({ type: 'idle' }));
    expect(result).toEqual({ type: 'idle' });
  });

  it('snapshot メッセージを返す', async () => {
    const { parseRenderEvent } = await import('./useRenderJob');
    const result = parseRenderEvent(
      JSON.stringify({ type: 'snapshot', job: { phase: 'rendering', startedAt: 1000 } }),
    );
    expect(result).toMatchObject({ type: 'snapshot', job: { phase: 'rendering' } });
  });

  it('不正な JSON は null を返す', async () => {
    const { parseRenderEvent } = await import('./useRenderJob');
    const result = parseRenderEvent('invalid json{{{');
    expect(result).toBeNull();
  });
});

describe('nextRenderState', () => {
  it('idle SSE を受け取って状態を維持', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const next = nextRenderState(INITIAL, { type: 'idle' });
    expect(next).toEqual(INITIAL);
  });

  it('snapshot(rendering, progress あり) で running に遷移し percent が入る', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const next = nextRenderState(INITIAL, {
      type: 'snapshot',
      job: { phase: 'rendering', startedAt: 1000, progress: { frames: 10, total: 100, percent: 10 } },
    });
    expect(next.status).toBe('running');
    if (next.status === 'running') {
      expect(next.phase).toBe('rendering');
      expect(next.percent).toBe(10);
      expect(next.startedAt).toBe(1000);
    }
  });

  it('snapshot(rendering, progress なし) で percent は null', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const next = nextRenderState(INITIAL, {
      type: 'snapshot',
      job: { phase: 'rendering', startedAt: 1000 },
    });
    expect(next.status).toBe('running');
    if (next.status === 'running') {
      expect(next.percent).toBeNull();
    }
  });

  it('snapshot(done) で done に遷移', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const next = nextRenderState(INITIAL, {
      type: 'snapshot',
      job: { phase: 'done', startedAt: 1000 },
    });
    expect(next.status).toBe('done');
  });

  it('snapshot(failed) で error に遷移', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const next = nextRenderState(INITIAL, {
      type: 'snapshot',
      job: { phase: 'failed', startedAt: 1000, error: { code: 'ffmpeg-error', message: '失敗' } },
    });
    expect(next.status).toBe('error');
    if (next.status === 'error') {
      expect(next.error.code).toBe('ffmpeg-error');
    }
  });

  it('snapshot(cancelled) で idle に遷移', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const running: RenderState = { status: 'running', phase: 'rendering', percent: 50, startedAt: 1000 };
    const next = nextRenderState(running, {
      type: 'snapshot',
      job: { phase: 'cancelled', startedAt: 1000 },
    });
    expect(next.status).toBe('idle');
  });

  it('event(progress 更新) で running.percent が更新される', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const running: RenderState = { status: 'running', phase: 'preparing', percent: null, startedAt: 1000 };
    const next = nextRenderState(running, {
      type: 'event',
      event: { phase: 'rendering', progress: { frames: 30, total: 100, percent: 30 } },
    });
    expect(next.status).toBe('running');
    if (next.status === 'running') {
      expect(next.phase).toBe('rendering');
      expect(next.percent).toBe(30);
    }
  });

  it('event(progress なし) で percent は前の値を維持', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const running: RenderState = { status: 'running', phase: 'preparing', percent: 30, startedAt: 1000 };
    const next = nextRenderState(running, {
      type: 'event',
      event: { phase: 'rendering' },
    });
    expect(next.status).toBe('running');
    if (next.status === 'running') {
      expect(next.percent).toBe(30);
    }
  });

  it('event(failed) で error に遷移', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const running: RenderState = { status: 'running', phase: 'rendering', percent: 50, startedAt: 1000 };
    const next = nextRenderState(running, {
      type: 'event',
      event: { phase: 'failed', error: { code: 'ffmpeg-error', message: '失敗' } },
    });
    expect(next.status).toBe('error');
    if (next.status === 'error') {
      expect(next.error.code).toBe('ffmpeg-error');
    }
  });

  it('event(cancelled) で idle に遷移', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const running: RenderState = { status: 'running', phase: 'rendering', percent: 50, startedAt: 1000 };
    const next = nextRenderState(running, {
      type: 'event',
      event: { phase: 'cancelled' },
    });
    expect(next.status).toBe('idle');
  });

  it('done(done) で done に遷移', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const next = nextRenderState(INITIAL, { type: 'done', phase: 'done' });
    expect(next.status).toBe('done');
  });

  it('done(failed) で error に遷移', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const next = nextRenderState(INITIAL, {
      type: 'done',
      phase: 'failed',
      error: { code: 'ffmpeg-error', message: '終了コード 1' },
    });
    expect(next.status).toBe('error');
    if (next.status === 'error') {
      expect(next.error.code).toBe('ffmpeg-error');
    }
  });

  it('done(cancelled) で idle に遷移', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const next = nextRenderState(INITIAL, { type: 'done', phase: 'cancelled' });
    expect(next.status).toBe('idle');
  });
});

describe('useRenderJob().start 二重起動ガード', () => {
  it('同一レンダー内の二重 start は2本目が no-op（POST は1回だけ）', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRenderJob('p1'));
    await act(async () => {
      await Promise.all([result.current.start(), result.current.start()]);
    });
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'POST');
    expect(posts).toHaveLength(1);
  });
});

describe('revealErrorMessage', () => {
  it('404 は「見つからない」と言い切る（黙って握り潰さない）', async () => {
    const { revealErrorMessage } = await import('./useRenderJob');
    expect(revealErrorMessage(404)).toContain('見つかりません');
  });

  it('404 以外はステータス付きの汎用文', async () => {
    const { revealErrorMessage } = await import('./useRenderJob');
    expect(revealErrorMessage(500)).toContain('500');
  });
});
