/** @vitest-environment jsdom */
import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasReviewableDiff, useLearningDiff, LEARNING_NOTIFICATION_SOURCE } from './useLearningDiff';
import type { LearningApproveResponse, LearningDiffResponse } from '../shared/types';

const EMPTY: LearningDiffResponse = { cut: null, words: null, telops: null, ses: null, undistilledCount: 0 };

describe('hasReviewableDiff', () => {
  it('全項目 null なら false', () => {
    expect(hasReviewableDiff(EMPTY)).toBe(false);
  });

  it('全項目空配列なら false', () => {
    const diff: LearningDiffResponse = { cut: [], words: [], telops: [], ses: [], undistilledCount: 0 };
    expect(hasReviewableDiff(diff)).toBe(false);
  });

  it('cut が 1 件あれば true', () => {
    const diff: LearningDiffResponse = {
      ...EMPTY,
      cut: [{ kind: 'added-cut', startFrame: 0, endFrame: 10, startSec: 0, endSec: 1, text: '' }],
    };
    expect(hasReviewableDiff(diff)).toBe(true);
  });

  it('words が 1 件あれば true', () => {
    const diff: LearningDiffResponse = { ...EMPTY, words: [{ before: 'あ', after: 'い' }] };
    expect(hasReviewableDiff(diff)).toBe(true);
  });

  it('telops が 1 件あれば true', () => {
    const diff: LearningDiffResponse = {
      ...EMPTY,
      telops: [{ kind: 'changed', startFrame: 0, endFrame: 10, startSec: 0, endSec: 1, before: 'A', after: 'B' }],
    };
    expect(hasReviewableDiff(diff)).toBe(true);
  });

  it('ses が 1 件あれば true', () => {
    const diff: LearningDiffResponse = {
      ...EMPTY,
      ses: [{ kind: 'added', startFrame: 0, startSec: 0, file: 'a.mp3', nearbyText: '' }],
    };
    expect(hasReviewableDiff(diff)).toBe(true);
  });
});

