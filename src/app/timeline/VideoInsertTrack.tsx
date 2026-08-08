import { useMemo } from 'react';
import { frameToXMapped, widthMapped } from './timelineGeometry';
import { assignLanes } from './lanePacking';
import type { EditorVideoInsert } from '../../core/types';
import type { DisplayMap } from '../../core/timelineDisplayMap';
import { TrackHeader } from './TrackHeader';

/** つまみ識別子。サブ動画トラックでは 1 つのサブ動画ブロックの端／本体を表す。 */
export interface VideoInsertHandleId {
  kind: 'videoInsert';
  videoInsertId: number;
  edge: 'start' | 'end' | 'body';
}

/** ドラッグ中にライブ表示で差し替えるサブ動画位置。 */
export interface VideoInsertOverride {
  videoInsertId: number;
  originalStart: number;
  originalEnd: number;
}

interface VideoInsertTrackProps {
  pxPerFrame: number;
  videoInserts: EditorVideoInsert[];
  /** カット区間内に完全に飲まれたサブ動画の ID 集合（警告表示用）。 */
  flaggedVideoInsertIds: Set<number>;
  /** 選択中のサブ動画 ID（インスペクタ選択と同期）。 */
  selectedVideoInsertId: number | null;
  /** ドラッグ中のサブ動画位置を上書き表示する。null ならコミット済み state を使う。 */
  liveOverride: VideoInsertOverride | null;
  /** ブロック上で pointerdown したとき（選択 + ドラッグ開始）。 */
  onHandleDown: (handle: VideoInsertHandleId, e: React.PointerEvent) => void;
  /** 表示マップ（区間速度の伸縮・省略時は恒等）。 */
  map?: DisplayMap;
}

/**
 * サブ動画トラック。サブ動画インサートは区間イベントなので画像と同じくブロックで描く。
 * 座標系は原本フレーム（CutTrack / TelopTrack / SeTrack / ImageTrack と同じ）。
 * 時間が重なるサブ動画は assignLanes で別レーン（行）へ自動振り分けして縦に積む。
 * レーンは committed videoInserts から計算し、ドラッグ中の liveOverride は X のみ反映する
 * （行レイアウトを固定して行飛びを防ぐ。確定後の再レンダーで再計算される）。
 */
export function VideoInsertTrack({
  pxPerFrame,
  videoInserts,
  flaggedVideoInsertIds,
  selectedVideoInsertId,
  liveOverride,
  onHandleDown,
  map,
}: VideoInsertTrackProps) {
  const { lanes, laneCount } = useMemo(
    () => assignLanes(videoInserts.map((v) => ({ start: v.originalStart, end: v.originalEnd }))),
    [videoInserts],
  );
  const trackStyle = { ['--lane-count']: Math.max(1, laneCount) } as React.CSSProperties;

  return (
    <div className="tl-track tl-track-vi" style={trackStyle}>
      <TrackHeader kind="vi" label="サブ動画" />
      {videoInserts.map((vi, i) => {
        const start =
          liveOverride?.videoInsertId === vi.id ? liveOverride.originalStart : vi.originalStart;
        const end =
          liveOverride?.videoInsertId === vi.id ? liveOverride.originalEnd : vi.originalEnd;
        const left = frameToXMapped(start, pxPerFrame, map);
        const width = Math.max(2, widthMapped(start, end, pxPerFrame, map));
        const lane = lanes[i] ?? 0;
        const top = `calc(${lane} * var(--lane-row-h) + var(--lane-inset))`;
        const selected = selectedVideoInsertId === vi.id;
        const flagged = flaggedVideoInsertIds.has(vi.id);
        return (
          <div
            key={vi.id}
            className={'tl-vi-block' + (selected ? ' selected' : '') + (flagged ? ' flagged' : '')}
            style={{ left, width, top }}
            title={flagged ? `${vi.file}（カット区間内）` : vi.file}
            onPointerDown={(e) => {
              e.stopPropagation();
              onHandleDown({ kind: 'videoInsert', videoInsertId: vi.id, edge: 'body' }, e);
            }}
          >
            <span className="tl-vi-label">{vi.file}</span>
            {vi.playbackRate !== undefined && vi.playbackRate !== 1 && (
              <span className="tl-vi-speed-badge">
                {Number.isInteger(vi.playbackRate) ? `${vi.playbackRate}x` : `${vi.playbackRate.toFixed(2)}x`}
              </span>
            )}
            <div
              className="tl-vi-handle tl-vi-handle-start"
              onPointerDown={(e) => {
                e.stopPropagation();
                onHandleDown({ kind: 'videoInsert', videoInsertId: vi.id, edge: 'start' }, e);
              }}
            />
            <div
              className="tl-vi-handle tl-vi-handle-end"
              onPointerDown={(e) => {
                e.stopPropagation();
                onHandleDown({ kind: 'videoInsert', videoInsertId: vi.id, edge: 'end' }, e);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
