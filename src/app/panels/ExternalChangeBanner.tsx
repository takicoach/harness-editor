interface ExternalChangeBannerProps {
  /** 編集中に未保存の変更があるか。 */
  dirty: boolean;
  /** 「再読込」押下。 */
  onReload: () => void;
}

/**
 * 外部（例: ターミナルの Claude Code）でプロジェクトファイルが書き換えられたときの案内バナー。
 * dirty なら再読込で未保存変更が失われる旨を併記する。
 */
export function ExternalChangeBanner({ dirty, onReload }: ExternalChangeBannerProps) {
  return (
    <div className="ext-banner">
      <div className="ext-banner-text">
        <strong>プロジェクトファイルが外部で更新されました</strong>
        {dirty ? (
          <span>
            未保存の変更があります。再読込すると失われます。先に保存するか、上書きするなら
            「再読込」を押してください。
          </span>
        ) : (
          <span>Claude Code 等で書き換えがあった場合、再読込で反映できます。</span>
        )}
      </div>
      <button type="button" className="ext-banner-btn" onClick={onReload}>
        再読込
      </button>
    </div>
  );
}
