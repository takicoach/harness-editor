import { useMemo } from 'react';
import { frameToXMapped, widthMapped } from './timelineGeometry';
import { assignLanes } from './lanePacking';
import type { EditorShape, ShapeKind } from '../../core/types';
import type { DisplayMap } from '../../core/timelineDisplayMap';
import { TrackHeader } from './TrackHeader';

/** つまみ識別子。図形トラックでは 1 つの図形ブロックの端／本体を表す。 */
export interface ShapeHandleId {
  kind: 'shape';
  shapeId: number;
  edge: 'start' | 'end' | 'body';
}

/** ドラッグ中にライブ表示で差し替える図形位置。 */
export interface ShapeOverride {
  shapeId: number;
  originalStart: number;
  originalEnd: number;
}

/** ShapeKind → 日本語ラベル。 */
function kindLabel(kind: ShapeKind): string {
  switch (kind) {
    case 'arrow':   return '矢印';
    case 'line':    return '直線';
    case 'rect':    return '四角';
    case 'ellipse': return '丸';
  }
}

interface ShapeTrackProps {
  pxPerFrame: number;
  shapes: EditorShape[];
  /** カット区間内に完全に飲まれた図形の ID 集合（警告表示用）。 */
  flaggedShapeIds: Set<number>;
  /** 選択中の図形 ID（インスペクタ選択と同期）。 */
  selectedShapeId: number | null;
  /** ドラッグ中の図形位置を上書き表示する。null ならコミット済み state を使う。 */
  liveOverride: ShapeOverride | null;
  /** ブロック上で pointerdown したとき（選択 + ドラッグ開始）。 */
  onHandleDown: (handle: ShapeHandleId, e: React.PointerEvent) => void;
  /** 表示マップ（区間速度の伸縮・省略時は恒等）。 */
  map?: DisplayMap;
}

/**
 * 図形トラック。図形オーバーレイは区間イベントなので画像と同じくブロックで描く。
 * 座標系は原本フレーム（CutTrack / TelopTrack / ImageTrack と同じ）。
 * 時間が重なる図形は assignLanes で別レーン（行）へ自動振り分けして縦に積む。
 * レーンは committed shapes から計算し、ドラッグ中の liveOverride は X のみ反映する
 * （行レイアウトを固定して行飛びを防ぐ。確定後の再レンダーで再計算される）。
 */
export function ShapeTrack({
  pxPerFrame,
  shapes,
  flaggedShapeIds,
  selectedShapeId,
  liveOverride,
  onHandleDown,
  map,
}: ShapeTrackProps) {
  // shapes 配列の参照が変わるたびに再計算（EditState は編集ごとに新配列を生成する）
  const { lanes, laneCount } = useMemo(
    () => assignLanes(shapes.map((s) => ({ start: s.originalStart, end: s.originalEnd }))),
    [shapes],
  );
  const trackStyle = { ['--lane-count']: Math.max(1, laneCount) } as React.CSSProperties;

  return (
    <div className="tl-track tl-track-shape" style={trackStyle}>
      <TrackHeader kind="shape" label="図形" />
      {shapes.map((shape, i) => {
        const start =
          liveOverride?.shapeId === shape.id ? liveOverride.originalStart : shape.originalStart;
        const end =
          liveOverride?.shapeId === shape.id ? liveOverride.originalEnd : shape.originalEnd;
        const left = frameToXMapped(start, pxPerFrame, map);
        const width = Math.max(2, widthMapped(start, end, pxPerFrame, map));
        const lane = lanes[i] ?? 0;
        const top = `calc(${lane} * var(--lane-row-h) + var(--lane-inset))`;
        const selected = selectedShapeId === shape.id;
        const flagged = flaggedShapeIds.has(shape.id);
        return (
          <div
            key={shape.id}
            className={
              'tl-shape' + (selected ? ' selected' : '') + (flagged ? ' flagged' : '')
            }
            style={{ left, width, top }}
            title={
              flagged
                ? `${kindLabel(shape.kind)}（カット区間内）`
                : kindLabel(shape.kind)
            }
            onPointerDown={(e) => {
              e.stopPropagation();
              onHandleDown({ kind: 'shape', shapeId: shape.id, edge: 'body' }, e);
            }}
          >
            <span className="tl-shape-label">{kindLabel(shape.kind)}</span>
            <div
              className="tl-shape-handle tl-shape-handle-start"
              onPointerDown={(e) => {
                e.stopPropagation();
                onHandleDown({ kind: 'shape', shapeId: shape.id, edge: 'start' }, e);
              }}
            />
            <div
              className="tl-shape-handle tl-shape-handle-end"
              onPointerDown={(e) => {
                e.stopPropagation();
                onHandleDown({ kind: 'shape', shapeId: shape.id, edge: 'end' }, e);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
