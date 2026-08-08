interface ConversionBannerProps {
  /** 変換 API 実行中。 */
  converting: boolean;
  /** 直近の変換エラー（無ければ null）。 */
  error: string | null;
  /** 「非破壊モデルへ変換」押下。 */
  onConvert: () => void;
}

/**
 * cutData.ts を持たないプロジェクト向けの案内バナー（spec §12「焼き込み済みカット」）。
 * カットを動画へ焼き込み済みのプロジェクトを非破壊モデルへ変換するよう促す。
 */
export function ConversionBanner({ converting, error, onConvert }: ConversionBannerProps) {
  return (
    <div className="conv-banner">
      <div className="conv-banner-text">
        <strong>カットモデル未確定</strong>
        <span>
          焼き込み済みカットは「非破壊モデルへ変換」で編集可能になります（焼き込み分は元に戻せません）。
        </span>
        {error && <span className="conv-banner-error">{error}</span>}
      </div>
      <button
        type="button"
        className="conv-banner-btn"
        disabled={converting}
        onClick={onConvert}
      >
        {converting ? '変換中…' : '非破壊モデルへ変換'}
      </button>
    </div>
  );
}
