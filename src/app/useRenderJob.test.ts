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
import { createElement, StrictMode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { EventBusProvider } from './eventBus';

import type { RenderState } from './useRenderJob';

// jsdom には EventSource が実装されていないため、フック mount 時の
// `new EventSource(...)` が例外にならない最小スタブを用意する。
// eventBus.test.tsx の流儀を踏襲し、triggerMessage でライブ SSE を模擬できるようにする。
class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeEventSource.instances.push(this);
  }
  triggerMessage(ch: string, msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ ch, msg }) } as MessageEvent<string>);
  }
  close(): void {}
}

const INITIAL: RenderState = { status: 'idle' };

describe('project-scoped render state', () => {
  it('clears another project’s completed export when switching to an idle project', async () => {
    const { useRenderJob } = await import('./useRenderJob');
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ type: 'idle' }] }) }));
    const wrapper = ({ children }: { children: import('react').ReactNode }) => createElement(StrictMode, null,
      createElement(EventBusProvider, { projectId: 'case-a', children }));
    const hook = renderHook(({ id }) => useRenderJob(id), { initialProps: { id: 'case-a' }, wrapper });
    await act(async () => {});
    act(() => FakeEventSource.instances.at(-1)!.triggerMessage('render', { type: 'snapshot', job: { phase: 'done', startedAt: 1, outputFile: 'a.mp4' } }));
    expect(hook.result.current.state.status).toBe('done');
    hook.rerender({ id: 'case-c' });
    await act(async () => {});
    expect(hook.result.current.state.status).toBe('idle');
    hook.unmount(); vi.unstubAllGlobals();
  });

  it('retains the completed filename and warning through a snapshot followed by a terminal notification', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const snapshot = nextRenderState(INITIAL, { type: 'snapshot', job: {
      phase: 'done', startedAt: 1000, outputFile: 'video-720p.mp4', warning: '出力フレーム数を確認してください',
    } });
    const done = nextRenderState(snapshot, { type: 'done', phase: 'done' });
    expect(done).toEqual({ status: 'done', outputFile: 'video-720p.mp4', warning: '出力フレーム数を確認してください' });
  });

});

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

  it('I-3: event(phase=capturing, capture あり) で running.capture が載る', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const running: RenderState = { status: 'running', phase: 'preparing', percent: null, startedAt: 1000 };
    const next = nextRenderState(running, {
      type: 'event',
      event: { phase: 'capturing', capture: { distinctFrames: 118, capturedTotal: 120, estimatedMs: 60_000 } },
    });
    expect(next.status).toBe('running');
    if (next.status === 'running') {
      expect(next.phase).toBe('capturing');
      expect(next.capture).toEqual({ distinctFrames: 118, capturedTotal: 120, estimatedMs: 60_000 });
    }
  });

  it('I-3: capture 未着のイベントでは直前の capture を維持する', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const running: RenderState = {
      status: 'running',
      phase: 'capturing',
      percent: null,
      startedAt: 1000,
      capture: { distinctFrames: 118, capturedTotal: 120, estimatedMs: 60_000 },
    };
    const next = nextRenderState(running, {
      type: 'event',
      event: { phase: 'capturing' },
    });
    expect(next.status).toBe('running');
    if (next.status === 'running') {
      expect(next.capture).toEqual({ distinctFrames: 118, capturedTotal: 120, estimatedMs: 60_000 });
    }
  });

  it('I-3: snapshot(phase=capturing, capture あり) から再接続しても capture が復元される', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const next = nextRenderState(INITIAL, {
      type: 'snapshot',
      job: {
        phase: 'capturing',
        startedAt: 1000,
        capture: { distinctFrames: 40, capturedTotal: 40, estimatedMs: 20_000 },
      },
    });
    expect(next.status).toBe('running');
    if (next.status === 'running') {
      expect(next.capture).toEqual({ distinctFrames: 40, capturedTotal: 40, estimatedMs: 20_000 });
    }
  });

  it('M-5: event(phase=preparing, warning あり) で running.warning が載り、続くイベントでも保持される', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const running: RenderState = { status: 'running', phase: 'rendering', percent: 50, startedAt: 1000 };
    const withWarning = nextRenderState(running, {
      type: 'event',
      event: { phase: 'preparing', warning: '高速書き出しに失敗したため互換(Remotion)経路でやり直しています' },
    });
    expect(withWarning.status).toBe('running');
    if (withWarning.status !== 'running') return;
    expect(withWarning.warning).toBe('高速書き出しに失敗したため互換(Remotion)経路でやり直しています');

    // 続く progress イベント（warning フィールド無し）でも保持される。
    const next = nextRenderState(withWarning, {
      type: 'event',
      event: { phase: 'rendering', progress: { frames: 10, total: 100, percent: 10 } },
    });
    expect(next.status).toBe('running');
    if (next.status === 'running') {
      expect(next.warning).toBe('高速書き出しに失敗したため互換(Remotion)経路でやり直しています');
    }
  });

  it('M-5: snapshot(warning あり) から再接続しても running.warning が復元される', async () => {
    const { nextRenderState } = await import('./useRenderJob');
    const next = nextRenderState(INITIAL, {
      type: 'snapshot',
      job: { phase: 'rendering', startedAt: 1000, warning: '互換(Remotion)経路でやり直しています' },
    });
    expect(next.status).toBe('running');
    if (next.status === 'running') {
      expect(next.warning).toBe('互換(Remotion)経路でやり直しています');
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

describe('useRenderJob().cancel — 開始要求と競合したキャンセル', () => {
  it('POST 応答前に押したキャンセルは、ジョブ登録後に送り直される（押したキャンセルが効く）', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');

    // POST の応答を保留して「開始要求が飛んでいる最中」を作る。
    let resolvePost: (v: unknown) => void = () => {};
    const postPromise = new Promise((r) => { resolvePost = r; });
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return postPromise;
      // DELETE: ジョブ未登録の間は 404（サーバの handleRenderDelete と同じ）。
      return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'not-found' }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRenderJob('p1'));
    let started: Promise<void> = Promise.resolve();
    await act(async () => {
      started = result.current.start();
      // 楽観的 running のうちに「×」を押す（＝ジョブ登録前の DELETE）。
      await result.current.cancel();
    });

    const deletesBefore = fetchMock.mock.calls.filter(([, i]) => (i as RequestInit)?.method === 'DELETE');
    expect(deletesBefore, '押した瞬間の DELETE は1回だけ飛ぶ').toHaveLength(1);

    // POST が着地＝サーバにジョブが実在する。ここで DELETE が送り直される。
    await act(async () => {
      resolvePost({ ok: true, json: async () => ({ ok: true, fastCut: false }) });
      await started;
    });
    const deletesAfter = fetchMock.mock.calls.filter(([, i]) => (i as RequestInit)?.method === 'DELETE');
    expect(deletesAfter, 'ジョブ登録後にキャンセルを送り直していない').toHaveLength(2);
  });

  it('POST 応答前のキャンセルでも、その DELETE が 200 なら送り直さない（不要な再送をしない）', async () => {
    // 「開始要求中に押したキャンセル」でも、サーバが既にジョブを登録していれば
    // その DELETE は 200 で効く。以前は保留フラグを保険で立てたまま下ろさなかったため、
    // POST 着地後に不要な DELETE をもう 1 回投げていた（E-2）。
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');

    let resolvePost: (v: unknown) => void = () => {};
    const postPromise = new Promise((r) => { resolvePost = r; });
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return postPromise;
      // DELETE: ジョブは既に登録済みで、キャンセルは成功する。
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRenderJob('p1'));
    let started: Promise<void> = Promise.resolve();
    await act(async () => {
      started = result.current.start();
      await result.current.cancel();
    });
    await act(async () => {
      resolvePost({ ok: true, json: async () => ({ ok: true, fastCut: false }) });
      await started;
    });
    const deletes = fetchMock.mock.calls.filter(([, i]) => (i as RequestInit)?.method === 'DELETE');
    expect(deletes, '効いたキャンセルに対して DELETE を再送している').toHaveLength(1);
  });

  it('実行中（開始要求は着地済み）のキャンセルは 1 回だけ送る（余計な再送をしない）', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRenderJob('p1'));
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.cancel(); });
    const deletes = fetchMock.mock.calls.filter(([, i]) => (i as RequestInit)?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
  });
});

