import { useMemo } from 'react';
import { frameToXMapped, widthMapped } from './timelineGeometry';
import { assignLanes } from './lanePacking';
import type { EditorImage } from '../../core/types';
import type { DisplayMap } from '../../core/timelineDisplayMap';
import { TrackHeader } from './TrackHeader';

/** つまみ識別子。画像トラックでは 1 つの画像ブロックの端／本体を表す。 */
export interface ImageHandleId {
  kind: 'image';
  imageId: number;
  edge: 'start' | 'end' | 'body';
}

/** ドラッグ中にライブ表示で差し替える画像位置。 */
export interface ImageOverride {
  imageId: number;
  originalStart: number;
  originalEnd: number;
}

interface ImageTrackProps {
  pxPerFrame: number;
  images: EditorImage[];
  /** カット区間内に完全に飲まれた画像の ID 集合（警告表示用）。 */
  flaggedImageIds: Set<number>;
  /** 選択中の画像 ID（インスペクタ選択と同期）。 */
  selectedImageId: number | null;
  /** ドラッグ中の画像位置を上書き表示する。null ならコミット済み state を使う。 */
  liveOverride: ImageOverride | null;
  /** ブロック上で pointerdown したとき（選択 + ドラッグ開始）。 */
  onHandleDown: (handle: ImageHandleId, e: React.PointerEvent) => void;
  /** 表示マップ（区間速度の伸縮・省略時は恒等）。 */
  map?: DisplayMap;
}

/**
 * 画像トラック。挿入画像は区間イベントなのでテロップと同じくブロックで描く。
 * 座標系は原本フレーム（CutTrack / TelopTrack / SeTrack と同じ）。
 * 時間が重なる画像は assignLanes で別レーン（行）へ自動振り分けして縦に積む。
 * レーンは committed images から計算し、ドラッグ中の liveOverride は X のみ反映する
 * （行レイアウトを固定して行飛びを防ぐ。確定後の再レンダーで再計算される）。
 */
export function ImageTrack({
  pxPerFrame,
  images,
  flaggedImageIds,
  selectedImageId,
  liveOverride,
  onHandleDown,
  map,
}: ImageTrackProps) {
  // images 配列の参照が変わるたびに再計算（EditState は編集ごとに新配列を生成する）
  const { lanes, laneCount } = useMemo(
    () => assignLanes(images.map((i) => ({ start: i.originalStart, end: i.originalEnd }))),
    [images],
  );
  const trackStyle = { ['--lane-count']: Math.max(1, laneCount) } as React.CSSProperties;

  return (
    <div className="tl-track tl-track-image" style={trackStyle}>
      <TrackHeader kind="image" label="画像" />
      {images.map((img, i) => {
        const start =
          liveOverride?.imageId === img.id ? liveOverride.originalStart : img.originalStart;
        const end =
          liveOverride?.imageId === img.id ? liveOverride.originalEnd : img.originalEnd;
        const left = frameToXMapped(start, pxPerFrame, map);
        const width = Math.max(2, widthMapped(start, end, pxPerFrame, map));
        const lane = lanes[i] ?? 0;
        const top = `calc(${lane} * var(--lane-row-h) + var(--lane-inset))`;
        const selected = selectedImageId === img.id;
        const flagged = flaggedImageIds.has(img.id);
        return (
          <div
            key={img.id}
            className={
              'tl-image-block' + (selected ? ' selected' : '') + (flagged ? ' flagged' : '')
            }
            style={{ left, width, top }}
            title={
              flagged
                ? `${img.file}（カット区間内）`
                : `${img.file}（${img.type}）`
            }
            onPointerDown={(e) => {
              e.stopPropagation();
              onHandleDown({ kind: 'image', imageId: img.id, edge: 'body' }, e);
            }}
          >
            <span className="tl-image-label">{img.file}</span>
            <div
              className="tl-image-handle tl-image-handle-start"
              onPointerDown={(e) => {
                e.stopPropagation();
                onHandleDown({ kind: 'image', imageId: img.id, edge: 'start' }, e);
              }}
            />
            <div
              className="tl-image-handle tl-image-handle-end"
              onPointerDown={(e) => {
                e.stopPropagation();
                onHandleDown({ kind: 'image', imageId: img.id, edge: 'end' }, e);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
