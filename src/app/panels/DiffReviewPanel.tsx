/**
 * DiffReviewPanel — 書き出し完了後に表示する「AIとの差分レビュー」モーダル（OSS 0.3.1 版が土台）。
 *
 * useLearningDiff の state（review / submitting / done）を描画する。
 * - review: カット差分・テロップ修正・効果音調整をチェックボックス付きで一覧（既定は全選択。
 *   取り込み後に AI の編集がある案件は既定で全部オフ）。「選択分を学習する」で approve、「今回は学習しない」で dismiss。
 * - submitting: 送信中（ボタン無効・「学習中…」）。
 * - done: 記録件数・昇格件数・競合件数のサマリを表示して閉じる。
 * - hidden / loading はこのコンポーネントを描画しない（呼び出し元がガード）。
 * 新画面の他のダイアログに合わせて aria-modal・開いた時のフォーカス移動・Tab の閉じ込め・
 * Esc（review では「今回は学習しない」、done では「閉じる」）を足している。見た目と文言は OSS のまま。
 * 新画面では他のダイアログの後ろで待つ間、`hidden` で要素を残したまま隠す（チェックの選択を保つ。useWaitingDialog）。
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { formatClock } from '../../shared/format';
import { useDialogEscape } from '../useDialogEscape';
import { useFocusTrap } from '../useFocusTrap';
import type {
  LearningApproveResponse,
  LearningCutDiffItem,
  LearningDiffResponse,
  LearningSeDiffItem,
  LearningTelopDiffItem,
  LearningWordDiffItem,
} from '../../shared/types';

// ─────────────────────────────────────────────────────────────────────────────
// 純関数（テスト容易性のためエクスポート）

/** 選択中 index のカット/文字/テロップ/SE項目のみを集めて承認ペイロードを組む。null 項目は空。 */
export function buildApprovePayload(
  cut: LearningCutDiffItem[] | null,
  words: LearningWordDiffItem[] | null,
  telops: LearningTelopDiffItem[] | null,
  ses: LearningSeDiffItem[] | null,
  selectedCut: Set<number>,
  selectedWords: Set<number>,
  selectedTelops: Set<number>,
  selectedSes: Set<number>,
): {
  cut: LearningCutDiffItem[];
  words: LearningWordDiffItem[];
  telops: LearningTelopDiffItem[];
  ses: LearningSeDiffItem[];
} {
  return {
    cut: (cut ?? []).filter((_, i) => selectedCut.has(i)),
    words: (words ?? []).filter((_, i) => selectedWords.has(i)),
    telops: (telops ?? []).filter((_, i) => selectedTelops.has(i)),
    ses: (ses ?? []).filter((_, i) => selectedSes.has(i)),
  };
}

/** カット差分の kind を日本語バッジへ。added-cut=人間が切った / restored-cut=AIのカットを戻した。 */
export function cutBadgeLabel(kind: LearningCutDiffItem['kind']): string {
  return kind === 'added-cut' ? '追加カット' : '復元';
}

/** テロップ差分の kind を日本語バッジへ。changed=文言修正 / added=手動追加 / removed=削除。 */
export function telopBadgeLabel(kind: LearningTelopDiffItem['kind']): string {
  if (kind === 'changed') return '修正';
  return kind === 'added' ? '追加' : '削除';
}

/** SE 差分の kind を日本語バッジへ。added=人間が足した / removed=AI配置を人間が外した。 */
export function seBadgeLabel(kind: LearningSeDiffItem['kind']): string {
  return kind === 'added' ? '追加' : '削除';
}

/** 蒸留提案バッジを出すか（未蒸留が 20 件を超えたら促す）。 */
export function showDistillHint(undistilledCount: number): boolean {
  return undistilledCount > 20;
}

/**
 * 蒸留の案内文（純関数）。
 * 学習データをスキル本文へ反映する実体は動画編集ハーネスの蒸留スキル `/video-harness:learn`。
 */
export function distillHintText(undistilledCount: number): string {
  return `学習データが ${undistilledCount} 件たまっています。Claude で /video-harness:learn スキルを実行するとスキル本文へ反映できます`;
}

/**
 * 承認後のサマリ文（純関数）。
 *
 * 旧文は「ルールを N 件昇格しました」だけで、昇格 0 件のとき（＝1 本目の動画では正常）
 * 「記録もされなかった」ように読めた。記録件数を先に言い切る。
 */
