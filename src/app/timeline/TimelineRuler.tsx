import type { PointerEvent as ReactPointerEvent } from 'react';
import { frameToXMapped, rulerTicks } from './timelineGeometry';
import type { DisplayMap } from '../../core/timelineDisplayMap';

interface TimelineRulerProps {
  /** 原本総フレーム数。 */
  totalFrames: number;
  /** 1 フレームあたりのピクセル数。 */
  pxPerFrame: number;
  fps: number;
  /** ルーラー上で pointerdown したとき。スクラブ開始（フレーム算出は親が trackOriginX で行う）。 */
  onScrubStart: (e: ReactPointerEvent) => void;
  /** 表示マップ（per-segment 速度有効時）。省略時は恒等（従来通り）。 */
  map?: DisplayMap;
}

/** 時間ルーラー。major 目盛りに時刻ラベル、minor は線のみ。ドラッグでスクラブ。 */
export function TimelineRuler({ totalFrames, pxPerFrame, fps, onScrubStart, map }: TimelineRulerProps) {
  const ticks = rulerTicks(totalFrames, pxPerFrame, fps);
  return (
    <div className="tl-ruler" onPointerDown={(e) => onScrubStart(e)}>
      <div className="tl-ruler-gutter" aria-hidden="true" />
      {ticks.map((tick) => (
        <div
          key={`${tick.frame}-${tick.kind}`}
          className={'tl-tick ' + tick.kind}
          style={{ left: frameToXMapped(tick.frame, pxPerFrame, map) }}
        >
          {tick.kind === 'major' && <span className="tl-tick-label">{tick.label}</span>}
        </div>
      ))}
    </div>
  );
}
