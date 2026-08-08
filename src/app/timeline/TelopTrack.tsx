import { useMemo } from 'react';
import { frameToXMapped, widthMapped } from './timelineGeometry';
import { assignTelopLanes } from './telopLanes';
import type { EditorTelop } from '../../core/types';
import type { DisplayMap } from '../../core/timelineDisplayMap';
import { TrackHeader } from './TrackHeader';

/** つまみ識別子。テロップトラックではテロップの片端または本体を表す。 */
export interface TelopHandleId {
  kind: 'telop';
  telopId: number;
  edge: 'start' | 'end' | 'body';
}

/** ドラッグ中にライブ表示で差し替えるテロップ区間。 */
export interface TelopOverride {
  telopId: number;
  originalStart: number;
  originalEnd: number;
}

interface TelopTrackProps {
  pxPerFrame: number;
  telops: EditorTelop[];
  /** 選択中のテロップ ID（インスペクタ選択と同期）。 */
  selectedTelopId: number | null;
  /** ドラッグ中のテロップ区間を上書き表示する。null ならコミット済み state を使う。 */
  liveOverride: TelopOverride | null;
  /** 矢印キー対象として選択中のつまみ（強調表示用）。 */
  selectedHandle: TelopHandleId | null;
  /** つまみ上（または本体）で pointerdown したとき。本体は edge:'body' で選択もここで担う。 */
  onHandleDown: (handle: TelopHandleId, e: React.PointerEvent) => void;
  /** 表示マップ（区間速度の伸縮・省略時は恒等）。 */
  map?: DisplayMap;
  /**
   * Task 2: 表示ラベル文字列。
   * 'subtitle' = 字幕行（じまく）、'manual' = 手動テロップ行（テロップ）。
   */
  label: string;
  /**
   * Task 2: トラック種別。
   * 'subtitle' → wrapper クラス 'tl-track tl-track-jimaku'
   * 'manual'   → wrapper クラス 'tl-track tl-track-telop'
   */
  variant: 'subtitle' | 'manual';
}

/** 2 つの TelopHandleId が同じつまみを指すか。 */
function sameHandle(a: TelopHandleId, b: TelopHandleId | null): boolean {
  return b !== null && a.telopId === b.telopId && a.edge === b.edge;
}

/**
 * テロップトラック（汎用）。字幕行／手動テロップ行の両方に使う。
 * variant によって wrapper クラスと TrackHeader の kind が変わる。
 * クリップ本体のクラスは variant に関わらず .tl-telop を維持する。
 */
export function TelopTrack({
  pxPerFrame,
  telops,
  selectedTelopId,
  liveOverride,
  selectedHandle,
  onHandleDown,
  map,
  label,
  variant,
}: TelopTrackProps) {
  // 時間が重なるテロップは assignLanes で別レーン（行）へ自動振り分けして縦に積む。
  // レーンは committed telops から計算し、ドラッグ中の liveOverride は X のみ反映する
  // （行レイアウトを固定して行飛びを防ぐ。ImageTrack と同じ方針）。
  const { lanes, laneCount } = useMemo(
    () =>
      assignTelopLanes(
        telops.map((t) => ({ start: t.originalStart, end: t.originalEnd, manual: t.manual === true })),
      ),
    [telops],
  );
  const trackStyle = { ['--lane-count']: Math.max(1, laneCount) } as React.CSSProperties;
  const trackClass =
    variant === 'subtitle' ? 'tl-track tl-track-jimaku' : 'tl-track tl-track-telop';
  const iconKind = variant === 'subtitle' ? ('jimaku' as const) : ('telop' as const);
  return (
    <div className={trackClass} style={trackStyle}>
      <TrackHeader kind={iconKind} label={label} />
      {telops.map((t, i) => {
        // ドラッグ中のテロップはライブ区間で描く。
        const start = liveOverride?.telopId === t.id ? liveOverride.originalStart : t.originalStart;
        const end = liveOverride?.telopId === t.id ? liveOverride.originalEnd : t.originalEnd;
        const left = frameToXMapped(start, pxPerFrame, map);
        const width = Math.max(4, widthMapped(start, end, pxPerFrame, map));
        const lane = lanes[i] ?? 0;
        const top = `calc(${lane} * var(--lane-row-h) + var(--lane-inset))`;
        const selected = selectedTelopId === t.id;
        const startHandle: TelopHandleId = { kind: 'telop', telopId: t.id, edge: 'start' };
        const endHandle: TelopHandleId = { kind: 'telop', telopId: t.id, edge: 'end' };
        return (
          <div
            key={t.id}
            className={'tl-telop' + (selected ? ' selected' : '') + (t.manual === true ? ' manual' : '')}
            style={{ left, width, top }}
            title={t.text}
            onPointerDown={(e) => {
              e.stopPropagation();
              onHandleDown({ kind: 'telop', telopId: t.id, edge: 'body' }, e);
            }}
          >
            <span className="tl-telop-text">{t.text}</span>
            <div
              className={'tl-handle start' + (sameHandle(startHandle, selectedHandle) ? ' selected' : '')}
              title="テロップ開始をドラッグして調整"
              onPointerDown={(e) => {
                e.stopPropagation();
                onHandleDown(startHandle, e);
              }}
            />
            <div
              className={'tl-handle end' + (sameHandle(endHandle, selectedHandle) ? ' selected' : '')}
              title="テロップ終了をドラッグして調整"
              onPointerDown={(e) => {
                e.stopPropagation();
                onHandleDown(endHandle, e);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
