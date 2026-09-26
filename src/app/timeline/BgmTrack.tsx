import { useEffect, useMemo, useRef } from 'react';
import { frameToXMapped, widthMapped } from './timelineGeometry';
import { assignLanes } from './lanePacking';
import type { EditorBgmClip } from '../../core/types';
import type { DisplayMap } from '../../core/timelineDisplayMap';
import { TrackHeader } from './TrackHeader';
import { useAudioClips } from '../audio/useAudioClips';
import { normalizedVolumeFromSamples } from '../audio/loudness';
import { Waveform } from './Waveform';
import { assetUrl, assetPathFor } from '../panels/materialList';
import { clipHandleWidth, clipHandleStyle } from './clipHandles';
import { clipAriaLabel, handleClipNavKey, isClipActivateKey, rovingTabIndex } from './clipAria';

/**
 * BGM つまみ識別子。
 * - 'start' / 'end': 区間の左端・右端（区間伸縮）
 * - 'body': ブロック本体（平行移動）
 * - 'fadeIn' / 'fadeOut': フェードイン長・フェードアウト長つまみ（三角ハンドル）
 */
export interface BgmHandleId {
  kind: 'bgm';
  bgmId: number;
  edge: 'start' | 'end' | 'body' | 'fadeIn' | 'fadeOut';
}

/** ドラッグ中にライブ表示で差し替える BGM 位置。 */
export interface BgmOverride {
  bgmId: number;
  originalStart: number;
  originalEnd: number;
}

interface BgmTrackProps {
  /** 読み上げ名の時刻表示に使う fps（監査 interaction-10）。 */
  fps: number;
  /**
   * クリップを **キーボードで** 選んだとき（Enter / Space）。監査 interaction-10。
   * ポインタ経路（onHandleDown）と違い、ドラッグを始めずに選択だけを行う。
   */
  onActivate?: (handle: BgmHandleId) => void;
  pxPerFrame: number;
  bgm: EditorBgmClip[];
  /** asset URL 用のプロジェクト ID（クリップ内波形のデコード）。 */
  projectId: string;
  /** ライブラリ各ファイルの size-mtime トークン。asset URL の &v=（同名差し替えバスト）用。 */
  assetVersions?: Record<string, string>;
  /** カット区間内に完全に飲まれた BGM クリップの ID 集合（警告表示用）。 */
  flaggedBgmIds: Set<number>;
  /** 選択中の BGM ID（インスペクタ選択と同期）。 */
  selectedBgmId: number | null;
  /** ドラッグ中の BGM 位置を上書き表示する。null ならコミット済み state を使う。 */
  liveOverride: BgmOverride | null;
  /** ブロック上で pointerdown したとき（選択 + ドラッグ開始）。 */
  onHandleDown: (handle: BgmHandleId, e: React.PointerEvent) => void;
  /** 音源デコード後、autoVolume の BGM をラウドネス正規化した音量へ合わせる。 */
  onNormalizeVolume: (bgmId: number, volume: number) => void;
  /** 表示マップ（区間速度の伸縮・省略時は恒等）。 */
  map?: DisplayMap;
}

/**
 * BGM トラック。BGM クリップは区間イベントなのでブロックで描く。
 * 座標系は原本フレーム（CutTrack / TelopTrack / VideoInsertTrack と同じ）。
 *
 * BGM 固有の差分（VideoInsertTrack との違い）:
 * - 自動レーン: 時間が重なる BGM は assignLanes で別レーン（行）へ振り分けて縦に積む
 *   （ImageTrack / VideoInsertTrack と同方針）。重なり時の音声挙動（2曲同時再生）は別課題。
 * - フェードつまみ: 各ブロックに fadeIn（左上）・fadeOut（右上）の三角ハンドルを追加。
 *   三角は CSS の border トリック（.tl-bgm-fade-in / .tl-bgm-fade-out）。
 * - アクセントカラー: --accent-4（緑系）。
 */
