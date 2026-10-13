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
const PARTIAL_NOTE = (n: number) => `後から足した素材（${n}本）のカットは比べていません。その部分の字幕・効果音の候補は、最初はチェックを外しています`;

describe('DiffReviewPanel（新画面）', () => {
  it('候補が0件でも学習確認を表示し、記録せず閉じられる', () => {
    const actions = handlers();
    const view = render(<DiffReviewPanel diff={{ cut: null, words: null, telops: null, ses: null, undistilledCount: 0 }} submitting={false} {...actions} />);
    expect(view.getByRole('dialog', { name: 'AIとの差分レビュー' }).textContent).toContain('今回、学習候補はありません');
    expect(view.queryByRole('button', { name: '選択分を学習する' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: '閉じる' }));
    expect(actions.onDismiss).toHaveBeenCalledTimes(1);
    expect(actions.onApprove).not.toHaveBeenCalled();
    // 注記の無い案件（旧形式・足していない移行案件）は従来の文のまま。
    expect(view.getByText(/今回、記録する項目はありません/)).toBeTruthy();
    expect(view.queryByText(/後から足した素材/)).toBeNull();
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
  it('後から足した素材がある時は注記を出し、候補0件でも完了と書かない', () => {
    const view = render(<DiffReviewPanel diff={{ cut: null, words: null, telops: [], ses: [], undistilledCount: 0, partialNote: PARTIAL_NOTE(2) }} submitting={false} {...handlers()} />);
    expect(view.getByRole('note').textContent).toBe(PARTIAL_NOTE(2));
    expect(view.getByText('取り込んだ元の素材の部分には、学習候補はありません')).toBeTruthy();
    expect(view.queryByText(/今回、記録する項目はありません/)).toBeNull();
    expect(view.getByText(/学習は完了していません/)).toBeTruthy();
  });
  it('候補がある時も注記を出し、件数の見出しと承認のボタンはそのまま', () => {
    const view = render(<DiffReviewPanel diff={{ ...DIFF, undistilledCount: 0, partialNote: PARTIAL_NOTE(1) }} submitting={false} {...handlers()} />);
    expect(view.getByRole('note').textContent).toBe(PARTIAL_NOTE(1));
    expect(view.getByRole('dialog').textContent).toContain('あなたの編集から 3 件の学習候補が見つかりました');
    expect(view.getByRole('button', { name: '選択分を学習する' })).toBeTruthy();
  });
  it('後から足した素材の部分にすっぽり入る字幕・効果音は最初はチェックを外して添え書きを出す。元の素材・またぐ字幕・比較元の時刻の候補・カットはチェック済み', () => {
    const calls = handlers();
    const telops: LearningDiffResponse['telops'] = [
      { kind: 'added', startFrame: 270, endFrame: 300, startSec: 9, endSec: 10, before: '', after: '足した素材の字幕' },
      { kind: 'changed', startFrame: 0, endFrame: 60, startSec: 0, endSec: 2, before: 'ゆる素振り', after: 'ゆるい素振り' },
      { kind: 'added', startFrame: 260, endFrame: 290, startSec: 260 / 30, endSec: 290 / 30, before: '', after: 'またぐ字幕' },
      { kind: 'changed', startFrame: 280, endFrame: 310, startSec: 280 / 30, endSec: 310 / 30, before: '後ろへはみ出す', after: '後ろへはみ出す字幕' },
      // removed は比較元（取り込み時点）の時刻。数値が区間に入っても足した素材の部分ではない。
      { kind: 'removed', startFrame: 275, endFrame: 290, startSec: 275 / 30, endSec: 290 / 30, before: '比較元の字幕', after: '' },
    ];
    const ses: LearningDiffResponse['ses'] = [
      { kind: 'added', startFrame: 280, startSec: 280 / 30, file: 'whoosh.mp3', nearbyText: '' },
      { kind: 'added', startFrame: 300, startSec: 10, file: 'pop.mp3', nearbyText: '' },
      { kind: 'removed', startFrame: 285, startSec: 285 / 30, file: 'beep.mp3', nearbyText: '' },
    ];
    const view = render(<DiffReviewPanel diff={{ cut: DIFF.cut, words: null, telops, ses, undistilledCount: 0, partialNote: PARTIAL_NOTE(1),
      partialRanges: [{ startFrame: 270, endFrame: 300 }] }} submitting={false} {...calls} />);
    expect(view.getAllByRole('checkbox').map((box) => (box as HTMLInputElement).checked)).toEqual([true, false, true, true, true, true, false, true, true]);
    const tagged = view.getAllByText('後から足した素材の部分').map((tag) => tag.closest('li')?.textContent ?? '');
    expect(tagged).toHaveLength(2);
    expect(tagged[0]).toContain('足した素材の字幕');
    expect(tagged[1]).toContain('whoosh.mp3');
    fireEvent.click(view.getByRole('button', { name: '選択分を学習する' }));
    expect(calls.onApprove).toHaveBeenCalledWith(DIFF.cut, [], telops!.slice(1), ses!.slice(1));
  });
  it('区間が無い（注記の無い）案件は、同じ時刻の候補も従来どおり全部チェック済みで添え書きも出さない', () => {
    const view = render(<DiffReviewPanel diff={{ cut: null, words: null, undistilledCount: 0,
      telops: [{ kind: 'added', startFrame: 270, endFrame: 300, startSec: 9, endSec: 10, before: '', after: '字幕' }],
      ses: [{ kind: 'added', startFrame: 280, startSec: 280 / 30, file: 'whoosh.mp3', nearbyText: '' }] }} submitting={false} {...handlers()} />);
    expect(view.getAllByRole('checkbox').map((box) => (box as HTMLInputElement).checked)).toEqual([true, true]);
    expect(view.queryByText('後から足した素材の部分')).toBeNull();
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

  it('後から足した素材がある案件は、完了画面にも注記を1行出す（無い案件には出さない）', () => {
    const view = render(<DiffReviewDone result={RESULT} recordedCount={1} partialNote={PARTIAL_NOTE(1)} onClose={vi.fn()} />);
    expect(view.getByRole('note').textContent).toBe(PARTIAL_NOTE(1));
    cleanup();
    const plain = render(<DiffReviewDone result={RESULT} recordedCount={1} onClose={vi.fn()} />);
    expect(plain.queryByRole('note')).toBeNull();
  });
});
