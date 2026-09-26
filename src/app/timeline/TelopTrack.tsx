import { useMemo } from 'react';
import { frameToXMapped, widthMapped } from './timelineGeometry';
import { assignTelopLanes } from './telopLanes';
import type { EditorTelop } from '../../core/types';
import type { DisplayMap } from '../../core/timelineDisplayMap';
import { TrackHeader } from './TrackHeader';
import { clipHandleWidth, clipHandleStyle } from './clipHandles';
import { clipAriaLabel, handleClipNavKey, isClipActivateKey, rovingTabIndex } from './clipAria';

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
  /** 読み上げ名の時刻表示に使う fps（監査 interaction-10）。 */
  fps: number;
  /**
   * クリップを **キーボードで** 選んだとき（Enter / Space）。監査 interaction-10。
   * ポインタ経路（onHandleDown）と違い、ドラッグを始めずに選択だけを行う。
   */
  onActivate?: (handle: TelopHandleId) => void;
  pxPerFrame: number;
  telops: EditorTelop[];
  /** 選択中のテロップ ID（インスペクタ選択と同期）。 */
  selectedTelopId: number | null;
  /**
   * 複数選択中のテロップ ID 群（`EditState.multiTelopIds`）。空なら単一選択。
   * プライマリ（selectedTelopId）と同じ選択枠スタイルで全部ハイライトする。
   */
  multiSelectedIds?: number[];
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
  multiSelectedIds = [],
  liveOverride,
  selectedHandle,
  onHandleDown,
  fps,
  onActivate,
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
  const multiSet = useMemo(() => new Set(multiSelectedIds), [multiSelectedIds]);
  // ロービング tabindex 用の並び（DOM の描画順と同じ）。タブ停止はこの中の 1 個だけ。
  const clipIds = telops.map((t) => t.id);
  const trackStyle = { ['--lane-count']: Math.max(1, laneCount) } as React.CSSProperties;
  // アイテムが 0 件のトラックは細い行へ畳む（ベースライン §トラック画面外）。
  // 空の行が通常高さで場所を取るせいで、実際に中身のある下段トラックが画面外に出ていた。
  const trackClass =
    (variant === 'subtitle' ? 'tl-track tl-track-jimaku' : 'tl-track tl-track-telop') +
    (telops.length === 0 ? ' tl-track-empty' : '');
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
        // つまみ幅（極小クリップでは非表示）。監査 interaction-4。
        const handleW = clipHandleWidth(width, 10);
        const lane = lanes[i] ?? 0;
        const top = `calc(${lane} * var(--lane-row-h) + var(--lane-inset))`;
        // 複数選択中は集合の全員を同じ選択枠でハイライトする（設計書 §2）。
        const selected = selectedTelopId === t.id || multiSet.has(t.id);
        const startHandle: TelopHandleId = { kind: 'telop', telopId: t.id, edge: 'start' };
        const endHandle: TelopHandleId = { kind: 'telop', telopId: t.id, edge: 'end' };
        return (
          <div
            key={t.id}
            // AI エージェントが「あのテロップ」を名前で指名できるようにする（ベースライン §AI）。
            data-testid={`clip-telop-${t.id}`}
            // キーボードから到達して選べるようにする（監査 interaction-10）。
            // これが無いと selectedHandle が立たず、←/→ の 1 フレーム微調整に届かない。
            // ただしタブ停止はトラックで 1 個だけ（ロービング tabindex・サイクル 4 レビュー
            // Important）。全クリップを停止にすると 120 個超の Tab でしか抜けられない。
            // 停止以外のクリップへは ↑/↓・Home/End で移る。
            tabIndex={rovingTabIndex(t.id, clipIds, selectedTelopId)}
            data-clip-nav=""
            role="button"
            aria-label={clipAriaLabel(label, start, end, fps, t.text)}
            onKeyDown={(e) => {
              // ↑/↓・Home/End は同じトラック内のクリップ移動（←/→ は 1 フレーム微調整のまま）。
              if (handleClipNavKey(e.key, e.currentTarget)) {
                e.preventDefault();
                return;
              }
              if (!isClipActivateKey(e.key)) return;
              e.preventDefault();
              onActivate?.({ kind: 'telop', telopId: t.id, edge: 'body' });
            }}
            data-id={t.id}
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
              style={clipHandleStyle(handleW, 'start')}
              title="テロップ開始をドラッグして調整"
              onPointerDown={(e) => {
                e.stopPropagation();
                onHandleDown(startHandle, e);
              }}
            />
            <div
              className={'tl-handle end' + (sameHandle(endHandle, selectedHandle) ? ' selected' : '')}
              style={clipHandleStyle(handleW, 'end')}
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
