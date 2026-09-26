/**
 * @vitest-environment jsdom
 *
 * 新画面へ移植した差分レビューの実 DOM 検証（OSS 0.3.1 の文言＋設計書の追加点）。
 * 見える・押せる・重なりは jsdom では確かめられない（getBoundingClientRect は 0）。tests/native-learning.spec.ts で確かめる。
 */
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffReviewDone, DiffReviewPanel, LEDGER_WARNING_TEXT, TELOP_LEARNING_SCOPE_NOTE } from './DiffReviewPanel';
import type { LearningApproveResponse, LearningDiffResponse } from '../../shared/types';

afterEach(cleanup);

const DIFF: LearningDiffResponse = {
  cut: [{ kind: 'added-cut', startFrame: 100, endFrame: 115, startSec: 100 / 30, endSec: 115 / 30, text: 'えー' }],
  words: null,
  telops: [{ kind: 'changed', startFrame: 0, endFrame: 60, startSec: 0, endSec: 2, before: 'ゆる素振り', after: 'ゆるい素振り' }],
  ses: [{ kind: 'removed', startFrame: 30, startSec: 1, file: 'beep.mp3', nearbyText: 'ゆる素振り' }],
  undistilledCount: 21,
  aiEditCount: 0,
  baselineLabel: '新エディターへ取り込んだ時点の内容',
};
const handlers = () => ({ onApprove: vi.fn(), onDismiss: vi.fn() });

