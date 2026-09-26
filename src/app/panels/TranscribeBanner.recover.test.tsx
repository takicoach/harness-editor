/**
 * @vitest-environment jsdom
 */
/**
 * status-ia-6: 文字起こしのやり直しがキャンセル／失敗で終端に固まらないこと。
 * 「もう一度実行」で再実行が走り、「閉じる」で idle 相当（案内＋開始ボタン）へ戻る。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { TranscribeBanner } from './TranscribeBanner';

// SSE バスは本テストの対象外。購読関数だけを捕まえて手で流し込む。
let pushEvent: ((raw: unknown) => void) | null = null;
vi.mock('../eventBus', () => ({
  useEventChannelWithSync: (_ch: string, _id: string, cb: (raw: unknown) => void) => {
    pushEvent = cb;
  },
}));
// 重いジョブの確認ダイアログは素通し（POST の戻りだけ差し替える）。
let startCalls = 0;
let pendingStart: Promise<Response> | null = null;
vi.mock('../useHeavyJobConfirm', () => ({
  useHeavyJobConfirm: () => ({
    pendingConfirm: null,
    confirm: () => {},
    dismiss: () => {},
    start: async () => {
      startCalls += 1;
      if (pendingStart) return pendingStart;
      return { ok: true, json: async () => ({ startedAt: Date.now() }) } as unknown as Response;
    },
  }),
}));

afterEach(() => {
  cleanup();
  pushEvent = null;
  startCalls = 0;
  pendingStart = null;
});

function renderBanner() {
  return render(<TranscribeBanner projectId="p1" onReloadRequested={() => {}} />);
}

describe('TranscribeBanner — 終端状態からの復帰（status-ia-6）', () => {
  it.each(['failed', 'cancelled', 'completed'] as const)('POST成功より先に届いた%sを進行中で上書きしない', async phase => {
    let respond!: (response: Response) => void;
    pendingStart = new Promise(resolve => { respond = resolve; });
    const { getByRole, container } = renderBanner();
    fireEvent.click(getByRole('button'));
    act(() => { pushEvent?.({ type: 'done', phase, error: { code: 'python-spawn-failed', message: 'Pythonを起動できません' } }); });
    expect(container.querySelector(`.tx-misalign-${phase}`)).not.toBeNull();
    await act(async () => { respond({ ok: true, json: async () => ({ startedAt: Date.now() }) } as Response); });
    expect(container.querySelector(`.tx-misalign-${phase}`)).not.toBeNull();
    expect(container.querySelector('.tx-misalign-running')).toBeNull();
  });
  it('古い開始応答が再試行の待機状態を確定しない', async () => {
    let respondOld!: (response: Response) => void, respondNew!: (response: Response) => void;
    pendingStart = new Promise(resolve => { respondOld = resolve; });
    const { getByRole, getByTestId, container } = renderBanner();
    fireEvent.click(getByRole('button'));
    act(() => { pushEvent?.({ type: 'done', phase: 'failed', error: { code: 'python-spawn-failed', message: 'failed' } }); });
    pendingStart = new Promise(resolve => { respondNew = resolve; });
    fireEvent.click(getByTestId('transcribe-retry'));
    await act(async () => { respondOld({ ok: true, json: async () => ({ startedAt: 1 }) } as Response); });
    expect(container.querySelector('.tx-misalign-starting')).not.toBeNull();
    await act(async () => { respondNew({ ok: true, json: async () => ({ startedAt: Date.now() }) } as Response); });
    expect(container.querySelector('.tx-misalign-running')).not.toBeNull();
    expect(startCalls).toBe(2);
  });
  it('終了通知より後の通信失敗でも終了結果を保つ', async () => {
    let reject!: (error: Error) => void;
    pendingStart = new Promise((_resolve, fail) => { reject = fail; });
    const { getByRole, container } = renderBanner();
    fireEvent.click(getByRole('button'));
    act(() => { pushEvent?.({ type: 'done', phase: 'completed' }); });
    await act(async () => { reject(new Error('late network failure')); });
    expect(container.querySelector('.tx-misalign-completed')).not.toBeNull();
  });
  it('キャンセル後は「もう一度実行」「閉じる」が出て、閉じると案内へ戻る', () => {
    const { getByTestId, container, queryByTestId } = renderBanner();
    act(() => {
      pushEvent?.({ type: 'done', phase: 'cancelled' });
    });
    expect(container.textContent).toContain('キャンセルしました');
    expect(queryByTestId('transcribe-retry')).not.toBeNull();

    fireEvent.click(getByTestId('transcribe-dismiss'));
    expect(queryByTestId('transcribe-retry')).toBeNull();
    // idle 相当＝単語チップが無効な理由の案内が戻る。
    expect(container.textContent).toContain('単語チップ');
  });

  it('失敗後に「もう一度実行」を押すと再実行が走る', async () => {
    const { getByTestId } = renderBanner();
    act(() => {
      pushEvent?.({ type: 'done', phase: 'failed', error: { code: 'unknown', message: 'boom' } });
    });
    await act(async () => {
      fireEvent.click(getByTestId('transcribe-retry'));
      await Promise.resolve();
    });
    expect(startCalls).toBe(1);
  });
});
