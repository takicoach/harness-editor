/**
 * NormalizeBanner — 音量正規化の実行状態バナー。
 * DenoiseBanner を手本に、既存クラス（tx-misalign 系）を流用する（styles.css 追記なし）。
 */

import type { ReactNode } from 'react';
import type { NormalizeState } from '../useNormalize';

/** フェーズ識別子を日本語ラベルへ変換する（テスト用にエクスポート）。 */
export function normalizePhaseLabelJa(phase: string): string {
  switch (phase) {
    case 'preparing': return '準備中';
    case 'measuring': return '音量を測定中';
    case 'normalizing': return '音量を調整中';
    case 'finalizing': return '書き出し中';
    default: return phase;
  }
}

interface NormalizeBannerProps {
  state: NormalizeState;
  onReloadRequested: () => void;
  onCancel: () => void;
  /** 失敗時の「もう一度」（status-ia-7）。未指定なら再試行ボタンを出さない。 */
  onRetry?: () => void;
  /** 失敗表示を閉じる（status-ia-7）。未指定なら閉じるボタンを出さない。 */
  onDismiss?: () => void;
}

export function NormalizeBanner({ state, onReloadRequested, onCancel, onRetry, onDismiss }: NormalizeBannerProps): ReactNode {
  return (
    <div className={`tx-misalign tx-misalign-${state.status}`} role="status">
      {renderContent(state, onReloadRequested, onCancel, onRetry, onDismiss)}
    </div>
  );
}

function renderContent(
  state: NormalizeState,
  onReload: () => void,
  onCancel: () => void,
  onRetry?: () => void,
  onDismiss?: () => void,
): ReactNode {
  if (state.status === 'running') {
    return (
      <>
        <span>音量を整えています… {normalizePhaseLabelJa(state.phase)}</span>
        <button className="tx-misalign-btn ghost" onClick={onCancel}>キャンセル</button>
      </>
    );
  }
  if (state.status === 'done') {
    return (
      <>
        <span>音量の調整が完了しました。反映するには再読込してください。</span>
        <button className="tx-misalign-btn" onClick={onReload}>再読込</button>
      </>
    );
  }
  if (state.status === 'error') {
    // status-ia-7: 失敗は status が idle へ戻るまで居座る。押し直す・畳む導線を置く。
    return (
      <>
        <span className="sme-error">音量調整に失敗しました: {state.error.message}</span>
        {onRetry !== undefined && (
          <button className="tx-misalign-btn" data-testid="normalize-retry" onClick={onRetry}>
            もう一度
          </button>
        )}
        {onDismiss !== undefined && (
          <button className="tx-misalign-btn ghost" data-testid="normalize-dismiss" onClick={onDismiss}>
            閉じる
          </button>
        )}
      </>
    );
  }
  return null;
}
