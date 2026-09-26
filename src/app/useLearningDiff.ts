/**
 * useLearningDiff — 書き出し後の差分レビュー（学習ループ）のクライアントフック。OSS 0.3.1 版が土台。
 *
 * 状態: hidden / loading / review / submitting / done
 *
 * 設計方針:
 * - open(projectId, jobId) で GET /api/learning/diff を叩き、候補が0件でも確認画面へ。
 * - 表示中・読み込み中に呼ばれた open は無視する（連続書き出しでは次の書き出しで全差分が再表示されるため）。
 * - 状態は {projectId, jobId} を持ち、閉じた後・別のジョブ・アンマウント後に届いた古い応答は捨てる。
 *   ただし承認応答の台帳の失敗（ledgerError）はサーバー側で起きた事実なので、画面の状態に関係なく通知する。
 * - open / approve / dismiss は描画をまたいで同じ関数（ref と setState だけを使う）。
 * - 読み込みに失敗したら、パネルは出さずに新画面の「通知・エラー履歴」へ理由を1件残す。
 * - approve() は POST /api/learning/approve → done。失敗したら review へ戻して理由を出す（再度押せる）。
 *   選択が0件なら送らずに閉じる（「今回は学習しない」と同じ）。
 * - dismiss() はその回の差分を破棄して hidden へ戻す。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, putJsonPost } from './fetchJson';
import { reportEditorError } from './native/notificationHistory';
import type {
  LearningApproveRequest,
  LearningApproveResponse,
  LearningCutDiffItem,
  LearningDiffResponse,
  LearningSeDiffItem,
  LearningTelopDiffItem,
  LearningWordDiffItem,
} from '../shared/types';

/** 通知・エラー履歴に出す発生元の名前。 */
export const LEARNING_NOTIFICATION_SOURCE = '学習';

/** useLearningDiff が管理するフェーズ状態。 */
export type LearningDiffState =
  | { status: 'hidden' }
  | { status: 'loading'; projectId: string; jobId: string }
  | { status: 'review'; projectId: string; jobId: string; diff: LearningDiffResponse; error: string | null }
  | { status: 'submitting'; projectId: string; jobId: string; diff: LearningDiffResponse }
  | {
      status: 'done';
      projectId: string;
      jobId: string;
      result: LearningApproveResponse;
      /** 新しく記録した件数（応答の recorded の合計。応答に無ければ送った件数）。 */
      recordedCount: number;
    };

export interface UseLearningDiff {
  state: LearningDiffState;
  /** 完了した書き出しジョブの差分を fetch して、候補0件でも review へ。 */
  open(projectId: string, jobId: string): void;
  /** 承認された項目を POST し done へ。 */
  approve(
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

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ─────────────────────────────────────────────────────────────────────────────
// フック

const INITIAL_STATE: LearningDiffState = { status: 'hidden' };

export function useLearningDiff(): UseLearningDiff {
  const [state, setState] = useState<LearningDiffState>(INITIAL_STATE);
  /** 描画を待たずに最新の状態を読むため（同じ瞬間の承認の二重押しを弾く）。更新は update() だけで行う。 */
  const stateRef = useRef(state);
  /** 表示中（loading〜done）の回。null なら hidden。open の二重呼び出しと古い応答の判定に使う。 */
  const active = useRef<{ token: number; projectId: string; jobId: string } | null>(null);
  const tokens = useRef(0);
  /** マウント中か。後始末で false、再セットアップ（StrictMode 等）で true に戻す。 */
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** その回の応答をまだ画面へ反映してよいか（閉じた後・別の回・アンマウント後は false）。 */
  const live = useCallback((token: number): boolean => mounted.current && active.current?.token === token, []);
  const update = useCallback((next: LearningDiffState): void => {
    stateRef.current = next;
    setState(next);
  }, []);
  const hide = useCallback((): void => {
    active.current = null;
    update({ status: 'hidden' });
  }, [update]);

  const open = useCallback((projectId: string, jobId: string): void => {
    if (!projectId || !jobId || active.current !== null) return;
    const token = ++tokens.current;
    active.current = { token, projectId, jobId };
    update({ status: 'loading', projectId, jobId });
    void (async () => {
      try {
        const diff = await fetchJson<LearningDiffResponse>(
          `/api/learning/diff?id=${encodeURIComponent(projectId)}&job=${encodeURIComponent(jobId)}`,
        );
        if (!live(token)) return;
        update({ status: 'review', projectId, jobId, diff, error: null });
      } catch (e) {
        if (!live(token)) return;
        reportEditorError(projectId, LEARNING_NOTIFICATION_SOURCE, `書き出し後の学習候補を読み込めませんでした: ${message(e)}`);
        hide();
      }
    })();
  }, [live, update, hide]);

  const approve = useCallback((
    cut: LearningCutDiffItem[],
    words: LearningWordDiffItem[],
    telops: LearningTelopDiffItem[],
    ses: LearningSeDiffItem[],
  ): void => {
    const review = stateRef.current;
    const session = active.current;
    if (review.status !== 'review' || session === null) return;
    const sent = cut.length + words.length + telops.length + ses.length;
    if (sent === 0) {
      hide();
      return;
    }
    const { projectId, jobId, diff } = review;
    update({ status: 'submitting', projectId, jobId, diff });
    void (async () => {
      try {
        const body: LearningApproveRequest = { projectId, cut, words, telops, ses, ...(diff.candidateKey ?? {}) };
        const result = await putJsonPost<LearningApproveResponse>('/api/learning/approve', body);
        // 台帳の失敗はサーバー側で起きた事実なので、閉じた後・アンマウント後でも通知に残す（受け手は projectId で絞る）。
        if (result.ledgerError !== undefined) {
          reportEditorError(
            projectId,
            LEARNING_NOTIFICATION_SOURCE,
            `学習は記録しましたが、スキル側の取り出し済み台帳を更新できませんでした: ${result.ledgerError}`,
          );
        }
        if (!live(session.token)) return;
        const recorded = result.recorded;
        const recordedCount = recorded ? recorded.cut + recorded.words + recorded.telops + recorded.ses : sent;
        update({ status: 'done', projectId, jobId, result, recordedCount });
      } catch (e) {
        if (!live(session.token)) return;
        update({ status: 'review', projectId, jobId, diff, error: `学習を記録できませんでした: ${message(e)}` });
      }
    })();
  }, [live, update, hide]);

  const dismiss = useCallback((): void => {
    hide();
  }, [hide]);

  return { state, open, approve, dismiss };
}
