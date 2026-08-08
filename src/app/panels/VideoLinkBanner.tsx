interface VideoLinkBannerProps {
  /** リンクの状態。'broken'=接続先が見つからない / 'mismatch'=別の動画に変わっている。 */
  state: 'broken' | 'mismatch';
  /** 記録されている接続先の絶対パス。 */
  target: string;
  /** プレビュー用の軽量動画があり、テロップ等の編集を続けられるか。 */
  canKeepEditing: boolean;
  /** 「接続先を選び直す」押下。 */
  onRelink: () => void;
}

/**
 * 外付けストレージからリンクで取り込んだ動画が見つからない／別物に変わっている時の案内。
 *
 * 720p プレビューが残っていればテロップ・SE の作業は続けられる（書き出しだけできない）ので、
 * 「作業は続けられる／書き出しは接続してから」を明示する。ドライブ名の変更やフォルダ移動では
 * 再接続しても直らないため、接続先を選び直す導線を必ず添える。
 */
export function VideoLinkBanner({ state, target, canKeepEditing, onRelink }: VideoLinkBannerProps) {
  return (
    <div className="ext-banner vl-banner">
      <div className="ext-banner-text">
        <strong>
          {state === 'broken' ? '元動画が見つかりません' : '接続先が別の動画に変わっています'}
        </strong>
        <span>
          接続先: {target}
          {state === 'broken'
            ? '（外付けドライブが外れている可能性があります）'
            : '（サイズか更新日時が作成時と違います）'}
        </span>
        <span>
          {canKeepEditing
            ? 'プレビュー用の軽い動画で編集は続けられますが、書き出しはできません。'
            : 'プレビューも表示できません。ドライブを接続するか、接続先を選び直してください。'}
        </span>
      </div>
      <button type="button" className="ext-banner-btn vl-banner-btn" onClick={onRelink}>
        接続先を選び直す
      </button>
    </div>
  );
}
