interface ExternalChangeBannerProps {
  /** 編集中に未保存の変更があるか。 */
  dirty: boolean;
  /** 「再読込」押下（未保存が無いときの唯一のボタン）。 */
  onReload: () => void;
  /**
   * 見出し文言。外部書き換え以外（導入・部品更新など自分の操作の着地）で使い回す場合に上書きする。
   * 省略時は従来どおり「外部で更新されました」文言。
   */
  title?: string;
  /** 「保存してから再読込」押下（未保存があるときの主ボタン）。 */
  onSaveThenReload: () => void;
  /** 「保存せずに再読込」押下（未保存があるときの二次ボタン。押すと確認が出る）。 */
  onDiscardReload: () => void;
  /**
   * 直近の保存が衝突（409）で失敗しているか。true のあいだはこのバナーが
   * 復帰 UI を兼ねる（別窓のポップオーバーは出さない）。
   */
  conflict?: boolean;
  /** 衝突時「この画面の内容で上書き保存」押下。 */
  onOverwriteSave?: () => void;
}

/**
 * プロジェクトファイルが（外部書き換え、または自分の操作の非同期着地で）変わったときの案内バナー。
 *
 * 未保存の変更があるときは「保存してから再読込」を主ボタンにする（監査 data-safety-3）。
 * 以前は文言で「先に保存するか…」と警告しながら、置いてあるボタンは即時破棄の
 * 「再読込」1 つだけで、1 クリックで手作業が消えていた。
 */
export function ExternalChangeBanner({
  dirty,
  onReload,
  onSaveThenReload,
  onDiscardReload,
  conflict = false,
  onOverwriteSave,
  title = 'プロジェクトファイルが外部で更新されました',
}: ExternalChangeBannerProps) {
  // 衝突（409）中は復帰 UI をこのバナー 1 つへ統合する。
  // 以前は右上の衝突ポップオーバーがバナーの操作領域を丸ごと覆い、本文だけが
  // 見えないボタン（「保存してから再読込」）を押せと案内し続けていた（レビュー指摘）。
  if (dirty && conflict) {
    return (
      <div className="ext-banner ext-banner-conflict">
        <div className="ext-banner-text">
          <strong>保存できませんでした（外部の内容が新しくなっています）</strong>
          <span>
            {'この画面の編集と、外部で書き換えられた内容が食い違っています。どちらを残すか選んでください。上書きしても、消える方の内容は案件フォルダ内に控えを取ります。'}
          </span>
        </div>
        <div className="ext-banner-actions">
          <button type="button" className="ext-banner-btn" onClick={onOverwriteSave}>
            この画面の内容で上書き保存
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onDiscardReload}>
            外部の内容で開き直す（この画面の編集は失われます）
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="ext-banner">
      <div className="ext-banner-text">
        <strong>{title}</strong>
        {dirty ? (
          <span>
            {'自分の編集がまだ保存されていません。「保存してから再読込」を押すと、いまの編集を保存したうえで新しい内容を取り込みます。'}
          </span>
        ) : (
          <span>Claude Code 等で書き換えがあった場合、再読込で反映できます。</span>
        )}
      </div>
      {dirty ? (
        <div className="ext-banner-actions">
          <button type="button" className="ext-banner-btn" onClick={onSaveThenReload}>
            保存してから再読込
          </button>
          {/* 二次ボタンは ghost（面も枠も無い）にしない。--accent-soft の地に --fg-2 の
              文字だけだと隣の説明文と見分けがつかず、破棄という取り返しのつかない操作の
              入口が「押せるものに見えない」（rubric 軸1）。枠と面を常に持つ secondary にする。 */}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onDiscardReload}>
            保存せずに再読込
          </button>
        </div>
      ) : (
        <button type="button" className="ext-banner-btn" onClick={onReload}>
          再読込
        </button>
      )}
    </div>
  );
}
