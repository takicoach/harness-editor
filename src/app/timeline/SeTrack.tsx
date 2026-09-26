import { useEffect, useMemo, useRef } from 'react';
import { frameToXMapped, widthMapped } from './timelineGeometry';
import { assignLanes } from './lanePacking';
import type { DisplayMap } from '../../core/timelineDisplayMap';
import { useAudioClips } from '../audio/useAudioClips';
import { clipFramesFromDuration } from './audioClipGeometry';
import { DEFAULT_SE_DURATION_FRAMES } from '../edit/seOps';
import { normalizedVolumeFromSamples } from '../audio/loudness';
import { Waveform } from './Waveform';
import type { EditorSe } from '../../core/types';
import { TrackHeader } from './TrackHeader';
import { assetUrl, assetPathFor } from '../panels/materialList';
import { clipHandleWidth, clipHandleStyle } from './clipHandles';
import { clipAriaLabel, handleClipNavKey, isClipActivateKey, rovingTabIndex } from './clipAria';

/** SE つまみ識別子。区間伸縮・本体移動・フェード長。 */
export interface SeHandleId {
  kind: 'se';
  seId: number;
  edge: 'start' | 'end' | 'body' | 'fadeIn' | 'fadeOut';
}

/** ドラッグ中にライブ表示で差し替える SE 区間。 */
export interface SeOverride {
  seId: number;
  originalStart: number;
  originalEnd: number;
}

interface SeTrackProps {
  /**
   * クリップを **キーボードで** 選んだとき（Enter / Space）。監査 interaction-10。
   * ポインタ経路（onHandleDown）と違い、ドラッグを始めずに選択だけを行う。
   */
  onActivate?: (handle: SeHandleId) => void;
  pxPerFrame: number;
  se: EditorSe[];
  /** asset URL 用のプロジェクト ID（音源の波形・長さデコード）。 */
  projectId: string;
  /** ライブラリ各ファイルの size-mtime トークン。asset URL の &v=（同名差し替えバスト）用。 */
  assetVersions?: Record<string, string>;
  /** プロジェクト fps（音源長 → クリップ幅フレーム換算）。 */
  fps: number;
  /** カット区間内にある SE の ID 集合（警告表示用）。 */
  flaggedSeIds: Set<number>;
  /** 選択中の SE ID（インスペクタ選択と同期）。 */
  selectedSeId: number | null;
  /** ドラッグ中の SE 区間を上書き表示する。null ならコミット済み state を使う。 */
  liveOverride: SeOverride | null;
  /** クリップ上で pointerdown したとき（選択 + ドラッグ開始）。 */
  onHandleDown: (handle: SeHandleId, e: React.PointerEvent) => void;
  /** 表示マップ（区間速度の伸縮・省略時は恒等）。 */
  map?: DisplayMap;
  /**
   * 音源デコード後、追加直後の SE を自然長＋ラウドネス正規化で一度だけ確定する。
   * fit と normalize を1回の apply に合成し、lost-update を防ぐ。
   */
  onFinalize: (seId: number, durationFrames: number, volume: number) => void;
}

/**
 * SE トラック。効果音は BGM と同じ区間クリップ（originalStart..originalEnd）で描く。
 * 座標系は原本フレーム。重なりは assignLanes で縦に積む。
 * 新規挿入（autoLength）の SE は音源デコード後に自然長へ auto-fit する。
 */