export function BgmTrack({
  pxPerFrame,
  bgm,
  projectId,
  assetVersions,
  flaggedBgmIds,
  selectedBgmId,
  liveOverride,
  onHandleDown,
  fps,
  onActivate,
  onNormalizeVolume,
  map,
}: BgmTrackProps) {
  // 時間が重なる BGM は assignLanes で別レーン（行）へ自動振り分けして縦に積む。
  // レーンは committed bgm から計算し、ドラッグ中の liveOverride は X のみ反映する。
  const { lanes, laneCount } = useMemo(
    () => assignLanes(bgm.map((c) => ({ start: c.originalStart, end: c.originalEnd }))),
    [bgm],
  );
  // クリップ内に敷く波形サンプル（曲ファイルを非同期デコード・キャッシュ）。
  const audioClips = useAudioClips(
    bgm.map((c) => assetUrl(projectId, assetPathFor('bgm', c.file), assetVersions)),
  );
  const normalizedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    bgm.forEach((c, i) => {
      if (c.autoVolume !== true) return;
      if (normalizedRef.current.has(c.id)) return;
      const samples = audioClips[i]?.clip?.samples ?? null;
      if (samples === null) return;
      normalizedRef.current.add(c.id);
      onNormalizeVolume(c.id, normalizedVolumeFromSamples(samples, 'bgm'));
    });
  }, [bgm, audioClips, onNormalizeVolume]);

  // ロービング tabindex 用の並び（DOM の描画順と同じ）。タブ停止はこの中の 1 個だけ。
  const clipIds = bgm.map((c) => c.id);
  const trackStyle = { ['--lane-count']: Math.max(1, laneCount) } as React.CSSProperties;
  return (
    <div className={'tl-track tl-track-bgm' + (bgm.length === 0 ? ' tl-track-empty' : '')} style={trackStyle}>
      <TrackHeader kind="bgm" label="BGM" />
      {bgm.map((clip, i) => {
        const start =
          liveOverride?.bgmId === clip.id ? liveOverride.originalStart : clip.originalStart;
        const end =
          liveOverride?.bgmId === clip.id ? liveOverride.originalEnd : clip.originalEnd;
        const left = frameToXMapped(start, pxPerFrame, map);
        const width = Math.max(2, widthMapped(start, end, pxPerFrame, map));
        // つまみ幅（極小クリップでは非表示）。監査 interaction-4。
        const handleW = clipHandleWidth(width, 6);
        // 時間が重なる BGM は別レーンへ。lane * --lane-row-h + --lane-inset で縦位置を決める。
        const lane = lanes[i] ?? 0;
        const top = `calc(${lane} * var(--lane-row-h) + var(--lane-inset))`;
        const selected = selectedBgmId === clip.id;
        const flagged = flaggedBgmIds.has(clip.id);

        // フェードイン幅（px）。ブロック幅を超えないようクランプ。フェードは区間先頭から。
        const fadeInPx = Math.min(
          widthMapped(start, start + clip.fadeInFrames, pxPerFrame, map),
          width,
        );
        // フェードアウト幅（px）。フェードは区間末尾まで。
        const fadeOutPx = Math.min(
          widthMapped(end - clip.fadeOutFrames, end, pxPerFrame, map),
          width,
        );

        return (
          <div
            key={clip.id}
            data-testid={`clip-bgm-${clip.id}`}
            // キーボードから到達して選べるようにする（監査 interaction-10）。
            // これが無いと selectedHandle が立たず、←/→ の 1 フレーム微調整に届かない。
            // ただしタブ停止はトラックで 1 個だけ（ロービング tabindex・サイクル 4 レビュー
            // Important）。全クリップを停止にすると 120 個超の Tab でしか抜けられない。
            // 停止以外のクリップへは ↑/↓・Home/End で移る。
            tabIndex={rovingTabIndex(clip.id, clipIds, selectedBgmId)}
            data-clip-nav=""
            role="button"
            aria-label={clipAriaLabel('BGM', start, end, fps, clip.file)}
            onKeyDown={(e) => {
              // ↑/↓・Home/End は同じトラック内のクリップ移動（←/→ は 1 フレーム微調整のまま）。
              if (handleClipNavKey(e.key, e.currentTarget)) {
                e.preventDefault();
                return;
              }
              if (!isClipActivateKey(e.key)) return;
              e.preventDefault();
              onActivate?.({ kind: 'bgm', bgmId: clip.id, edge: 'body' });
            }}
            data-id={clip.id}
            className={'tl-bgm-block' + (selected ? ' selected' : '') + (flagged ? ' flagged' : '')}
            style={{ left, width, top }}
            title={(flagged ? `${clip.file}（カット区間内）` : clip.file) + `（音量 ${Math.round((clip.volume ?? 1) * 100)}%）`}
            onPointerDown={(e) => {
              e.stopPropagation();
              onHandleDown({ kind: 'bgm', bgmId: clip.id, edge: 'body' }, e);
            }}
          >
            <Waveform
              samples={audioClips[i]?.clip?.samples ?? null}
              width={width}
              height={28}
              className="tl-clip-waveform"
              gain={Math.max(0.2, clip.volume ?? 1)}
            />
            <span className="tl-bgm-label">{clip.file}</span>
            {/* 区間伸縮つまみ（VideoInsertTrack と同じ） */}
            <div
              className="tl-bgm-handle tl-bgm-handle-start"
              style={clipHandleStyle(handleW, 'start')}
              onPointerDown={(e) => {
                e.stopPropagation();
                onHandleDown({ kind: 'bgm', bgmId: clip.id, edge: 'start' }, e);
              }}
            />
            <div
              className="tl-bgm-handle tl-bgm-handle-end"
              style={clipHandleStyle(handleW, 'end')}
              onPointerDown={(e) => {
                e.stopPropagation();
                onHandleDown({ kind: 'bgm', bgmId: clip.id, edge: 'end' }, e);
              }}
            />
            {/* フェードイン三角（左上）: 見た目専用。fade=0 のときは非表示だがヒット矩形は常時存在。 */}
            {clip.fadeInFrames > 0 && (
              <div
                className="tl-bgm-fade-in"
                style={{ borderRightWidth: fadeInPx }}
                title={`フェードイン: ${clip.fadeInFrames} フレーム`}
              />
            )}
            {/* フェードアウト三角（右上）: 見た目専用。 */}
            {clip.fadeOutFrames > 0 && (
              <div
                className="tl-bgm-fade-out"
                style={{ borderLeftWidth: fadeOutPx }}
                title={`フェードアウト: ${clip.fadeOutFrames} フレーム`}
              />
            )}
            {/* 透明ヒット矩形（常時）: fade=0 でも掴めるようにする。
                left:6px / right:6px で区間つまみ（端 ±3px）の内側に収める。
                pointer-events:all + cursor:ew-resize + onPointerDown でドラッグ開始。 */}
            <div
              className="tl-bgm-fade-hit tl-bgm-fade-in-hit"
              title={clip.fadeInFrames > 0 ? `フェードイン: ${clip.fadeInFrames} フレーム` : 'フェードイン（クリックしてドラッグ）'}
              onPointerDown={(e) => {
                e.stopPropagation();
                onHandleDown({ kind: 'bgm', bgmId: clip.id, edge: 'fadeIn' }, e);
              }}
            />
            <div
              className="tl-bgm-fade-hit tl-bgm-fade-out-hit"
              title={clip.fadeOutFrames > 0 ? `フェードアウト: ${clip.fadeOutFrames} フレーム` : 'フェードアウト（クリックしてドラッグ）'}
              onPointerDown={(e) => {
                e.stopPropagation();
                onHandleDown({ kind: 'bgm', bgmId: clip.id, edge: 'fadeOut' }, e);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
