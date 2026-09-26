/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeAudioFixSettings } from './NativeAudioFixSettings';
import { speechDocument } from './__fixtures__/audioFixFixture';
import type { SequenceDocument } from '../../core/sequence/model';
import type { NativeCommand } from './api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const props = (over: Record<string, unknown> = {}) => {
  const document = (over.document as ReturnType<typeof speechDocument>) ?? speechDocument();
  return {
    projectId: 'p1', document, readDocument: () => document, disabled: false, exporting: false,
    onEdit: vi.fn(async (_build: (current: SequenceDocument) => NativeCommand) => true),
    onRegister: vi.fn(async (_assetIds: string[]) => true), onNotice: vi.fn((_message: string) => undefined),
    ...over,
  };
};
const ok = (asset: { id: string }) => vi.fn().mockResolvedValue({ ok: true, json: async () => ({ asset, kind: 'denoise', from: 'source' }) });

it('ノイズ除去と音量正規化の 2 つを出す', () => {
  const view = render(<NativeAudioFixSettings {...props()} />);
  expect(view.getByRole('button', { name: 'ノイズ除去を実行' })).toBeTruthy();
  expect(view.getByRole('button', { name: '音量正規化を実行' })).toBeTruthy();
  expect(view.queryByRole('status')).toBeNull();
});

it('原音のトラックが無ければ実行させない', () => {
  const view = render(<NativeAudioFixSettings {...props({ document: speechDocument({ speech: false }) })} />);
  expect(view.queryByRole('button', { name: 'ノイズ除去を実行' })).toBeNull();
  expect(view.getByText('原音のトラックがありません。')).toBeTruthy();
});

it('書き出し中は実行できない', () => {
  const view = render(<NativeAudioFixSettings {...props({ exporting: true })} />);
  expect((view.getByRole('button', { name: 'ノイズ除去を実行' }) as HTMLButtonElement).disabled).toBe(true);
  expect((view.getByRole('button', { name: '音量正規化を実行' }) as HTMLButtonElement).disabled).toBe(true);
  expect(view.getByRole('status').textContent).toContain('書き出し中');
});

it('両方かけた後の取り消しは 2 択になり、掛け済みの補正は押せない', () => {
  const view = render(<NativeAudioFixSettings {...props({ document: speechDocument({ applied: ['denoise', 'normalize'] }) })} />);
  expect(view.getByRole('button', { name: '正規化だけ戻す（除去済みへ）' })).toBeTruthy();
  expect(view.getByRole('button', { name: '両方戻す（原本へ）' })).toBeTruthy();
  expect((view.getByRole('button', { name: 'ノイズ除去を実行' }) as HTMLButtonElement).disabled).toBe(true);
  expect((view.getByRole('button', { name: '音量正規化を実行' }) as HTMLButtonElement).disabled).toBe(true);
});

it('C3: 原本探索は系譜をたどって原本に着く（中間の素材が欠けると着けない）', () => {
  const full = render(<NativeAudioFixSettings {...props({ document: speechDocument({ applied: ['denoise', 'normalize'] }) })} />);
  expect(full.getByText(/主音声「main\.mp4」/)).toBeTruthy();
  expect(full.getByRole('button', { name: '両方戻す（原本へ）' })).toBeTruthy();
  cleanup();
  // 中間（ノイズ除去済み）を外すと origin.from の連鎖が切れ、音声があるのに戻せなくなる。
  // core 側で remove-asset がこの素材を守っている理由（assetLifecycle.test.ts の C3）。
  const broken = speechDocument({ applied: ['denoise', 'normalize'] });
  broken.assets = broken.assets.filter(item => item.id !== 'source-denoise');
  const view = render(<NativeAudioFixSettings {...props({ document: broken })} />);
  expect(view.queryByRole('button', { name: '両方戻す（原本へ）' })).toBeNull();
  expect(view.getByText('原音のトラックがありません。')).toBeTruthy();
});

it('片方だけなら取り消しは 1 つ', () => {
  const view = render(<NativeAudioFixSettings {...props({ document: speechDocument({ applied: ['denoise'] }) })} />);
  expect(view.getByRole('button', { name: '原本へ戻す' })).toBeTruthy();
  expect(view.queryByRole('button', { name: /両方戻す/ })).toBeNull();
});

it('「原本へ戻す」は原本への replace-audio-source を 1 回だけ送る', async () => {
  const p = props({ document: speechDocument({ applied: ['denoise', 'normalize'] }) });
  const view = render(<NativeAudioFixSettings {...p} />);
  fireEvent.click(view.getByRole('button', { name: '両方戻す（原本へ）' }));
  await waitFor(() => expect(p.onEdit).toHaveBeenCalledTimes(1));
  expect(p.onEdit.mock.calls[0]![0](p.document)).toEqual({
    type: 'replace-audio-source', trackId: 'a1', fromAssetId: 'source-normalize', toAssetId: 'source',
  });
});

