// src/shared/captureEngineMessages.ts
/**
 * 撮影エンジン不在の理由（FastCutIneligibleReason）ごとの文言を1か所に集約する
 * （M2d T2 修正ラウンド2・M-3）。
 *
 * これまで `useRenderJob.fastCutFallbackMessageFor`（帯用）と
 * `ExportDialog.engineRecoveryGuidance`（ダイアログ用）が別々に switch を持ち、
 * 同じ理由に対する文言を2か所で個別に書いていた。ここへ集約し、両 consumer は
 * この Record を引くだけにする。
 *
 * `satisfies Record<FastCutIneligibleReason, …>` により、全理由を網羅していることを
 * 型で保証する——理由が増えたときにここへの追記漏れがあれば tsc が検出する
 * （M-2 で個別 switch に持たせる予定だった `default: { const _x: never = … }` の
 *  網羅チェックは、この Record 定義の satisfies が肩代わりする）。
 */
import type { FastCutIneligibleReason } from './captureOverlays';

export interface CaptureEngineMessagePair {
  /** ExportDialog の復旧案内文言。 */
  dialog: string;
  /** Toolbar の退避通知帯文言。 */
  band: string;
}

export const CAPTURE_ENGINE_MESSAGES = {
  'chromium-missing': {
    dialog: 'setup.command / setup.bat をもう一度実行すると高速書き出しが使えるようになります。',
    band: '撮影エンジンが未導入のため通常の書き出しになりました。setup.command / setup.bat をもう一度実行すると高速書き出しが使えます',
  },
  'env-path-missing': {
    dialog: '環境変数 HARNESS_CHROMIUM に指定されたパスが見つかりません。設定を確認するか、指定を外してください。',
    band: '環境変数 HARNESS_CHROMIUM のパスが見つからないため通常の書き出しになりました',
  },
  'unsupported-platform': {
    dialog: 'この OS では撮影エンジンを自動導入できないため、常に通常の書き出しになります。',
    band: 'この OS では高速書き出しの撮影に対応していないため通常の書き出しになりました',
  },
} satisfies Record<FastCutIneligibleReason, CaptureEngineMessagePair>;
