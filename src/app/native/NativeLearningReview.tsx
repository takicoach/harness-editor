import { useEffect, useState } from 'react';
import { DiffReviewDone, DiffReviewPanel } from '../panels/DiffReviewPanel';
import { MODAL_SELECTOR } from '../isModalOpen';
import type { UseLearningDiff } from '../useLearningDiff';

/**
 * 「他のダイアログ」判定用セレクタ。学習パネル自身（.diff-review-overlay…）は含めない
 * （表示した自分を検知して隠れ、隠れた自分を…と永久に待つのを避ける）。
 */
const OTHER_DIALOG_SELECTOR = MODAL_SELECTOR.split(',')
  .map((part) => part.trim())
  .filter((part) => !part.startsWith('.diff-review-overlay'))
  .join(', ');

/** 学習パネル以外の前面ダイアログが開いているか。 */
function otherDialogOpen(): boolean {
  return document.querySelector(OTHER_DIALOG_SELECTOR) !== null;
}

/**
 * 書き出し後の学習パネル（review / submitting）と完了画面（done）を描く。hidden / loading では何も描かない。
 * review と submitting で同じ要素を保つので、承認に失敗して review へ戻ってもチェックの選択は残る。
 * 承認に失敗した理由（state.error）はボタンの上に出し、台帳の失敗（result.ledgerError）は完了画面が注意の1行を出す。
 *
 * 通知パネルや「AIの作業」ダイアログ（.preference-overlay）など他のダイアログが開いている間は、
 * 学習パネル・完了画面を hidden＋inert で隠して待つ（unmount しないのでチェックの選択は残る。
 * フォーカスも移さず、Tab・Esc も握らない）。他のダイアログが閉じたら、その時点で同じジョブの差分
 * （useLearningDiff の状態のまま・取り直さない）のまま表示に戻してフォーカスを移す。
 */
export function NativeLearningReview({ learning }: { learning: UseLearningDiff }) {
  const state = learning.state;
  const showable = state.status === 'review' || state.status === 'submitting' || state.status === 'done';
  // MutationObserver の通知を受けて再描画をトリガーするためだけの値。判定自体は下で毎描画同期的に行う
  // （useState の初期値は初回マウント時にしか評価されないため、review へ切り替わった最初の描画で
  // 古い false のまま子が一瞬マウントし focus() が呼ばれてしまう。setState 経由の補正は子の mount
  // effect より後にしか走らず間に合わない）。
  const [, tick] = useState(0);
  const blocked = showable && otherDialogOpen();

  useEffect(() => {
    if (!showable) return;
    const observer = new MutationObserver(() => tick((n) => n + 1));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [showable]);

  if (!showable) return null;

  if (state.status === 'review' || state.status === 'submitting') {
    return <DiffReviewPanel key={state.jobId} diff={state.diff} submitting={state.status === 'submitting'} hidden={blocked}
      error={state.status === 'review' ? state.error : null} onApprove={learning.approve} onDismiss={learning.dismiss} />;
  }
  return <DiffReviewDone key={state.jobId} result={state.result} recordedCount={state.recordedCount} hidden={blocked} onClose={learning.dismiss} />;
}
