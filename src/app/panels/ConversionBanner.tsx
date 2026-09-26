interface ConversionBannerProps {
  /** 変換 API 実行中。 */
  converting: boolean;
  /** 直近の変換エラー（無ければ null）。 */
  error: string | null;
  /**
   * 未保存の編集があるか。変換は成功後にプロジェクトを開き直すため、
   * 未保存のままだと編集が消える（監査 data-safety-8）。install 系と同じく
   * 保存が済むまでボタンを押せなくする。
   */
  dirty: boolean;
  /** 「非破壊モデルへ変換」押下。 */
  onConvert: () => void;
}

/**
 * cutData.ts を持たないプロジェクト向けの案内バナー（spec §12「焼き込み済みカット」）。
 * カットを動画へ焼き込み済みのプロジェクトを非破壊モデルへ変換するよう促す。
 */
export function ConversionBanner({ converting, error, dirty, onConvert }: ConversionBannerProps) {
  return (
    <div className="conv-banner">
      <div className="conv-banner-text">
        <strong>カットモデル未確定</strong>
        <span>
          焼き込み済みカットは「非破壊モデルへ変換」で編集可能になります（焼き込み分は元に戻せません）。
        </span>
        {dirty && <span>変換前に編集を保存してください。</span>}
        {error && <span className="conv-banner-error">{error}</span>}
      </div>
      {/*
        押せない理由でカーソルを変える。処理中は「待てば押せる」（progress）、
        未保存が理由なら「今は押せない」（not-allowed）。同じ progress にすると
        待っていれば変換が始まると誤解させる（サイクル 1 レビューの残件）。
      */}
      <button
        type="button"
        className="conv-banner-btn"
        disabled={converting || dirty}
        data-reason={converting ? 'busy' : dirty ? 'dirty' : undefined}
        onClick={onConvert}
      >
        {converting ? '変換中…' : '非破壊モデルへ変換'}
      </button>
    </div>
  );
}
