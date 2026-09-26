/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { NativeLearningReview } from './NativeLearningReview';
import { useLearningDiff } from '../useLearningDiff';
import type { LearningApproveResponse, LearningDiffResponse } from '../../shared/types';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const DIFF: LearningDiffResponse = { cut: null, words: null, ses: null, undistilledCount: 0, aiEditCount: 0, baselineLabel: '新エディターへ取り込んだ時点の内容',
  telops: [
    { kind: 'changed', startFrame: 0, endFrame: 60, startSec: 0, endSec: 2, before: 'ゆる素振り', after: 'ゆるい素振り' },
    { kind: 'added', startFrame: 205, endFrame: 245, startSec: 205 / 30, endSec: 245 / 30, before: '', after: '追加した字幕' }],
  candidateKey: { jobId: 'job-1', documentId: 'doc-a', contentHash: 'c'.repeat(64) } };
const RESULT: LearningApproveResponse = { cutRulesPromoted: 0, cutConflicts: 0, wordsPromoted: 0, wordConflicts: 0, telopRulesPromoted: 0,
  telopConflicts: 0, seRulesPromoted: 0, seConflicts: 0, undistilledCount: 1, recorded: { cut: 0, words: 0, telops: 1, ses: 0 }, alreadyRecorded: 0, promotedRules: [] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function Harness() {
  const learning = useLearningDiff();
  useEffect(() => { learning.open('case-a', 'job-1'); }, []);
  return <NativeLearningReview learning={learning} />;
}

it('承認に失敗しても外したチェックは残り、押し直すと完了画面になり「閉じる」で消える', async () => {
  let fail = true;
  const posts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return json(200, DIFF);
    posts.push(JSON.parse(String(init.body)));
    return fail ? json(500, { error: 'ディスクに書き込めません' }) : json(200, RESULT);
  }));
  const view = render(<Harness />);
  await waitFor(() => expect(view.getByRole('dialog', { name: 'AIとの差分レビュー' })).toBeTruthy());
  fireEvent.click(view.getAllByRole('checkbox')[1]!);
  await act(async () => fireEvent.click(view.getByRole('button', { name: '選択分を学習する' })));
  await waitFor(() => expect(view.getByRole('alert').textContent).toContain('ディスクに書き込めません'));
  expect(view.getAllByRole('checkbox').map((box) => (box as HTMLInputElement).checked)).toEqual([true, false]);
  fail = false;
  await act(async () => fireEvent.click(view.getByRole('button', { name: '選択分を学習する' })));
  await waitFor(() => expect(view.getByRole('dialog', { name: '学習結果' }).textContent).toContain('修正 1 件を記録しました（ルール昇格 0 件）。'));
  expect(posts).toHaveLength(2);
  expect(posts[1]).toMatchObject({ telops: [DIFF.telops![0]], jobId: 'job-1', documentId: 'doc-a' });
  fireEvent.click(view.getByRole('button', { name: '閉じる' }));
  expect(view.queryByRole('dialog')).toBeNull();
});

it('台帳の更新に失敗した承認は、完了画面に注意の1行を出す', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method !== 'POST' ? json(200, DIFF) : json(200, { ...RESULT, ledgerError: 'EACCES' })));
  const view = render(<Harness />);
  await waitFor(() => expect(view.getByRole('dialog', { name: 'AIとの差分レビュー' })).toBeTruthy());
  await act(async () => fireEvent.click(view.getByRole('button', { name: '選択分を学習する' })));
  const done = await waitFor(() => view.getByRole('dialog', { name: '学習結果' }));
  expect(done.querySelector('[role="alert"]')?.textContent).toContain('スキル側の取り出し済み台帳を更新できませんでした');
});

