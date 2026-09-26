import { frameToXMapped } from './timelineGeometry';
import { formatClock } from '../../shared/format';
import type { DisplayMap } from '../../core/timelineDisplayMap';

interface DragTooltipProps {
  /** 現在のドラッグ位置の原本フレーム。 */
  frame: number;
  /** ドラッグ開始時の原本フレーム（移動量算出の基準）。 */
  originFrame: number;
  pxPerFrame: number;
  fps: number;
  /** 表示マップ（per-segment 速度有効時）。省略時は恒等（従来通り）。 */
  map?: DisplayMap;
  /**
   * 掴んでいるトラックの上端（`.tl-scroll` 基準の offsetTop・px）。監査 interaction-9。
   *
   * 以前は `left` しか指定しておらず、DragTooltip 群が全トラックの後ろに置かれている
   * ため、どのトラックを掴んでもツールチップは最下段に出ていた（コメントの
   * 「つまみ位置の上へ出す」と実際が食い違っていた）。省略時は従来どおり最下段。
   */
  top?: number;
}

/**
 * ドラッグ中につまみ位置の上へ出すツールチップ。
 * 絶対時刻と、開始位置からの移動量（フレーム数＋秒数）を表示する。
 */
export function DragTooltip({ frame, originFrame, pxPerFrame, fps, map, top }: DragTooltipProps) {
  const deltaFrames = frame - originFrame;
  const sign = deltaFrames > 0 ? '+' : deltaFrames < 0 ? '−' : '';
  const absFrames = Math.abs(deltaFrames);
  const absSeconds = fps > 0 ? absFrames / fps : 0;
  const clock = formatClock(fps > 0 ? frame / fps : 0);
  return (
    <div
      className="tl-tooltip"
      style={{ left: frameToXMapped(frame, pxPerFrame, map), ...(top === undefined ? {} : { top }) }}
    >
      <span>{clock}</span>
      <span className="delta">
        {sign}
        {absFrames}f（{sign}
        {absSeconds.toFixed(2)}秒）
      </span>
    </div>
  );
}