describe('DiffReviewPanel（新画面）', () => {
  it('候補が0件でも学習確認を表示し、記録せず閉じられる', () => {
    const actions = handlers();
    const view = render(<DiffReviewPanel diff={{ cut: null, words: null, telops: null, ses: null, undistilledCount: 0 }} submitting={false} {...actions} />);
    expect(view.getByRole('dialog', { name: 'AIとの差分レビュー' }).textContent).toContain('今回、学習候補はありません');
    expect(view.queryByRole('button', { name: '選択分を学習する' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: '閉じる' }));
    expect(actions.onDismiss).toHaveBeenCalledTimes(1);
    expect(actions.onApprove).not.toHaveBeenCalled();
  });
  it('比較元が無い場合は、候補0件との違いを理由とともに示す', () => {
    const view = render(<DiffReviewPanel diff={{ cut: null, words: null, telops: null, ses: null, undistilledCount: 0, unavailableReason: '新エディターで作った案件には比較元がありません' }} submitting={false} {...handlers()} />);
    expect(view.getByRole('dialog', { name: 'AIとの差分レビュー' }).textContent).toContain('書き出し後の学習チェックを実行しました');
    expect(view.getByText('学習候補を比較できませんでした')).toBeTruthy();
    expect(view.getByText(/新エディターで作った案件には比較元がありません/)).toBeTruthy();
  });
  it('OSS の見出し・件数・カテゴリ・注記・蒸留案内と、比較元の1行を出す。文字起こし修正は出さない', () => {
    const view = render(<DiffReviewPanel diff={DIFF} submitting={false} {...handlers()} />);
    const dialog = view.getByRole('dialog', { name: 'AIとの差分レビュー' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('あなたの編集から 3 件の学習候補が見つかりました');
    expect(dialog.textContent).toContain('比較元: 新エディターへ取り込んだ時点の内容');
    expect(view.getByRole('heading', { name: 'カット差分（1）' })).toBeTruthy();
    expect(view.getByRole('heading', { name: 'テロップ修正（1）' })).toBeTruthy();
    expect(view.getByRole('heading', { name: '効果音調整（1）' })).toBeTruthy();
    expect(view.queryByRole('heading', { name: /文字起こし修正/ })).toBeNull();
    expect(dialog.textContent).toContain(TELOP_LEARNING_SCOPE_NOTE);
    expect(view.getByRole('note').textContent).toContain('学習データが 21 件たまっています');
    expect(view.getByRole('button', { name: '今回は学習しない' })).toBeTruthy();
    expect(view.getByRole('button', { name: '選択分を学習する' })).toBeTruthy();
  });

  it('AI の編集が無ければチェックは全部オン、あれば警告を出して全部オフ', () => {
    const on = render(<DiffReviewPanel diff={DIFF} submitting={false} {...handlers()} />);
    expect(on.getAllByRole('checkbox').map((box) => (box as HTMLInputElement).checked)).toEqual([true, true, true]);
    expect(on.queryByText(/取り込み後に AI の編集/)).toBeNull();
    cleanup();
    const off = render(<DiffReviewPanel diff={{ ...DIFF, aiEditCount: 2 }} submitting={false} {...handlers()} />);
    expect(off.getAllByRole('checkbox').map((box) => (box as HTMLInputElement).checked)).toEqual([false, false, false]);
    expect(off.getByText('取り込み後に AI の編集が 2 回入っています。人が直した項目だけにチェックを入れてください。')).toBeTruthy();
  });

  it('開いた時にパネルへフォーカスし、Esc は「今回は学習しない」と同じ（送信中は効かない）', () => {
    const idle = handlers();
    const view = render(<DiffReviewPanel diff={DIFF} submitting={false} {...idle} />);
    expect(document.activeElement).toBe(view.getByRole('dialog'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(idle.onDismiss).toHaveBeenCalledTimes(1);
    cleanup();
    const busy = handlers();
    const sending = render(<DiffReviewPanel diff={DIFF} submitting={true} {...busy} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(busy.onDismiss).not.toHaveBeenCalled();
    expect(sending.getByRole('button', { name: '学習中…' })).toHaveProperty('disabled', true);
  });

  it('承認に失敗した理由をボタンの上に出し、押し直すと選び直した内容を送る', () => {
    const calls = handlers();
    const view = render(<DiffReviewPanel diff={DIFF} submitting={false} error="学習を記録できませんでした: ディスクに書き込めません" {...calls} />);
    const alert = view.getByRole('alert');
    expect(alert.textContent).toContain('ディスクに書き込めません');
    expect(alert.nextElementSibling?.className).toBe('diff-review-foot');
    fireEvent.click(view.getAllByRole('checkbox')[0]!);
    fireEvent.click(view.getByRole('button', { name: '選択分を学習する' }));
    expect(calls.onApprove).toHaveBeenCalledWith([], [], DIFF.telops, DIFF.ses);
  });
});

const RESULT: LearningApproveResponse = { cutRulesPromoted: 0, cutConflicts: 0, wordsPromoted: 0, wordConflicts: 0, telopRulesPromoted: 0,
  telopConflicts: 0, seRulesPromoted: 0, seConflicts: 0, undistilledCount: 0, recorded: { cut: 0, words: 0, telops: 1, ses: 0 }, alreadyRecorded: 0, promotedRules: [] };

describe('DiffReviewDone（新画面）', () => {
  it('OSS の完了文と昇格条件の注記。記録済みで弾いた分は同じ文に足す。Esc で閉じる', () => {
    const onClose = vi.fn();
    const view = render(<DiffReviewDone result={{ ...RESULT, alreadyRecorded: 2 }} recordedCount={1} onClose={onClose} />);
    const dialog = view.getByRole('dialog', { name: '学習結果' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByText('学習しました')).toBeTruthy();
    expect(dialog.textContent).toContain('修正 1 件を記録しました（ルール昇格 0 件）（うち 2 件は記録済みまたは重複のため数えていません）。');
    expect(dialog.textContent).toContain('同じ修正が別の動画でもう 1 回観測されると、AI が使うルールへ昇格します。');
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('昇格数は今回新しく増えたルール（promotedRules）で数え、台帳の失敗は注意の1行で知らせる', () => {
    const view = render(<DiffReviewDone result={{ ...RESULT, telopRulesPromoted: 3, promotedRules: [{ category: 'telop', text: '「A」を「B」に直します' }], ledgerError: 'EACCES' }}
      recordedCount={1} onClose={vi.fn()} />);
    expect(view.getByRole('dialog').textContent).toContain('修正 1 件を記録しました（ルール昇格 1 件）。');
    expect(view.getByRole('alert').textContent).toBe(LEDGER_WARNING_TEXT);
  });
});