export function learningDoneSummary(recorded: number, promoted: number, conflicts: number, alreadyRecorded = 0): string {
  const conflictPart = conflicts > 0 ? `・競合 ${conflicts} 件はスキップ` : '';
  // 設計書 D9（コントローラ判断事項 #20）: 記録済み・重複でストアが弾いた分は数えず、その旨を同じ文に足す。
  const duplicatePart = alreadyRecorded > 0 ? `（うち ${alreadyRecorded} 件は記録済みまたは重複のため数えていません）` : '';
  return `修正 ${recorded} 件を記録しました（ルール昇格 ${promoted} 件${conflictPart}）${duplicatePart}。`;
}

/**
 * 昇格条件の説明（純関数）。
 * 昇格閾値は distinct videoId で 2（learning/telopRules.ts の
 * TELOP_RULE_PROMOTION_THRESHOLD）。1 本目で昇格 0 件なのは異常ではない。
 */
export function learningPromotionNote(): string {
  return '同じ修正が別の動画でもう 1 回観測されると、AI が使うルールへ昇格します。';
}

/**
 * テロップ学習の対象範囲（core/telopLearning.ts の仕様: テキストのみ）。
 * 「位置を直したのに学習されない」の取り違えを防ぐ。
 */
export const TELOP_LEARNING_SCOPE_NOTE =
  '学習対象はテロップのテキスト変更のみです（タイミング・スタイル・配置は対象外）。';

/** 比較元の1行（新形式の案件だけ。比較元が「AI の案そのもの」とは限らないため明示する）。 */
export function baselineNoteText(label: string): string {
  return `比較元: ${label}`;
}

/** 取り込み後に AI の編集が入った案件の警告（この場合チェックは既定で全部オフ）。 */
export function aiEditWarningText(count: number): string {
  return `取り込み後に AI の編集が ${count} 回入っています。人が直した項目だけにチェックを入れてください。`;
}

/** 台帳（スキル側の取り出し済み記録）を更新できなかった時の完了画面の注意。学習の記録自体は成功している。 */
export const LEDGER_WARNING_TEXT =
  'スキル側の取り出し済み台帳を更新できませんでした。この案件で /video-harness:learn の取り出しを実行すると、同じ修正が二重に記録されることがあります。';

/** 0..n-1 の全 index を持つ Set（既定=全選択）。 */
function allSelected(n: number): Set<number> {
  return new Set(Array.from({ length: n }, (_, i) => i));
}

// ─────────────────────────────────────────────────────────────────────────────
// コンポーネント

/**
 * 表示中だけダイアログとして振る舞う（開いた時のフォーカス移動・Tab の閉じ込め・Esc）。
 *
 * 他のダイアログの後ろで待つ間（hidden）は、unmount せずに hidden＋inert で隠す。チェックの選択は残り、
 * 読み上げ・操作の対象からは外れる。待機中はフォーカスを移さず、Tab と Esc も握らない
 * （他のダイアログの操作を横取りしない）。表示に戻った時にフォーカスを移す。
 */
function useWaitingDialog(overlay: RefObject<HTMLDivElement | null>, root: RefObject<HTMLDivElement | null>,
  hidden: boolean, onEscape: () => void, escapeEnabled = true): void {
  // inert は React 18 の既知の属性ではないので DOM へ直接付ける（PreviewOverlay と同じ作法）。focus より先に外す。
  useLayoutEffect(() => {
    overlay.current?.toggleAttribute('inert', hidden);
  }, [overlay, hidden]);
  useEffect(() => {
    if (!hidden) root.current?.focus();
  }, [root, hidden]);
  useFocusTrap(root, !hidden);
  useDialogEscape(onEscape, escapeEnabled && !hidden);
}

interface DiffReviewPanelProps {
  diff: LearningDiffResponse;
  submitting: boolean;
  /** 承認に失敗した理由。ボタンの上に出し、パネルは閉じない（再度押せる）。 */
  error?: string | null;
  /** 他のダイアログの後ろで待つ間 true（選択を保ったまま隠す。useWaitingDialog）。 */
  hidden?: boolean;
  onApprove(
    cut: LearningCutDiffItem[],
    words: LearningWordDiffItem[],
    telops: LearningTelopDiffItem[],
    ses: LearningSeDiffItem[],
  ): void;
  onDismiss(): void;
}