const TELOP = { kind: 'changed' as const, startFrame: 0, endFrame: 30, startSec: 0, endSec: 1, before: 'ゆる素振り', after: 'ゆるい素振り' };
const KEY = { jobId: 'job-1', documentId: 'doc-a', contentHash: 'c'.repeat(64) };
const DIFF: LearningDiffResponse = { ...EMPTY, telops: [TELOP], aiEditCount: 0, baselineLabel: '新エディターへ取り込んだ時点の内容', candidateKey: KEY };
const RESULT: LearningApproveResponse = { cutRulesPromoted: 0, cutConflicts: 0, wordsPromoted: 0, wordConflicts: 0, telopRulesPromoted: 0,
  telopConflicts: 0, seRulesPromoted: 0, seConflicts: 0, undistilledCount: 1, recorded: { cut: 0, words: 0, telops: 1, ses: 0 }, alreadyRecorded: 0, promotedRules: [] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('useLearningDiff', () => {
  it('jobId 付きで差分を読み、読み込み中・表示中の open は無視する', async () => {
    const fetchMock = vi.fn(async (_url: string) => json(200, DIFF));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useLearningDiff());
    act(() => { result.current.open('case-a', 'job-1'); result.current.open('case-a', 'job-2'); });
    await waitFor(() => expect(result.current.state.status).toBe('review'));
    act(() => result.current.open('case-a', 'job-3'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/learning/diff?id=case-a&job=job-1');
    expect(result.current.state).toMatchObject({ status: 'review', projectId: 'case-a', jobId: 'job-1', error: null });
  });

  it('差分が0件でも確認画面を開き、閉じた後は次の書き出しでも開ける', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string) => json(200, EMPTY)));
    const events: Event[] = [];
    const listener = (event: Event) => events.push(event);
    window.addEventListener('harness-editor-notification', listener);
    try {
      const { result } = renderHook(() => useLearningDiff());
      act(() => result.current.open('case-a', 'job-1'));
      expect(result.current.state.status).toBe('loading');
      await waitFor(() => expect(result.current.state).toMatchObject({ status: 'review', jobId: 'job-1', diff: EMPTY }));
      expect(events).toEqual([]);
      act(() => result.current.dismiss());
      act(() => result.current.open('case-a', 'job-2'));
      expect(result.current.state).toMatchObject({ status: 'loading', jobId: 'job-2' });
    } finally { window.removeEventListener('harness-editor-notification', listener); }
  });

  it('閉じた後に届いた古いジョブの応答は捨てる', async () => {
    const first = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(json(200, { ...DIFF, candidateKey: { ...KEY, jobId: 'job-2' } })));
    const { result } = renderHook(() => useLearningDiff());
    act(() => result.current.open('case-a', 'job-1'));
    act(() => result.current.dismiss());
    act(() => result.current.open('case-a', 'job-2'));
    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'review', jobId: 'job-2' }));
    await act(async () => { first.resolve(json(200, DIFF)); await first.promise; });
    expect(result.current.state).toMatchObject({ status: 'review', jobId: 'job-2' });
  });

  it('読み込みに失敗したらパネルを出さず、通知・エラー履歴へ理由を1件残す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { error: '書き出しジョブが見つかりません' })));
    const events: CustomEvent[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent);
    window.addEventListener('harness-editor-notification', listener);
    try {
      const { result } = renderHook(() => useLearningDiff());
      act(() => result.current.open('case-a', 'job-1'));
      await waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]!.detail).toMatchObject({ projectId: 'case-a', source: LEARNING_NOTIFICATION_SOURCE, severity: 'error',
        message: expect.stringContaining('書き出しジョブが見つかりません') });
      expect(result.current.state.status).toBe('hidden');
      expect(events).toHaveLength(1);
    } finally { window.removeEventListener('harness-editor-notification', listener); }
  });

  it('送信中・完了画面の表示中の open も無視する', async () => {
    const approval = deferred<Response>();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? approval.promise : json(200, DIFF)));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useLearningDiff());
    act(() => result.current.open('case-a', 'job-1'));
    await waitFor(() => expect(result.current.state.status).toBe('review'));
    act(() => result.current.approve([], [], [TELOP], []));
    act(() => result.current.open('case-a', 'job-2'));
    expect(result.current.state).toMatchObject({ status: 'submitting', jobId: 'job-1' });
    await act(async () => { approval.resolve(json(200, RESULT)); await approval.promise; });
    await waitFor(() => expect(result.current.state.status).toBe('done'));
    act(() => result.current.open('case-a', 'job-3'));
    expect(result.current.state).toMatchObject({ status: 'done', jobId: 'job-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('承認には照合キーを付けて送り、件数は応答の recorded の合計を使う（記録済みで弾かれた分は数えない）', async () => {
    const duplicate: LearningApproveResponse = { ...RESULT, recorded: { cut: 0, words: 0, telops: 0, ses: 0 }, alreadyRecorded: 1 };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? json(200, duplicate) : json(200, DIFF)));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useLearningDiff());
    act(() => result.current.open('case-a', 'job-1'));
    await waitFor(() => expect(result.current.state.status).toBe('review'));
    act(() => result.current.approve([], [], [TELOP], []));
    await waitFor(() => expect(result.current.state.status).toBe('done'));
    const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ projectId: 'case-a', cut: [], words: [], telops: [TELOP], ses: [], ...KEY });
    expect(result.current.state).toMatchObject({ status: 'done', recordedCount: 0 });
  });

  it('応答に recorded が無ければ（旧サーバー）、送った件数を記録件数とする', async () => {
    const { recorded: _omitted, ...withoutRecorded } = RESULT;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? json(200, withoutRecorded) : json(200, DIFF))));
    const { result } = renderHook(() => useLearningDiff());
    act(() => result.current.open('case-a', 'job-1'));
    await waitFor(() => expect(result.current.state.status).toBe('review'));
    act(() => result.current.approve([], [], [TELOP, { ...TELOP, startFrame: 60 }], []));
    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'done', recordedCount: 2 }));
  });

  it('承認に失敗したらパネルを閉じずに理由を出し、再度押すと記録できる', async () => {
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return json(200, DIFF);
      return fail ? json(500, { error: 'ディスクに書き込めません' }) : json(200, RESULT);
    }));
    const { result } = renderHook(() => useLearningDiff());
    act(() => result.current.open('case-a', 'job-1'));
    await waitFor(() => expect(result.current.state.status).toBe('review'));
    act(() => result.current.approve([], [], [TELOP], []));
    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'review', error: expect.stringContaining('ディスクに書き込めません') }));
    fail = false;
    act(() => result.current.approve([], [], [TELOP], []));
    await waitFor(() => expect(result.current.state.status).toBe('done'));
  });

  it('選択0件の承認は送らずに閉じる（今回は学習しないと同じ）', async () => {
    const fetchMock = vi.fn(async () => json(200, DIFF));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useLearningDiff());
    act(() => result.current.open('case-a', 'job-1'));
    await waitFor(() => expect(result.current.state.status).toBe('review'));
    act(() => result.current.approve([], [], [], []));
    expect(result.current.state.status).toBe('hidden');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('台帳の更新に失敗した応答は、完了画面へ進んだうえで通知にも残す', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? json(200, { ...RESULT, ledgerError: 'EACCES' }) : json(200, DIFF))));
    const events: CustomEvent[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent);
    window.addEventListener('harness-editor-notification', listener);
    try {
      const { result } = renderHook(() => useLearningDiff());
      act(() => result.current.open('case-a', 'job-1'));
      await waitFor(() => expect(result.current.state.status).toBe('review'));
      act(() => result.current.approve([], [], [TELOP], []));
      await waitFor(() => expect(result.current.state.status).toBe('done'));
      expect(events.map((event) => event.detail.message)).toEqual([expect.stringContaining('EACCES')]);
    } finally { window.removeEventListener('harness-editor-notification', listener); }
  });
});

