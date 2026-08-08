/**
 * DiffReviewPanel — 書き出し完了後に表示する「AIとの差分レビュー」モーダル。
 *
 * useLearningDiff の state（review / submitting / done）を描画する。
 * - review: カット差分・文字起こし修正をチェックボックス付きで一覧（既定は全選択）。
 *   「選択分を学習する」で approve、「今回は学習しない」で dismiss。
 * - submitting: 送信中のスピナー表示（ボタン無効）。
 * - done: 昇格件数・競合件数のサマリを表示して閉じる。
 * - hidden / loading はこのコンポーネントを描画しない（呼び出し元がガード）。
 */

import { useState, type ReactNode } from 'react';
import { formatClock } from '../../shared/format';
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
export function learningDoneSummary(recorded: number, promoted: number, conflicts: number): string {
  const conflictPart = conflicts > 0 ? `・競合 ${conflicts} 件はスキップ` : '';
  return `修正 ${recorded} 件を記録しました（ルール昇格 ${promoted} 件${conflictPart}）。`;
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

/** 0..n-1 の全 index を持つ Set（既定=全選択）。 */
function allSelected(n: number): Set<number> {
  return new Set(Array.from({ length: n }, (_, i) => i));
}

// ─────────────────────────────────────────────────────────────────────────────
// コンポーネント

interface DiffReviewPanelProps {
  diff: LearningDiffResponse;
  submitting: boolean;
  onApprove(
    cut: LearningCutDiffItem[],
    words: LearningWordDiffItem[],
    telops: LearningTelopDiffItem[],
    ses: LearningSeDiffItem[],
  ): void;
  onDismiss(): void;
}

export function DiffReviewPanel({ diff, submitting, onApprove, onDismiss }: DiffReviewPanelProps): ReactNode {
  const cut = diff.cut ?? [];
  const words = diff.words ?? [];
  const telops = diff.telops ?? [];
  const ses = diff.ses ?? [];
  const [selectedCut, setSelectedCut] = useState<Set<number>>(() => allSelected(cut.length));
  const [selectedWords, setSelectedWords] = useState<Set<number>>(() => allSelected(words.length));
  const [selectedTelops, setSelectedTelops] = useState<Set<number>>(() => allSelected(telops.length));
  const [selectedSes, setSelectedSes] = useState<Set<number>>(() => allSelected(ses.length));

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
    <div className="diff-review-overlay">
      <div className="diff-review-panel" data-testid="diff-review-panel" role="dialog" aria-label="AIとの差分レビュー">
        <div className="diff-review-head">
          <strong>AIとの差分レビュー</strong>
          <span className="diff-review-summary">
            あなたの編集から {total} 件の学習候補が見つかりました
          </span>
        </div>

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

        <div className="diff-review-foot">
          <button className="tx-misalign-btn ghost" onClick={onDismiss} disabled={submitting}>
            今回は学習しない
          </button>
          <button className="tx-misalign-btn" onClick={submit} disabled={submitting}>
            {submitting ? '学習中…' : '選択分を学習する'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** done フェーズのサマリ表示（承認後の結果）。 */
export function DiffReviewDone({
  result,
  recordedCount,
  onClose,
}: {
  result: LearningApproveResponse;
  /** 実際に送って記録された件数（フックが承認時の配列長から持つ）。 */
  recordedCount: number;
  onClose: () => void;
}): ReactNode {
  const conflicts = result.cutConflicts + result.wordConflicts + result.telopConflicts + result.seConflicts;
  const promoted = result.cutRulesPromoted + result.wordsPromoted + result.telopRulesPromoted + result.seRulesPromoted;
  return (
    <div className="diff-review-overlay">
      <div className="diff-review-panel" data-testid="diff-review-panel" role="dialog" aria-label="学習結果">
        <div className="diff-review-head">
          <strong>学習しました</strong>
        </div>
        <p className="diff-review-result">{learningDoneSummary(recordedCount, promoted, conflicts)}</p>
        {/* 1 本目は昇格 0 件が正常。「何も起きなかった」と読ませないための補足。 */}
        <p className="diff-review-scope-note">{learningPromotionNote()}</p>
        <div className="diff-review-foot">
          <button className="tx-misalign-btn" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