export function DiffReviewPanel({ diff, submitting, error = null, hidden = false, onApprove, onDismiss }: DiffReviewPanelProps): ReactNode {
  const cut = diff.cut ?? [];
  const words = diff.words ?? [];
  const telops = diff.telops ?? [];
  const ses = diff.ses ?? [];
  const aiEditCount = diff.aiEditCount ?? 0;
  // AI の編集が入った案件は、AI の変更を人の好みとして自動昇格させないよう既定で全部オフ（設計書 D7）。
  const initial = (n: number): Set<number> => (aiEditCount > 0 ? new Set() : allSelected(n));
  const [selectedCut, setSelectedCut] = useState<Set<number>>(() => initial(cut.length));
  const [selectedWords, setSelectedWords] = useState<Set<number>>(() => initial(words.length));
  const [selectedTelops, setSelectedTelops] = useState<Set<number>>(() => initial(telops.length));
  const [selectedSes, setSelectedSes] = useState<Set<number>>(() => initial(ses.length));
  const overlay = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useWaitingDialog(overlay, root, hidden, onDismiss, !submitting);

  function toggle(set: Set<number>, i: number, setter: (s: Set<number>) => void): void {
    const next = new Set(set);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setter(next);
  }

  function submit(): void {
    const payload = buildApprovePayload(
      diff.cut,
      diff.words,
      diff.telops,
      diff.ses,
      selectedCut,
      selectedWords,
      selectedTelops,
      selectedSes,
    );
    onApprove(payload.cut, payload.words, payload.telops, payload.ses);
  }

  const total = cut.length + words.length + telops.length + ses.length;

  return (
    <div ref={overlay} className="diff-review-overlay" hidden={hidden}>
      <div
        ref={root}
        tabIndex={-1}
        className="diff-review-panel"
        data-testid="diff-review-panel"
        role="dialog"
        aria-modal="true"
        aria-label="AIとの差分レビュー"
      >
        <div className="diff-review-head">
          <strong>AIとの差分レビュー</strong>
          <span className="diff-review-summary">
            {diff.unavailableReason?'学習候補を比較できませんでした':total===0?'今回、学習候補はありません':`あなたの編集から ${total} 件の学習候補が見つかりました`}
          </span>
        </div>
        {total===0&&<p className="diff-review-scope-note">書き出し後の学習チェックを実行しました。{diff.unavailableReason??'今回、記録する項目はありません。'}</p>}
        {diff.baselineLabel !== undefined && <p className="diff-review-baseline">{baselineNoteText(diff.baselineLabel)}</p>}
        {aiEditCount > 0 && (
          <p className="diff-review-ai-warning" role="note">
            {aiEditWarningText(aiEditCount)}
          </p>
        )}

        {diff.cut !== null && cut.length > 0 && (
          <section className="diff-review-section">
            <h4>カット差分（{cut.length}）</h4>
            <ul className="diff-review-list">
              {cut.map((item, i) => (
                <li key={i} className="diff-review-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedCut.has(i)}
                      onChange={() => toggle(selectedCut, i, setSelectedCut)}
                    />
                    <span className={`diff-badge diff-badge-${item.kind}`}>{cutBadgeLabel(item.kind)}</span>
                    <span className="diff-review-time">
                      {formatClock(item.startSec)}–{formatClock(item.endSec)}
                    </span>
                    <span className="diff-review-text">{item.text}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}

        {diff.words !== null && words.length > 0 && (
          <section className="diff-review-section">
            <h4>文字起こし修正（{words.length}）</h4>
            <ul className="diff-review-list">
              {words.map((item, i) => (
                <li key={i} className="diff-review-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedWords.has(i)}
                      onChange={() => toggle(selectedWords, i, setSelectedWords)}
                    />
                    <span className="diff-review-word">
                      <span className="diff-word-before">{item.before}</span>
                      <span className="diff-word-arrow"> → </span>
                      <span className="diff-word-after">{item.after}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}

        {diff.telops !== null && telops.length > 0 && (
          <section className="diff-review-section">
            <h4>テロップ修正（{telops.length}）</h4>
            <p className="diff-review-scope-note">{TELOP_LEARNING_SCOPE_NOTE}</p>
            <ul className="diff-review-list">
              {telops.map((item, i) => (
                <li key={i} className="diff-review-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedTelops.has(i)}
                      onChange={() => toggle(selectedTelops, i, setSelectedTelops)}
                    />
                    <span className={`diff-badge diff-badge-${item.kind}`}>{telopBadgeLabel(item.kind)}</span>
                    <span className="diff-review-time">
                      {formatClock(item.startSec)}–{formatClock(item.endSec)}
                    </span>
                    {item.kind === 'changed' ? (
                      <span className="diff-review-word">
                        <span className="diff-word-before">{item.before}</span>
                        <span className="diff-word-arrow"> → </span>
                        <span className="diff-word-after">{item.after}</span>
                      </span>
                    ) : (
                      <span className="diff-review-text">{item.kind === 'added' ? item.after : item.before}</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}

        {diff.ses !== null && ses.length > 0 && (
          <section className="diff-review-section">
            <h4>効果音調整（{ses.length}）</h4>
            <ul className="diff-review-list">
              {ses.map((item, i) => (
                <li key={i} className="diff-review-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedSes.has(i)}
                      onChange={() => toggle(selectedSes, i, setSelectedSes)}
                    />
                    <span className={`diff-badge diff-badge-${item.kind}`}>{seBadgeLabel(item.kind)}</span>
                    <span className="diff-review-time">{formatClock(item.startSec)}</span>
                    <span className="diff-review-text">
                      {item.file}
                      {item.nearbyText !== '' ? `（${item.nearbyText}）` : ''}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}

        {showDistillHint(diff.undistilledCount) && (
          <div className="diff-review-distill" role="note">
            {distillHintText(diff.undistilledCount)}
          </div>
        )}

        {error !== null && (
          <p className="diff-review-error" role="alert">
            {error}
          </p>
        )}

        <div className="diff-review-foot">
          <button className="tx-misalign-btn ghost" onClick={onDismiss} disabled={submitting}>
            {total===0?'閉じる':'今回は学習しない'}
          </button>
          {total>0&&<button className="tx-misalign-btn" onClick={submit} disabled={submitting}>
            {submitting ? '学習中…' : '選択分を学習する'}
          </button>}
        </div>
      </div>
    </div>
  );
}

/** done フェーズのサマリ表示（承認後の結果）。 */
export function DiffReviewDone({
  result,
  recordedCount,
  hidden = false,
  onClose,
}: {
  result: LearningApproveResponse;
  /** 新しく記録した件数（サーバー応答の recorded の合計。応答に無ければ送った件数）。 */
  recordedCount: number;
  /** 他のダイアログの後ろで待つ間 true（useWaitingDialog）。 */
  hidden?: boolean;
  onClose: () => void;
}): ReactNode {
  const conflicts = result.cutConflicts + result.wordConflicts + result.telopConflicts + result.seConflicts;
  // 設計書 D9: 昇格数は「今回新しく増えたルール」（promotedRules）で数える。旧応答だけ件数の差へ戻す。
  const promoted =
    result.promotedRules?.length ??
    result.cutRulesPromoted + result.wordsPromoted + result.telopRulesPromoted + result.seRulesPromoted;
  const overlay = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useWaitingDialog(overlay, root, hidden, onClose);
  return (
    <div ref={overlay} className="diff-review-overlay" hidden={hidden}>
      <div
        ref={root}
        tabIndex={-1}
        className="diff-review-panel"
        data-testid="diff-review-panel"
        role="dialog"
        aria-modal="true"
        aria-label="学習結果"
      >
        <div className="diff-review-head">
          <strong>学習しました</strong>
        </div>
        <p className="diff-review-result">{learningDoneSummary(recordedCount, promoted, conflicts, result.alreadyRecorded ?? 0)}</p>
        {/* 1 本目は昇格 0 件が正常。「何も起きなかった」と読ませないための補足。 */}
        <p className="diff-review-scope-note">{learningPromotionNote()}</p>
        {result.ledgerError !== undefined && (
          <p className="diff-review-error" role="alert">
            {LEDGER_WARNING_TEXT}
          </p>
        )}
        <div className="diff-review-foot">
          <button className="tx-misalign-btn" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