// Task 6: fastCut 非適用時の通知（クライアント予測=高速 かつ サーバ実際=通常のときだけ立てる）。
describe('useRenderJob().fastCutFallbackNotice', () => {
  it('予測=true・レスポンス fastCut:false なら通知が立つ', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, fastCut: false }) });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRenderJob('p1'));
    await act(async () => {
      await result.current.start(undefined, true);
    });
    expect(result.current.fastCutFallbackNotice).toBe(true);
  });

  it('予測=true・レスポンス fastCut:true なら通知は立たない（実際に高速だった）', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, fastCut: true }) });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRenderJob('p1'));
    await act(async () => {
      await result.current.start(undefined, true);
    });
    expect(result.current.fastCutFallbackNotice).toBe(false);
  });

  it('does not label an explicit native export as a compatibility fallback', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, native: true, fastCut: false }) }));
    const { result } = renderHook(() => useRenderJob('p1'));
    await act(async () => { await result.current.start(undefined, true); });
    expect(result.current.fastCutFallbackNotice).toBe(false);
    expect(result.current.fastCutFallbackMessage).toBeNull();
  });

  it('予測=false なら実際がどうであれ通知は立たない（最初から通常予告）', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, fastCut: false }) });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRenderJob('p1'));
    await act(async () => {
      await result.current.start(undefined, false);
    });
    expect(result.current.fastCutFallbackNotice).toBe(false);
  });

  it('ジョブ完了（SSE done）で通知がクリアされる', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, fastCut: false }) });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRenderJob('p1'), {
      wrapper: ({ children }) => createElement(EventBusProvider, { projectId: 'p1', children }),
    });
    await act(async () => {
      await result.current.start(undefined, true);
    });
    expect(result.current.fastCutFallbackNotice).toBe(true);

    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.triggerMessage('render', { type: 'done', phase: 'done' });
    });
    expect(result.current.fastCutFallbackNotice).toBe(false);
  });

  it('キャンセル（SSE cancelled）でも通知がクリアされる', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, fastCut: false }) });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRenderJob('p1'), {
      wrapper: ({ children }) => createElement(EventBusProvider, { projectId: 'p1', children }),
    });
    await act(async () => {
      await result.current.start(undefined, true);
    });
    expect(result.current.fastCutFallbackNotice).toBe(true);

    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.triggerMessage('render', { type: 'done', phase: 'cancelled' });
    });
    expect(result.current.fastCutFallbackNotice).toBe(false);
  });
});

