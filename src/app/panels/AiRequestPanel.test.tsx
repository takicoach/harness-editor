// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InstructionInput, InstructionRecord } from '../../shared/types';
import { ClaudePanel } from './ClaudePanel';

const state = vi.hoisted(() => ({ receive: (_message: unknown) => {}, post: vi.fn(), get: vi.fn() }));
vi.mock('../eventBus', () => ({ useEventChannel: (_ch: string, receive: (m: unknown) => void) => { state.receive = receive; } }));
vi.mock('../useAgentConnected', () => ({ useAgentConnected: () => ({ global: false, dedicated: false }) }));
vi.mock('../fetchJson', () => ({ putJsonPost: (...args: unknown[]) => state.post(...args), fetchJson: (...args: unknown[]) => state.get(...args) }));
vi.mock('./AiTerminal', () => ({ AiTerminal: () => <div data-testid="actual-terminal">接続画面</div> }));
const context = () => ({ frame: 30, timeSec: 1, selection: null });
const props = { open: true, onToggle: () => {}, buildContext: context, embedded: true };
function receipt(input: InstructionInput, extra: Partial<InstructionRecord> = {}): InstructionRecord {
  return { ...input, id: 'inst-1', projectDir: '/owned/'+input.projectId, status: 'pending', reply: null, createdAt: 10, updatedAt: 10, ...extra };
}
beforeEach(() => { localStorage.clear();state.post.mockReset();state.get.mockReset().mockResolvedValue({ messages: [] }); });
afterEach(cleanup);

it('opens the connection terminal only when explicitly requested', () => {
  render(<ClaudePanel {...props} projectId="A" />);
  expect(screen.queryByTestId('actual-terminal')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'AIの接続・設定' }));
  expect(screen.getByTestId('actual-terminal')).toBeTruthy();
});

it('keeps drafts separate when switching projects and returning', () => {
  const view = render(<ClaudePanel {...props} projectId="A" />);
  fireEvent.change(screen.getByLabelText('依頼内容'), { target: { value: 'Aだけ直す' } });
  view.rerender(<ClaudePanel {...props} projectId="B" />);
  expect((screen.getByLabelText('依頼内容') as HTMLTextAreaElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('依頼内容'), { target: { value: 'Bだけ直す' } });
  view.rerender(<ClaudePanel {...props} projectId="A" />);
  expect((screen.getByLabelText('依頼内容') as HTMLTextAreaElement).value).toBe('Aだけ直す');
});

it('replays exactly the same receipt request after lost acknowledgement, even after a remount and new playhead', async () => {
  state.post.mockRejectedValueOnce(new Error('response lost')).mockImplementationOnce(async (_url, input) => receipt(input));
  const first = render(<ClaudePanel {...props} projectId="A" />);
  fireEvent.change(screen.getByLabelText('依頼内容'), { target: { value: '選んだ字幕を直す' } });
  fireEvent.click(screen.getByRole('button', { name: '依頼を送る' }));
  await screen.findByRole('alert');
  const original = state.post.mock.calls[0]![1];first.unmount();
  render(<ClaudePanel {...props} projectId="A" buildContext={() => ({ frame: 999, timeSec: 33.3, selection: null })} />);
  fireEvent.click(screen.getByRole('button', { name: 'この依頼の受付を確認' }));
  await screen.findByText('受付済み・AI待ち');
  expect(state.post.mock.calls[1]![1]).toEqual(original);
  expect(state.post.mock.calls[1]![1].context.frame).toBe(30);
  expect(screen.getAllByText('受付番号：inst-1')).toHaveLength(1);
});

it('does not show an old project receipt in a newly selected project', async () => {
  let resolve!: (record: InstructionRecord) => void;
  state.post.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const view = render(<ClaudePanel {...props} projectId="A" />);
  fireEvent.change(screen.getByLabelText('依頼内容'), { target: { value: 'Aを直す' } });
  fireEvent.click(screen.getByRole('button', { name: '依頼を送る' }));
  const input = state.post.mock.calls[0]![1];view.rerender(<ClaudePanel {...props} projectId="B" />);
  fireEvent.change(screen.getByLabelText('依頼内容'), { target: { value: 'Bの下書き' } });
  await act(async () => resolve(receipt(input)));
  expect(screen.queryByText('受付番号：inst-1')).toBeNull();
  expect((screen.getByLabelText('依頼内容') as HTMLTextAreaElement).value).toBe('Bの下書き');
});

it('keeps an acknowledged event when the HTTP response later fails', async () => {
  let reject!: (error: Error) => void;
  state.post.mockImplementationOnce(() => new Promise((_r, fail) => { reject = fail; }));
  render(<ClaudePanel {...props} projectId="A" />);
  fireEvent.change(screen.getByLabelText('依頼内容'), { target: { value: 'Aを直す' } });
  fireEvent.click(screen.getByRole('button', { name: '依頼を送る' }));
  act(() => state.receive({ type: 'update', record: receipt(state.post.mock.calls[0]![1]) }));
  await act(async () => reject(new Error('lost response')));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('受付済み・AI待ち')).toBeTruthy();
});

it('does not regress history on stale events or infer save from the agent reply', async () => {
  render(<ClaudePanel {...props} projectId="A" />);
  const input = { projectId: 'A', text: '字幕修正', context: context() };
  act(() => state.receive({ type: 'update', record: receipt(input, { status: 'done', updatedAt: 30, reply: 'できました' }) }));
  act(() => state.receive({ type: 'update', record: receipt(input, { status: 'processing', updatedAt: 20 }) }));
  act(() => state.receive({ type: 'update', record: receipt({ ...input, projectId: 'B' }, { text: '別案件の依頼' }) }));
  await waitFor(() => expect(screen.getByText('処理結果あり')).toBeTruthy());
  expect(screen.queryByText('処理中')).toBeNull();expect(screen.queryByText('別案件の依頼')).toBeNull();
  expect(screen.queryByText('保存済み')).toBeNull();expect(screen.getByText('AIからの返答')).toBeTruthy();
});

it('reports unavailable history as unknown, and recovers through a normal read', async () => {
  state.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ messages: [] });
  render(<ClaudePanel {...props} projectId="A" />);
  await screen.findByText('受付済みの依頼があるか不明です。');
  expect(screen.queryByText('まだ依頼はありません。')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '履歴を更新' }));
  await screen.findByText('まだ依頼はありません。');
  expect(state.post).not.toHaveBeenCalled();
});
