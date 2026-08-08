/**
 * DenoiseBanner — ノイズ除去の実行状態を表示するバナー。
 *
 * TranscribeBanner.tsx を手本に実装した。
 * 実行中フェーズ表示・完了時「再読込」ボタン（reload 流用）・エラー表示を行う。
 */

import type { ReactNode } from 'react';
import type { DenoiseState } from '../useDenoise';

/** フェーズ識別子を日本語ラベルへ変換する（テスト用にエクスポート）。 */
export function denoisePhaseLabelJa(phase: string): string {
  switch (phase) {
    case 'preparing': return '準備中';
    case 'denoising': return 'ノイズ除去中';
    case 'finalizing': return '書き出し中';
    default: return phase;
  }
}

interface DenoiseBannerProps {
  state: DenoiseState;
  /** 完了後に「再読込」ボタンを押したときの callback（既存の reload 関数を渡す）。 */
  onReloadRequested: () => void;
  /** キャンセルボタン（実行中に表示）。 */
  onCancel: () => void;
}

export function DenoiseBanner({ state, onReloadRequested, onCancel }: DenoiseBannerProps): ReactNode {
  return (
    <div className={`tx-misalign tx-misalign-${state.status}`} role="status">
      {renderContent(state, onReloadRequested, onCancel)}
    </div>
  );
}

function renderContent(
  state: DenoiseState,
  onReload: () => void,
  onCancel: () => void,
): ReactNode {
  if (state.status === 'running') {
    const phaseJa = denoisePhaseLabelJa(state.phase);
    return (
      <>
        <span>ノイズ除去中… {phaseJa}</span>
        <button className="tx-misalign-btn ghost" onClick={onCancel}>
          キャンセル
        </button>
      </>
    );
  }

  if (state.status === 'done') {
    return (
      <>
        <span>ノイズ除去が完了しました。反映するには再読込してください。</span>
        <button className="tx-misalign-btn" onClick={onReload}>
          再読込
        </button>
      </>
    );
  }

  if (state.status === 'error') {
    return (
      <span className="sme-error">
        ノイズ除去に失敗しました: {state.error.message}
      </span>
    );
  }

  // idle: バナーを非表示（呼び出し元で条件レンダリングすることを前提とするが、
  // 万一 idle で描画された場合は何も表示しない）。
  return null;
}
