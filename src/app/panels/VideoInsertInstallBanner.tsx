/**
 * VideoInsertInstallBanner — サブ動画クリップがあるのにサブ動画機能が未導入のとき、
 * 「このままでは最終書き出しに反映されない」ことを常時知らせる警告バナー。
 *
 * BgmInstallBanner のミラー（BGM 未導入フットガン #10 と同型の #5/#10 系フットガン緩和）。
 * ＋サブ動画は BgmSettingsTab 相当の導入 CTA がテロップ設定タブ内にしか無く選択依存のため、
 * 選択に依存せず気づけるようにする。既存の tx-misalign 系クラスを流用（styles.css 追記なし）。
 */

import type { ReactNode } from 'react';

/** サブ動画 未導入警告を出すべきか（サブ動画クリップがあり、かつ未導入）。 */
export function shouldShowVideoInsertInstallWarning(count: number, installed: boolean): boolean {
  return count > 0 && !installed;
}

interface VideoInsertInstallBannerProps {
  /** サブ動画機能自身が導入中か（「導入中…」表示用）。 */
  installing: boolean;
  /** いずれかの機能が導入中か（導入は排他なのでボタン無効化用）。 */
  busy: boolean;
  dirty: boolean;
  error: string | null;
  onInstall: () => void;
}

export function VideoInsertInstallBanner({ installing, busy, dirty, error, onInstall }: VideoInsertInstallBannerProps): ReactNode {
  return (
    <div className="tx-misalign" role="status">
      <span>このサブ動画は「サブ動画機能を導入」するまで最終書き出し（remotion render）に反映されません。</span>
      <button
        type="button"
        className="tx-misalign-btn video-insert-install-banner-btn"
        disabled={busy || dirty}
        onClick={onInstall}
      >
        {installing ? '導入中…' : 'サブ動画機能を導入'}
      </button>
      {dirty && <span>導入前に編集を保存してください。</span>}
      {error && <span className="sme-error">{error}</span>}
    </div>
  );
}