it('他のダイアログ（.preference-overlay）が開いている間は学習パネルを描かず、閉じたら描いてフォーカスする', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, DIFF)));
  const overlay = document.createElement('div');
  overlay.className = 'preference-overlay';
  document.body.appendChild(overlay);
  try {
    const view = render(<Harness />);
    // 差分の取得は進むが、他のダイアログが開いている間はパネルを描かない・フォーカスも移さない。
    await waitFor(() => expect(document.activeElement).toBe(document.body));
    expect(view.queryByRole('dialog')).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(view.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(document.body);

    // 他のダイアログが閉じたら、その時点で同じジョブの差分（取り直さない）でパネルを描き、フォーカスを移す。
    act(() => { document.body.removeChild(overlay); });
    await waitFor(() => expect(view.getByRole('dialog', { name: 'AIとの差分レビュー' })).toBeTruthy());
    expect(view.getByRole('dialog', { name: 'AIとの差分レビュー' })).toBe(document.activeElement);
  } finally {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
});

it('review へ切り替わった最初の描画でも、他のダイアログがある間は一度も focus() を呼ばない', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, DIFF)));
  const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
  const overlay = document.createElement('div');
  overlay.className = 'preference-overlay';
  document.body.appendChild(overlay);
  try {
    render(<Harness />);
    // useLearningDiff が hidden→loading→review と非同期に遷移する最初の描画（review 判定直後）でも
    // DiffReviewPanel の mount effect が補正より先に focus() を呼んではいけない（Task 12 の再発）。
    await new Promise((r) => setTimeout(r, 20));
    // 存在検査: review に切り替わり、パネルは隠れた状態で描かれている（下の「focus 無し」が未到達の空振りでない）。
    await waitFor(() => expect(document.querySelector('.diff-review-overlay[hidden]')).not.toBeNull());
    // 見えている（hidden でない）学習パネルは1つも無い。
    expect(document.querySelectorAll('.diff-review-overlay:not([hidden])').length).toBe(0);
    expect(focusSpy).not.toHaveBeenCalled();
  } finally {
    focusSpy.mockRestore();
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
});

it('他のダイアログが無ければ学習パネルはすぐ描かれる', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, DIFF)));
  const view = render(<Harness />);
  await waitFor(() => expect(view.getByRole('dialog', { name: 'AIとの差分レビュー' })).toBeTruthy());
  expect(view.getByRole('dialog', { name: 'AIとの差分レビュー' })).toBe(document.activeElement);
});

it('表示中に他のダイアログが現れても外したチェックは消えず、隠れている間は Esc・Tab に反応しない', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, DIFF)));
  const view = render(<Harness />);
  await waitFor(() => expect(view.getByRole('dialog', { name: 'AIとの差分レビュー' })).toBeTruthy());
  fireEvent.click(view.getAllByRole('checkbox')[1]!);
  expect(view.getAllByRole('checkbox').map((box) => (box as HTMLInputElement).checked)).toEqual([true, false]);

  const overlay = document.createElement('div');
  overlay.className = 'preference-overlay';
  const inside = document.createElement('button');
  overlay.appendChild(inside);
  try {
    act(() => { document.body.appendChild(overlay); });
    // 隠す（unmount しない）: 読み上げ・操作の対象から外れ、要素は残る。
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    const hidden = document.querySelector('.diff-review-overlay');
    expect(hidden).not.toBeNull();
    expect(hidden!.hasAttribute('hidden')).toBe(true);
    expect(hidden!.hasAttribute('inert')).toBe(true);
    // 隠れている学習パネルは Esc で閉じない・Tab を奪わない（他のダイアログの操作を横取りしない）。
    inside.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(inside, { key: 'Tab' });
    expect(document.activeElement).toBe(inside);
    expect(document.querySelector('.diff-review-overlay')).not.toBeNull();

    act(() => { document.body.removeChild(overlay); });
    const panel = await waitFor(() => view.getByRole('dialog', { name: 'AIとの差分レビュー' }));
    expect(panel).toBe(document.activeElement);
    expect(view.getAllByRole('checkbox').map((box) => (box as HTMLInputElement).checked)).toEqual([true, false]);
  } finally {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
});
