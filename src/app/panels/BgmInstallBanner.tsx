/**
 * BgmInstallBanner — BGM クリップがあるのに BGM 機能が未導入のとき、
 * 「このままでは最終書き出しに反映されない」ことを常時知らせる警告バナー。
 *
 * BgmSettingsTab の導入 CTA（BGM クリップ選択時のみ表示）を補い、選択に依存せず
 * 気づけるようにする（残課題 #10 = BGM 未導入フットガンの緩和）。
 * 既存の tx-misalign 系クラスを流用（styles.css 追記なし・NormalizeBanner を手本）。
 */

import type { ReactNode } from 'react';

/** BGM 未導入警告を出すべきか（BGM クリップがあり、かつ未導入）。 */
export function shouldShowBgmInstallWarning(bgmCount: number, installed: boolean): boolean {
  return bgmCount > 0 && !installed;
}

interface BgmInstallBannerProps {
  /** BGM 機能自身が導入中か（「導入中…」表示用）。 */
  installing: boolean;
  /** いずれかの機能が導入中か（導入は排他なのでボタン無効化用）。 */
  busy: boolean;
  dirty: boolean;
  error: string | null;
  onInstall: () => void;
}

export function BgmInstallBanner({ installing, busy, dirty, error, onInstall }: BgmInstallBannerProps): ReactNode {
  return (
    <div className="tx-misalign" role="status">
      <span>この BGM は「BGM 機能を導入」するまで最終書き出し（remotion render）に反映されません。</span>
      <button
        type="button"
        className="tx-misalign-btn bgm-install-banner-btn"
        disabled={busy || dirty}
        onClick={onInstall}
      >
        {installing ? '導入中…' : 'BGM 機能を導入'}
      </button>
      {dirty && <span>導入前に編集を保存してください。</span>}
      {error && <span className="sme-error">{error}</span>}
    </div>
  );
}