describe('useLearningDiff の古い応答・後始末', () => {
  it('承認中に閉じたら、届いた承認応答は捨てて閉じたままにし、次の書き出しで開ける', async () => {
    const approval = deferred<Response>();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? approval.promise : json(200, DIFF)));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useLearningDiff());
    act(() => result.current.open('case-a', 'job-1'));
    await waitFor(() => expect(result.current.state.status).toBe('review'));
    act(() => result.current.approve([], [], [TELOP], []));
    expect(result.current.state.status).toBe('submitting');
    act(() => result.current.dismiss());
    act(() => result.current.open('case-a', 'job-2'));
    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'review', jobId: 'job-2' }));
    await act(async () => { approval.resolve(json(200, RESULT)); await approval.promise; });
    expect(result.current.state).toMatchObject({ status: 'review', jobId: 'job-2' });
  });

  it('承認中に閉じた後に届いた承認失敗では、パネルを出し直さない', async () => {
    const approval = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? approval.promise : json(200, DIFF))));
    const { result } = renderHook(() => useLearningDiff());
    act(() => result.current.open('case-a', 'job-1'));
    await waitFor(() => expect(result.current.state.status).toBe('review'));
    act(() => result.current.approve([], [], [TELOP], []));
    act(() => result.current.dismiss());
    await act(async () => { approval.resolve(json(500, { error: 'ディスクに書き込めません' })); await approval.promise; });
    expect(result.current.state.status).toBe('hidden');
  });

  it('承認中に閉じても、届いた応答の台帳の失敗は通知に残す（状態は閉じたまま）', async () => {
    const approval = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? approval.promise : json(200, DIFF))));
    const events: CustomEvent[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent);
    window.addEventListener('harness-editor-notification', listener);
    try {
      const { result } = renderHook(() => useLearningDiff());
      act(() => result.current.open('case-a', 'job-1'));
      await waitFor(() => expect(result.current.state.status).toBe('review'));
      act(() => result.current.approve([], [], [TELOP], []));
      act(() => result.current.dismiss());
      await act(async () => { approval.resolve(json(200, { ...RESULT, ledgerError: 'EACCES' })); await approval.promise; });
      expect(events.map((event) => event.detail)).toEqual([expect.objectContaining({ projectId: 'case-a', source: LEARNING_NOTIFICATION_SOURCE, message: expect.stringContaining('EACCES') })]);
      expect(result.current.state.status).toBe('hidden');
    } finally { window.removeEventListener('harness-editor-notification', listener); }
  });

  it('閉じた後に届いた読み込み失敗は通知しない', async () => {
    const first = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first.promise));
    const events: Event[] = [];
    const listener = (event: Event) => events.push(event);
    window.addEventListener('harness-editor-notification', listener);
    try {
      const { result } = renderHook(() => useLearningDiff());
      act(() => result.current.open('case-a', 'job-1'));
      act(() => result.current.dismiss());
      await act(async () => { first.resolve(json(500, { error: '読めません' })); await first.promise; });
      expect(events).toEqual([]);
      expect(result.current.state.status).toBe('hidden');
    } finally { window.removeEventListener('harness-editor-notification', listener); }
  });

  it('アンマウント後に届いた読み込み失敗は通知しないが、台帳の失敗は通知に残す', async () => {
    const load = deferred<Response>();
    const approval = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(load.promise).mockResolvedValueOnce(json(200, DIFF)).mockReturnValueOnce(approval.promise));
    const events: CustomEvent[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent);
    window.addEventListener('harness-editor-notification', listener);
    try {
      const first = renderHook(() => useLearningDiff());
      act(() => first.result.current.open('case-a', 'job-1'));
      first.unmount();
      await act(async () => { load.resolve(json(500, { error: '読めません' })); await load.promise; });
      expect(events).toEqual([]);
      const second = renderHook(() => useLearningDiff());
      act(() => second.result.current.open('case-a', 'job-2'));
      await waitFor(() => expect(second.result.current.state.status).toBe('review'));
      act(() => second.result.current.approve([], [], [TELOP], []));
      second.unmount();
      await act(async () => { approval.resolve(json(200, { ...RESULT, ledgerError: 'EACCES' })); await approval.promise; });
      expect(events.map((event) => event.detail.message)).toEqual([expect.stringContaining('EACCES')]);
    } finally { window.removeEventListener('harness-editor-notification', listener); }
  });

  it('承認を同じ瞬間に2回押しても送るのは1回', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? json(200, RESULT) : json(200, DIFF)));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useLearningDiff());
    act(() => result.current.open('case-a', 'job-1'));
    await waitFor(() => expect(result.current.state.status).toBe('review'));
    act(() => { result.current.approve([], [], [TELOP], []); result.current.approve([], [], [TELOP], []); });
    await waitFor(() => expect(result.current.state.status).toBe('done'));
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });

  it('StrictMode（後始末と再セットアップの二重実行）でも、開く→承認→完了まで進む', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? json(200, RESULT) : json(200, DIFF))));
    const { result } = renderHook(() => useLearningDiff(), { wrapper: StrictMode });
    act(() => result.current.open('case-a', 'job-1'));
    await waitFor(() => expect(result.current.state.status).toBe('review'));
    act(() => result.current.approve([], [], [TELOP], []));
    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'done', jobId: 'job-1', recordedCount: 1 }));
  });

  it('open・approve・dismiss は描画をまたいで同じ関数（呼び出し側の依存を揺らさない）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, DIFF)));
    const { result, rerender } = renderHook(() => useLearningDiff());
    const { open, approve, dismiss } = result.current;
    act(() => result.current.open('case-a', 'job-1'));
    await waitFor(() => expect(result.current.state.status).toBe('review'));
    rerender();
    expect(result.current.open).toBe(open);
    expect(result.current.approve).toBe(approve);
    expect(result.current.dismiss).toBe(dismiss);
  });
});
