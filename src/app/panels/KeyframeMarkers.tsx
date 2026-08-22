import type { CutOrdering, CutRegion } from '../../core/types';
import type { LayoutKeyframe } from '../../core/layoutKeyframes';
import { originalToPlayback } from '../../core/cutEngine';

interface KeyframeMarkersProps {
  /** 大域キーフレーム列（原本フレームアンカー）。2 点未満なら何も描画しない。 */
  layoutKeyframes: LayoutKeyframe[];
  /** カット後→元フレーム変換に使う（カット区間内の KF はスキップする）。 */
  cutRegions: CutRegion[];
  /** カット並び替えの対応表。未指定なら従来の単調モデル。 */
  ordering?: CutOrdering;
  fps: number;
  /** frame(再生タイムライン座標) → タイムライン x 座標(px)。 */
  frameToX: (playbackFrame: number) => number;
  /** マーカーをクリックしたとき（再生ヘッドをそのフレームへ移動する等）。 */
  onSeek?: (playbackFrame: number) => void;
}

/**
 * メイン動画の大域キーフレーム（カット非依存・原本フレームアンカー）をタイムライン上に
 * diamond マーカーとして表示する。カット区間に飲まれた KF（originalToPlayback が null）は
 * 表示できないためスキップする。2 点未満では何も描画しない（KF は 2 点以上で初めて意味を持つため）。
 */
export function KeyframeMarkers({
  layoutKeyframes,
  cutRegions,
  ordering,
  fps,
  frameToX,
  onSeek,
}: KeyframeMarkersProps) {
  if (layoutKeyframes.length < 2) return null;

  return (
    <div className="kf-markers">
      {layoutKeyframes.map((kf, i) => {
        const playback = originalToPlayback(kf.originalFrame, cutRegions, ordering);
        if (playback === null) return null;
        const seconds = (kf.originalFrame / fps).toFixed(2);
        return (
          <button
            key={i}
            type="button"
            className="kf-marker"
            data-kf-index={i}
            style={{ left: frameToX(playback) }}
            title={`KF${i + 1}: ${seconds}s / scale ${kf.scale.toFixed(2)}`}
            onClick={() => onSeek?.(playback)}
          >
            <span className="kf-marker-diamond" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