export function SeTrack({
  pxPerFrame,
  se,
  projectId,
  assetVersions,
  fps,
  flaggedSeIds,
  selectedSeId,
  liveOverride,
  onHandleDown,
  onActivate,
  onFinalize,
  map,
}: SeTrackProps) {
  const audioClips = useAudioClips(
    se.map((s) => assetUrl(projectId, assetPathFor('se', s.file), assetVersions)),
  );

  // 追加直後の SE をデコード後に一度だけ確定（fit＋正規化を1 apply で・lost-update 防止）。
  const finalizedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    se.forEach((s, i) => {
      if (s.autoLength !== true && s.autoVolume !== true) return;
      if (finalizedRef.current.has(s.id)) return;
      const clip = audioClips[i]?.clip;
      if (!clip || clip.samples === null) return; // samples/durationSec は原子的に揃う
      const frames = clipFramesFromDuration(clip.durationSec ?? null, fps, DEFAULT_SE_DURATION_FRAMES);
      const volume = normalizedVolumeFromSamples(clip.samples, 'se');
      finalizedRef.current.add(s.id);
      onFinalize(s.id, frames, volume);
    });
  }, [se, audioClips, fps, onFinalize]);

  const { lanes, laneCount } = useMemo(
    () => assignLanes(se.map((s) => ({ start: s.originalStart, end: s.originalEnd }))),
    [se],
  );
  // ロービング tabindex 用の並び（DOM の描画順と同じ）。タブ停止はこの中の 1 個だけ。
  const clipIds = se.map((s) => s.id);
  const trackStyle = { ['--lane-count']: Math.max(1, laneCount) } as React.CSSProperties;

  return (
    <div className={'tl-track tl-track-se' + (se.length === 0 ? ' tl-track-empty' : '')} style={trackStyle}>
      <TrackHeader kind="se" label="効果音" />
      {se.map((s, i) => {
        const start = liveOverride?.seId === s.id ? liveOverride.originalStart : s.originalStart;
        const end = liveOverride?.seId === s.id ? liveOverride.originalEnd : s.originalEnd;
        const left = frameToXMapped(start, pxPerFrame, map);
        const width = Math.max(2, widthMapped(start, end, pxPerFrame, map));
        // つまみ幅（極小クリップでは非表示）。監査 interaction-4。
        const handleW = clipHandleWidth(width, 6);
        const lane = lanes[i] ?? 0;
        const top = `calc(${lane} * var(--lane-row-h) + var(--lane-inset))`;
        const selected = selectedSeId === s.id;
        const flagged = flaggedSeIds.has(s.id);
        const fadeInPx = Math.min(widthMapped(start, start + (s.fadeInFrames ?? 0), pxPerFrame, map), width);
        const fadeOutPx = Math.min(widthMapped(end - (s.fadeOutFrames ?? 0), end, pxPerFrame, map), width);
        return (
          <div
            key={s.id}
            data-testid={`clip-se-${s.id}`}
            // キーボードから到達して選べるようにする（監査 interaction-10）。
            // これが無いと selectedHandle が立たず、←/→ の 1 フレーム微調整に届かない。
            // ただしタブ停止はトラックで 1 個だけ（ロービング tabindex・サイクル 4 レビュー
            // Important）。全クリップを停止にすると 120 個超の Tab でしか抜けられない。
            // 停止以外のクリップへは ↑/↓・Home/End で移る。
            tabIndex={rovingTabIndex(s.id, clipIds, selectedSeId)}
            data-clip-nav=""
            role="button"
            aria-label={clipAriaLabel('効果音', start, end, fps, s.file)}
            onKeyDown={(e) => {
              // ↑/↓・Home/End は同じトラック内のクリップ移動（←/→ は 1 フレーム微調整のまま）。
              if (handleClipNavKey(e.key, e.currentTarget)) {
                e.preventDefault();
                return;
              }
              if (!isClipActivateKey(e.key)) return;
              e.preventDefault();
              onActivate?.({ kind: 'se', seId: s.id, edge: 'body' });
            }}
            data-id={s.id}
            className={'tl-se-clip' + (selected ? ' selected' : '') + (flagged ? ' flagged' : '')}
            style={{ left, width, top }}
            title={(flagged ? `${s.file}（カット区間内）` : s.file) + `（音量 ${Math.round((s.volume ?? 1) * 100)}%）`}
            onPointerDown={(e) => {
              e.stopPropagation();
              onHandleDown({ kind: 'se', seId: s.id, edge: 'body' }, e);
            }}
          >
            {/* コンテンツ（波形・ラベル）を overflow:hidden でクリップ。端つまみは clip 外へ出る。 */}
            <div className="tl-se-clip-content">
              <Waveform
                samples={audioClips[i]?.clip?.samples ?? null}
                width={width}
                height={24}
                className="tl-clip-waveform"
                gain={Math.max(0.2, s.volume ?? 1)}
              />
              <span className="tl-se-label">{s.file}</span>
            </div>
            <div
              className="tl-se-handle tl-se-handle-start"
              style={clipHandleStyle(handleW, 'start')}
              onPointerDown={(e) => { e.stopPropagation(); onHandleDown({ kind: 'se', seId: s.id, edge: 'start' }, e); }}
            />
            <div
              className="tl-se-handle tl-se-handle-end"
              style={clipHandleStyle(handleW, 'end')}
              onPointerDown={(e) => { e.stopPropagation(); onHandleDown({ kind: 'se', seId: s.id, edge: 'end' }, e); }}
            />
            {(s.fadeInFrames ?? 0) > 0 && (
              <div className="tl-se-fade-in" style={{ borderRightWidth: fadeInPx }} title={`フェードイン: ${s.fadeInFrames} フレーム`} />
            )}
            {(s.fadeOutFrames ?? 0) > 0 && (
              <div className="tl-se-fade-out" style={{ borderLeftWidth: fadeOutPx }} title={`フェードアウト: ${s.fadeOutFrames} フレーム`} />
            )}
            <div
              className="tl-se-fade-hit tl-se-fade-in-hit"
              title={(s.fadeInFrames ?? 0) > 0 ? `フェードイン: ${s.fadeInFrames} フレーム` : 'フェードイン（クリックしてドラッグ）'}
              onPointerDown={(e) => { e.stopPropagation(); onHandleDown({ kind: 'se', seId: s.id, edge: 'fadeIn' }, e); }}
            />
            <div
              className="tl-se-fade-hit tl-se-fade-out-hit"
              title={(s.fadeOutFrames ?? 0) > 0 ? `フェードアウト: ${s.fadeOutFrames} フレーム` : 'フェードアウト（クリックしてドラッグ）'}
              onPointerDown={(e) => { e.stopPropagation(); onHandleDown({ kind: 'se', seId: s.id, edge: 'fadeOut' }, e); }}
            />
          </div>
        );
      })}
    </div>
  );
}