// I-2（受入C）: 退避理由を job の通知に載せ、文言を理由別に出し分ける。
describe('useRenderJob().fastCutFallbackMessage（理由別文言・I-2）', () => {
  async function startWith(body: Record<string, unknown>, predicted = true) {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRenderJob('p1'));
    await act(async () => {
      await result.current.start(undefined, predicted);
    });
    return result;
  }

  it('chromium-missing なら setup 再実行の案内文言', async () => {
    const result = await startWith({ ok: true, fastCut: false, fastCutIneligible: 'chromium-missing' });
    expect(result.current.fastCutFallbackNotice).toBe(true);
    expect(result.current.fastCutFallbackMessage).toBe(
      '撮影エンジンが未導入のため通常の書き出しになりました。setup.command / setup.bat をもう一度実行すると高速書き出しが使えます',
    );
  });

  it('env-path-missing なら環境変数の案内文言', async () => {
    const result = await startWith({ ok: true, fastCut: false, fastCutIneligible: 'env-path-missing' });
    expect(result.current.fastCutFallbackMessage).toBe(
      '環境変数 HARNESS_CHROMIUM のパスが見つからないため通常の書き出しになりました',
    );
  });

  it('unsupported-platform なら非対応 OS の案内文言', async () => {
    const result = await startWith({ ok: true, fastCut: false, fastCutIneligible: 'unsupported-platform' });
    expect(result.current.fastCutFallbackMessage).toBe(
      'この OS では高速書き出しの撮影に対応していないため通常の書き出しになりました',
    );
  });

  it('理由なし（従来の退避）なら message は null＝従来文言のまま', async () => {
    const result = await startWith({ ok: true, fastCut: false });
    expect(result.current.fastCutFallbackNotice).toBe(true);
    expect(result.current.fastCutFallbackMessage).toBeNull();
  });

  it('未知の理由文字列は無視して従来文言（サーバの型崩れで壊れない）', async () => {
    const result = await startWith({ ok: true, fastCut: false, fastCutIneligible: 'とつぜんの値' });
    expect(result.current.fastCutFallbackMessage).toBeNull();
  });
});

// data-safety-11: 押したのに何も起きない状態を無くす（失敗を呼び出し側へ返す）。
describe('useRenderJob().cancel / reveal の失敗通知', () => {
  it('cancel は HTTP 失敗（404 等）でメッセージを返す', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    const { result } = renderHook(() => useRenderJob('p1'));
    let msg: string | null = null;
    await act(async () => {
      msg = await result.current.cancel();
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('止められませんでした');
  });

  it('cancel は成功なら null を返す', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const { result } = renderHook(() => useRenderJob('p1'));
    let msg: string | null = 'x';
    await act(async () => {
      msg = await result.current.cancel();
    });
    expect(msg).toBeNull();
  });

  it('reveal は HTTP 失敗でメッセージを返す（console.warn だけで終わらせない）', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    const { result } = renderHook(() => useRenderJob('p1'));
    let msg: string | null = null;
    await act(async () => {
      msg = await result.current.reveal();
    });
    expect(msg).toContain('開けませんでした');
  });

  it('reveal は通信例外でもメッセージを返す', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { useRenderJob } = await import('./useRenderJob');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const { result } = renderHook(() => useRenderJob('p1'));
    let msg: string | null = null;
    await act(async () => {
      msg = await result.current.reveal();
    });
    expect(msg).toContain('開けませんでした');
  });
});
