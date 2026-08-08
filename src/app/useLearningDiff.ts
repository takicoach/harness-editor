/**
 * useLearningDiff — 学習ループ Phase B の差分レビュー用クライアントフック。
 *
 * 状態: hidden / loading / review / submitting / done
 *
 * 設計方針:
 * - open() で GET /api/learning/diff を叩き、差分がレビュー可能なら review へ。
 *   差分ゼロ（cut/words とも null または空配列）なら hidden のまま（ユーザーに見せない）。
 * - fetch 失敗時は console.warn のみで hidden に留める（編集フローを止めない）。
 * - approve() は POST /api/learning/approve → done へ。
 * - dismiss() はその回の差分を破棄して hidden へ戻す。
 */

import { useRef, useState } from 'react';
import { fetchJson, putJsonPost } from './fetchJson';
import type {
  LearningApproveRequest,
  LearningApproveResponse,
  LearningCutDiffItem,
  LearningDiffResponse,
  LearningSeDiffItem,
  LearningTelopDiffItem,
  LearningWordDiffItem,
} from '../shared/types';

/** useLearningDiff が管理するフェーズ状態。 */
export type LearningDiffState =
  | { status: 'hidden' }
  | { status: 'loading' }
  | { status: 'review'; diff: LearningDiffResponse }
  | { status: 'submitting'; diff: LearningDiffResponse }
  | {
      status: 'done';
      result: LearningApproveResponse;
      /** 実際に送って記録された件数（承認した配列長の合計）。done 表示で「記録した」と言い切るため。 */
      recordedCount: number;
    };

export interface UseLearningDiff {
  state: LearningDiffState;
  /** diff を fetch して review へ（差分ゼロなら hidden のまま）。 */
  open(projectId: string): void;
  /** 承認された項目を POST し done へ。 */
  approve(
    projectId: string,
    cut: LearningCutDiffItem[],
    words: LearningWordDiffItem[],
    telops: LearningTelopDiffItem[],
    ses: LearningSeDiffItem[],
  ): void;
  /** その回の差分を破棄して hidden へ。 */
  dismiss(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// 純関数（テスト容易性のためエクスポート）

/** 差分が cut/words/telops/ses すべて null または空配列なら「表示しない」判定。 */
export function hasReviewableDiff(diff: LearningDiffResponse): boolean {
  const hasCut = !!diff.cut && diff.cut.length > 0;
  const hasWords = !!diff.words && diff.words.length > 0;
  const hasTelops = !!diff.telops && diff.telops.length > 0;
  const hasSes = !!diff.ses && diff.ses.length > 0;
  return hasCut || hasWords || hasTelops || hasSes;
}

// ─────────────────────────────────────────────────────────────────────────────
// フック

const INITIAL_STATE: LearningDiffState = { status: 'hidden' };

export function useLearningDiff(): UseLearningDiff {
  const [state, setState] = useState<LearningDiffState>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

  const open = (projectId: string): void => {
    if (!projectId) return;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const diff = await fetchJson<LearningDiffResponse>(
          `/api/learning/diff?id=${encodeURIComponent(projectId)}`,
        );
        if (!hasReviewableDiff(diff)) {
          setState({ status: 'hidden' });
          return;
        }
        setState({ status: 'review', diff });
      } catch (e) {
        console.warn('learning diff fetch failed', e);
        setState({ status: 'hidden' });
      }
    })();
  };

  const approve = (
    projectId: string,
    cut: LearningCutDiffItem[],
    words: LearningWordDiffItem[],
    telops: LearningTelopDiffItem[],
    ses: LearningSeDiffItem[],
  ): void => {
    if (!projectId) return;
    const current = stateRef.current;
    if (current.status !== 'review') return;
    setState({ status: 'submitting', diff: current.diff });
    void (async () => {
      try {
        const body: LearningApproveRequest = { projectId, cut, words, telops, ses };
        const result = await putJsonPost<LearningApproveResponse>('/api/learning/approve', body);
        const recordedCount = cut.length + words.length + telops.length + ses.length;
        setState({ status: 'done', result, recordedCount });
      } catch (e) {
        console.warn('learning diff approve failed', e);
        setState({ status: 'hidden' });
      }
    })();
  };

  const dismiss = (): void => {
    setState({ status: 'hidden' });
  };

  return { state, open, approve, dismiss };
}