// T29 Minor: 連打しても 1 回目の結果が確定するまで 2 回目を出さない（古い fromAssetId で偽エラーにしない）。
it('「戻す」を連打しても replace-audio-source は 1 回だけ・偽のエラーを出さない', async () => {
  let release!: (value: boolean) => void;
  const p = props({ document: speechDocument({ applied: ['denoise', 'normalize'] }),
    onEdit: vi.fn(() => new Promise<boolean>(resolve => { release = resolve; })) });
  const view = render(<NativeAudioFixSettings {...p} />);
  const button = view.getByRole('button', { name: '両方戻す（原本へ）' });
  fireEvent.click(button);
  await waitFor(() => expect(p.onEdit).toHaveBeenCalledTimes(1));
  fireEvent.click(button);
  fireEvent.click(button);
  expect(p.onEdit).toHaveBeenCalledTimes(1);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  release(true);
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  expect(p.onNotice).not.toHaveBeenCalled();
});

it('失敗したら document を変えず、次の一手を通知に出す', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'ffmpeg が見つかりません' }) }));
  const p = props();
  const view = render(<NativeAudioFixSettings {...p} />);
  fireEvent.click(view.getByRole('button', { name: 'ノイズ除去を実行' }));
  await waitFor(() => expect(p.onNotice).toHaveBeenCalled());
  expect(p.onEdit).not.toHaveBeenCalled();
  expect(p.onRegister).not.toHaveBeenCalled();
  const message = String(p.onNotice.mock.calls[0]![0]);
  expect(message).toContain('ffmpeg が見つかりません');
  expect(message).toContain('元の音声のままです');
  expect(message).toContain('ノイズ除去を実行');
});

it('成功したら register → replace-audio-source の順に呼ぶ', async () => {
  vi.stubGlobal('fetch', ok({ id: 'source-denoised' }));
  const p = props();
  const view = render(<NativeAudioFixSettings {...p} />);
  fireEvent.click(view.getByRole('button', { name: 'ノイズ除去を実行' }));
  await waitFor(() => expect(p.onEdit).toHaveBeenCalled());
  expect(p.onRegister).toHaveBeenCalledWith(['source-denoised']);
  expect(p.onRegister.mock.invocationCallOrder[0]!).toBeLessThan(p.onEdit.mock.invocationCallOrder[0]!);
  expect(p.onEdit.mock.calls[0]![0](p.document)).toEqual({
    type: 'replace-audio-source', trackId: 'a1', fromAssetId: 'source', toAssetId: 'source-denoised',
  });
});

it('補正中に編集が進んだら切り替えず、やり直し方を通知する', async () => {
  const document = speechDocument();
  let current = document;
  // 補正の最中（サーバー応答の直前）に別の編集が入った状況を作る。
  // I2 のマウント時ポーリング（GET .../status）も同じ fetch を通るため、POST（実際の補正実行）だけに反応させる。
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init?: { method?: string }) => {
    if (init?.method !== 'POST') return { ok: true, json: async () => ({ running: null }) };
    current = { ...document, revision: document.revision + 1 };
    return { ok: true, json: async () => ({ asset: { id: 'source-denoised' }, kind: 'denoise', from: 'source' }) };
  }));
  const p = props({ document, readDocument: () => current });
  const view = render(<NativeAudioFixSettings {...p} />);
  fireEvent.click(view.getByRole('button', { name: 'ノイズ除去を実行' }));
  await waitFor(() => expect(p.onNotice).toHaveBeenCalled());
  expect(p.onRegister).not.toHaveBeenCalled();
  expect(p.onEdit).not.toHaveBeenCalled();
  expect(String(p.onNotice.mock.calls[0]![0])).toContain('編集が進んだため切り替えていません');
});

it('I2: マウント時に status を読み、実行中なら操作を止めて「実行中」を表示。完了で解除される', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
    calls++;
    return Promise.resolve({ ok: true, json: async () => ({ running: calls === 1 ? 'denoise' : null }) });
  }));
  const view = render(<NativeAudioFixSettings {...props()} />);
  await waitFor(() => expect((view.getByRole('button', { name: 'ノイズ除去を実行' }) as HTMLButtonElement).disabled).toBe(true));
  expect((view.getByRole('button', { name: '音量正規化を実行' }) as HTMLButtonElement).disabled).toBe(true);
  expect(view.getByRole('status').textContent).toContain('実行中');
  await waitFor(() => expect((view.getByRole('button', { name: 'ノイズ除去を実行' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
  expect(view.queryByRole('status')).toBeNull();
});

// M-7: 何も走っていない間は 400ms ごとに叩かない（マウント時の 1 回だけ）。
it('M-7: 待機中はポーリングせず、実行が始まったら追従する', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ running: null }) });
  vi.stubGlobal('fetch', fetchMock);
  render(<NativeAudioFixSettings {...props()} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('I2: アンマウントで status のポーリングを止める', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ running: null }) });
  vi.stubGlobal('fetch', fetchMock);
  render(<NativeAudioFixSettings {...props()} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  cleanup();
  const callsAtUnmount = fetchMock.mock.calls.length;
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(fetchMock.mock.calls.length).toBe(callsAtUnmount);
});

it('取り込みに失敗したら参照を切り替えない', async () => {
  vi.stubGlobal('fetch', ok({ id: 'source-denoised' }));
  const p = props({ onRegister: vi.fn(async (_assetIds: string[]) => false) });
  const view = render(<NativeAudioFixSettings {...p} />);
  fireEvent.click(view.getByRole('button', { name: 'ノイズ除去を実行' }));
  await waitFor(() => expect(p.onNotice).toHaveBeenCalled());
  expect(p.onEdit).not.toHaveBeenCalled();
  expect(String(p.onNotice.mock.calls[0]![0])).toContain('元の音声のままです');
});
