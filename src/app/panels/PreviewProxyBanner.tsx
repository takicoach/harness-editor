/**
 * PreviewProxyBanner — プレビュー軽量化の案内・進捗・完了バナー。
 * NormalizeBanner を手本に既存クラス（tx-misalign / tb-render 系）を流用する（styles.css 追記なし）。
 *
 * 表示条件:
 *  - idle かつ 軽量版なし・推奨あり・未 dismiss → 案内（実行 / 今回はしない）
 *  - running → アニメーション付き進捗バー（%）＋キャンセル
 *  - done → 再読込ボタン（軽量版のプレビューへ切り替え）
 *  - error → 失敗メッセージ＋再試行
 */

import type { ReactNode } from 'react';
import type { PreviewProxyState } from '../usePreviewProxy';

/** 推奨理由の配列から案内文を組み立てる（テスト用にエクスポート）。 */
export function proxyRecommendMessage(reasons: string[]): string {
  const why = reasons.length > 0 ? reasons.join('・') : '容量が大きい';
  return `この動画は${why}のため、編集用に軽くする処理をおすすめします（書き出しの画質には影響しません）。`;
}

/** バナーを描画すべきか（テスト用にエクスポート）。 */
export function shouldShowProxyBanner(state: PreviewProxyState, dismissed: boolean): boolean {
  if (state.status === 'running' || state.status === 'done' || state.status === 'error') return true;
  if (state.status !== 'idle') return false;
  return !state.hasProxy && state.recommended && !dismissed;
}

interface PreviewProxyBannerProps {
  state: PreviewProxyState;
  dismissed: boolean;
  onStart: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  onReloadRequested: () => void;
}

export function PreviewProxyBanner({
  state,
  dismissed,
  onStart,
  onCancel,
  onDismiss,
  onReloadRequested,
}: PreviewProxyBannerProps): ReactNode {
  if (!shouldShowProxyBanner(state, dismissed)) return null;

  if (state.status === 'running') {
    const pct = state.percent;
    return (
      <div className="tx-misalign" role="status" data-testid="proxy-banner-running">
        <div className="tb-render-progress">
          {pct !== null ? (
            <span className="tb-render-bar" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
          ) : (
            <span className="tb-render-spinner" aria-hidden="true" />
          )}
          <span className="tb-render-label">
            プレビュー用の軽量版を作成中…{pct !== null ? ` ${pct}%` : ''}
          </span>
        </div>
        <button className="tx-misalign-btn ghost" onClick={onCancel}>キャンセル</button>
      </div>
    );
  }

  if (state.status === 'done') {
    return (
      <div className="tx-misalign tx-misalign-completed" role="status" data-testid="proxy-banner-done">
        <span>軽量版ができました。プレビューを切り替えるには再読込してください（書き出しは原本のまま）。</span>
        <button className="tx-misalign-btn" onClick={onReloadRequested}>再読込</button>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="tx-misalign tx-misalign-failed" role="status" data-testid="proxy-banner-error">
        <span className="sme-error">軽量版の生成に失敗しました: {state.error.message}</span>
        <button className="tx-misalign-btn" onClick={onStart}>再試行</button>
      </div>
    );
  }

  // idle（推奨あり）
  const reasons = state.status === 'idle' ? state.reasons : [];
  return (
    <div className="tx-misalign" role="status" data-testid="proxy-banner-recommend">
      <span>{proxyRecommendMessage(reasons)}</span>
      <button className="tx-misalign-btn" onClick={onStart}>軽くする</button>
      <button className="tx-misalign-btn ghost" onClick={onDismiss}>今回はしない</button>
    </div>
  );
}
