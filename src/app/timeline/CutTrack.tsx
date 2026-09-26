import { useRef } from 'react';
import { frameToXMapped, widthMapped, CLICK_MOVE_THRESHOLD_PX, TRACK_LABEL_GUTTER_PX } from './timelineGeometry';
import { regionKey } from './cutPulse';
import { Waveform } from './Waveform';
import type { CutOrdering, CutRegion } from '../../core/types';
import type { DisplayMap } from '../../core/timelineDisplayMap';
import { TrackHeader } from './TrackHeader';
import { formatClock } from '../../shared/format';
import { useFilmstrip, STRIP_THUMB_PX } from './useFilmstrip';
import { KeyframeMarkers } from '../panels/KeyframeMarkers';
import { playbackToOriginal } from '../../core/segmentLayout';
import type { LayoutKeyframe } from '../../core/layoutKeyframes';
import { useWaveformSamples } from '../audio/useWaveformSamples';
import { waveformCanvasHeight, waveformGain, waveformTrackHeight, type WaveformPref } from '../layout/waveformPref';
import { clipHandleWidth, clipHandleStyle } from './clipHandles';

/** つまみ識別子。動画トラックではカット区間の片端を表す。 */
export interface CutHandleId {
  kind: 'cut';
  region: CutRegion;
  edge: 'start' | 'end';
}

interface CutTrackProps {
  /** 原本総フレーム数。 */
  totalFrames: number;
  pxPerFrame: number;
  cutRegions: CutRegion[];
  /** ドラッグ中のカット区間を上書き表示する（ライブプレビュー）。null ならコミット済み state を使う。 */
  liveRegions: CutRegion[] | null;
  /** 現在矢印キー対象として選択中のつまみ（強調表示用）。 */
  selectedHandle: CutHandleId | null;
  /** つまみ上で pointerdown したとき。Task 14 でドラッグ開始に使う。 */
  onHandleDown: (handle: CutHandleId, e: React.PointerEvent) => void;
  /** パルス表示するカット区間のキー集合（regionKey 形式）。 */
  pulseKeys: Set<string>;
  /** サムネ抽出・波形デコード用の動画 URL（= /api/video?…）。空ならサムネも波形もなし。 */
  videoUrl: string;
  /** カットブロックの hover 開始/終了を親へ通知する（双方向ハイライト用）。 */
  onRegionHover?: (region: CutRegion | null) => void;
  /** 動画トラック背景での pointerdown（範囲選択開始）。つまみ・既存カット帯の上では発火しない。 */
  onTrackPointerDown?: (e: React.PointerEvent) => void;
  /** true なら既存カット帯（.tl-cut）の上でも範囲選択を開始できる（カット確認モードの「カットを開ける」用）。 */
  selectOnCut?: boolean;
  /** 動画トラック見出しクリックで mainVideo を選択する（Task 7）。 */
  onSelectMainVideo?: () => void;
  /** メイン動画が選択中かどうか（見出しのハイライト表示用）。 */
  mainVideoSelected?: boolean;
  /** メイン動画の再生速度（Task 9）。1 以外のとき速度バッジを表示する。 */
  mainSpeed?: number;
  /** カット並び替えの対応表（再生↔原本の写像用）。恒等順列・未指定なら従来の単調モデル。 */
  ordering?: CutOrdering;
  /** 残す区間（速度選択用）。原本座標で描画する。 */
  keptSegments?: { id: number; originalStart: number; originalEnd: number; playbackStart?: number; playbackEnd?: number }[];
  /** 区間 id → 個別倍率（バッジ表示用）。 */
  segmentSpeeds?: Record<number, number>;
  /** 大域キーフレーム列（原本フレームアンカー・2 点以上で diamond マーカーを表示）。 */
  layoutKeyframes?: LayoutKeyframe[];
  /** キーフレームマーカーの時刻ラベル算出用。省略時はマーカー非表示。 */
  fps?: number;
  /** キーフレームマーカーの時刻ラベル算出用（原本→元フレーム変換）。 */
  onSeekPlayback?: (playbackFrame: number) => void;
  /** 選択中の区間 id。 */
  selectedSegmentId?: number | null;
  /** 残す区間をクリックしたとき（選択通知）。 */
  onSelectSegment?: (id: number) => void;
  /** 表示マップ（per-segment 速度有効時）。省略時は恒等（従来通り）。 */
  map?: DisplayMap;
  /** カットブロック本体のクリック（そのカット全体を範囲選択にする）。ドラッグと区別済みで呼ばれる。 */
  onRegionClick?: (region: CutRegion) => void;
  /** 波形の高さ設定（standard/large）。未指定時は 'standard' 扱い。 */
  waveformPref?: WaveformPref;
  /** Alternate host gutter; legacy callers retain the original 88px geometry. */
  gutterPx?: number;
  /** Native adapter accessibility/events on the existing handle DOM. Tiny
   * handles remain keyboard reachable without covering the cut's pointer area. */
  getHandleProps?: (handle: CutHandleId) => React.HTMLAttributes<HTMLDivElement>;
  regionHint?: (region: CutRegion) => string;
  emptyHint?: string | null;
}

/** 2 つの CutHandleId が同じつまみを指すか。 */
function sameHandle(a: CutHandleId, b: CutHandleId | null): boolean {
  return (
    b !== null &&
    a.edge === b.edge &&
    a.region.start === b.region.start &&
    a.region.end === b.region.end
  );
}

/**
 * カット区間ホバーの説明文（ベースライン §カット区間ホバー）。
 * 「何が起きているか（カット済み・その時刻）」と「どう戻すか（クリック→Delete）」を 1 行で言う。
 * クリックすると onRegionClick がその区間を範囲選択にし、選択中のカット帯に対する
 * Delete は「カットを開ける」（cutButtonMode が 'open' を返す）になる。
 */
function cutRegionHint(region: CutRegion, fps: number | undefined): string {
  const f = fps !== undefined && fps > 0 ? fps : 30;
  return `カット済み ${formatClock(region.start / f)}〜${formatClock(region.end / f)}（クリックで選択 → Delete で元に戻す）`;
}

/**
 * 動画トラック。原本タイムライン全長の帯を描き、その上にカット区間を
 * 赤ハッチブロックで重ね、各ブロックの左右端につまみを置く。
 * 座標系は原本フレーム（Plan 2B-2 設計判断 1）。
 */
export function CutTrack({
  totalFrames,
  pxPerFrame,
  cutRegions,
  liveRegions,
  selectedHandle,
  onHandleDown,
  pulseKeys,
  videoUrl,
  onRegionHover,
  onTrackPointerDown,
  selectOnCut,
  onSelectMainVideo,
  mainVideoSelected,
  mainSpeed,
  ordering,
  keptSegments,
  segmentSpeeds,
  layoutKeyframes,
  fps,
  onSeekPlayback,
  selectedSegmentId,
  onSelectSegment,
  map,
  onRegionClick,
  waveformPref = 'standard',
  gutterPx = TRACK_LABEL_GUTTER_PX,
  getHandleProps,
  regionHint,
  emptyHint = 'カットすると区間ごとに速度を設定できます。',
}: CutTrackProps) {
  const xAt = (frame: number) => frameToXMapped(frame,pxPerFrame,map) + gutterPx - TRACK_LABEL_GUTTER_PX;
  const handleStyle = (width: number | null,edge: 'start'|'end'): React.CSSProperties =>
    width === null && getHandleProps ? {...clipHandleStyle(1,edge),pointerEvents:'none'} : clipHandleStyle(width,edge);
  const regions = liveRegions ?? cutRegions;
  // 帯・波形の CSS 幅は「距離」（ガター無し）。frameToXMapped は「位置」用でガター(88px)を
  // 含むため、これを width に使うと帯・波形の左端がガター内(x=0)から始まってしまい、
  // frameToXMapped で置かれるカット帯・つまみ・サムネと frame=0 の位置がズレる（波形ズレの主因）。
  const contentWidth = widthMapped(0, totalFrames, pxPerFrame, map);
  // カットブロック本体のクリックとドラッグを区別するため、pointerdown 位置を記録する。
  const cutDownXRef = useRef<number | undefined>(undefined);
  // 残す区間のクリックとドラッグを区別するため、pointerdown 位置を区間 id ごとに記録する。
  // 同一要素上で mousedown→mouseup が起きると Chrome は click を発火するが、
  // ドラッグ中は onClick を呼びたくないため、移動量でフィルタする。
  // Map<segId, clientX> で各区間を独立管理し、同時ホバー等の混線を防ぐ。
  const segPointerDownX = useRef<Map<number, number>>(new Map());
  // 動画コンテンツ幅（ガター除く）に応じた疎なサムネ枚数。
  const thumbCount = Math.floor(contentWidth / STRIP_THUMB_PX);
  const filmstrip = useFilmstrip(videoUrl === '' ? null : videoUrl, totalFrames, thumbCount);
  // 波形サンプル（URL ごとに 1 回デコード）。読み込み中は failed=false のままなので、
  // 失敗ヒントは failed=true のときだけ出せる（X-2(b)）。
  const { samples, failed: waveformFailed } = useWaveformSamples(videoUrl === '' ? null : videoUrl);
  return (
    <div
      className="tl-track tl-track-cut"
      style={{ ['--tl-track-cut-h' as string]: `${waveformTrackHeight(waveformPref)}px`,['--track-label-w' as string]:`${gutterPx}px` }}
      onPointerDown={(e) => {
        const el = e.target as HTMLElement;
        // つまみ（.tl-handle）は自前で stopPropagation 済み。既存カット帯（.tl-cut）の上は
        // 従来どおり（バブリングで .tl-scroll の頭出し）に任せ、トラック背景でのみ範囲選択を始める。
        // トラック見出し（.tl-track-label）クリックは onClick で処理するため、本体ドラッグ開始を抑止する。
        // 残す区間帯（.tl-kept-segment）はドラッグ範囲選択を妨げない（クリック確定は onClick で処理）。
        if (el.classList.contains('tl-handle')) return;
        if (selectOnCut !== true && el.closest('.tl-cut') !== null) return;
        if (el.closest('.tl-track-label') !== null) return;
        onTrackPointerDown?.(e);
      }}
    >
      <TrackHeader
        kind="video"
        label="動画"
        onClick={onSelectMainVideo}
        selected={mainVideoSelected}
        badge={mainSpeed !== undefined && mainSpeed !== 1 ? (
          <span className="tl-main-speed-badge">
            {Number.isInteger(mainSpeed) ? `${mainSpeed}x` : `${mainSpeed.toFixed(2)}x`}
          </span>
        ) : undefined}
      />
      <div className="tl-video-base" style={{ width: contentWidth }} />
      <div className="tl-filmstrip" aria-hidden="true">
        {filmstrip.map((f) => (
          <img
            key={f.frame}
            className="tl-filmstrip-thumb"
            src={f.url}
            style={{ left: xAt(f.frame), width: STRIP_THUMB_PX }}
            alt=""
          />
        ))}
      </div>
      <Waveform
        samples={samples}
        width={contentWidth}
        height={waveformCanvasHeight(waveformPref)}
        gain={waveformGain(waveformPref)}
      />
      {waveformFailed && (
        // デコード失敗（音声トラックなし・破損・非対応形式）を無言で消さず理由を出す（G-3）。
        // 読み込み中は failed=false なのでここは出ない（X-2(b): 嘘の失敗表示の防止）。
        <p className="tl-waveform-hint" title="音声を読み込めませんでした（音声トラックなし・破損・非対応形式の可能性）">
          波形なし（音声を読み込めません）
        </p>
      )}
      {cutRegions.length === 0 && emptyHint && (
        <p className="tl-cut-hint">{emptyHint}</p>
      )}
      {cutRegions.length > 0 && keptSegments?.map((seg) => {
        const left = xAt(seg.originalStart);
        const width = Math.max(2, widthMapped(seg.originalStart, seg.originalEnd, pxPerFrame, map));
        const rate = segmentSpeeds?.[seg.id];
        return (
          <div
            key={`kept-${seg.id}`}
            data-testid={`clip-segment-${seg.id}`}
            data-id={seg.id}
            className={'tl-kept-segment' + (selectedSegmentId === seg.id ? ' selected' : '')}
            style={{ left, width }}
            onPointerDown={(e) => {
              // pointerdown 位置を区間 id ごとに記録してドラッグとクリックを区別する。
              // この要素上での pointerdown は親の onTrackPointerDown へバブルアップする。
              segPointerDownX.current.set(seg.id, e.clientX);
            }}
            onClick={(e) => {
              e.stopPropagation();
              // ドラッグ（大きな移動）後の偽クリックを除外する。
              // Chrome は同一要素で mousedown→mouseup が起きると距離によらず click を発火する。
              const downX = segPointerDownX.current.get(seg.id);
              if (
                downX !== undefined &&
                Math.abs(e.clientX - downX) > CLICK_MOVE_THRESHOLD_PX
              ) {
                return;
              }
              onSelectSegment?.(seg.id);
            }}
          >
            {rate !== undefined && (
              <span className="tl-seg-speed-badge">
                {Number.isInteger(rate) ? `${rate}x` : `${rate.toFixed(2)}x`}
              </span>
            )}
          </div>
        );
      })}
      {cutRegions.length > 0 && layoutKeyframes !== undefined && layoutKeyframes.length >= 2 && (
        <KeyframeMarkers
          layoutKeyframes={layoutKeyframes}
          cutRegions={cutRegions}
          ordering={ordering}
          fps={fps ?? 30}
          frameToX={(playbackFrame) => xAt(playbackToOriginal(playbackFrame, cutRegions, ordering))}
          onSeek={onSeekPlayback}
        />
      )}
      {regions.map((region, i) => {
        const left = xAt(region.start);
        const width = Math.max(2, widthMapped(region.start, region.end, pxPerFrame, map));
        // つまみ幅（極小クリップでは非表示）。監査 interaction-4。
        const handleW = clipHandleWidth(width, 10);
        const startHandle: CutHandleId = { kind: 'cut', region, edge: 'start' };
        const endHandle: CutHandleId = { kind: 'cut', region, edge: 'end' };
        const pulsing = pulseKeys.has(regionKey(region));
        return (
          <div
            key={i}
            // カット区間は id を持たないので原本フレーム範囲を名前にする。
            data-testid={`clip-cut-${region.start}-${region.end}`}
            data-start={region.start}
            data-end={region.end}
            className={'tl-cut' + (pulsing ? ' pulse' : '')}
            style={{ left, width }}
            // ホバーで「これは何で、押すとどうなるか」を出す（ベースライン §カット区間ホバー）。
            // 以前は赤い斜線の帯にカーソルを乗せても無反応で、消えている理由も戻し方も
            // 画面上のどこにも書かれていなかった。
            title={regionHint?.(region) ?? cutRegionHint(region, fps)}
            aria-label={regionHint?.(region) ?? cutRegionHint(region, fps)}
            // enter/leave（非バブリング）なので、内側の .tl-handle へ移っても leave は発火しない
            // ＝つまみ hover 中もハイライトが消えない。onPointerOver/Out に変えると壊れるので注意。
            onPointerEnter={() => onRegionHover?.(region)}
            onPointerLeave={() => onRegionHover?.(null)}
            onPointerDown={(e) => {
              cutDownXRef.current = e.clientX;
            }}
            onClick={(e) => {
              // .tl-kept-segment と同じ流儀: 先に伝播を止めてからクリック/ドラッグを判別する。
              e.stopPropagation();
              const downX = cutDownXRef.current;
              if (downX !== undefined && Math.abs(e.clientX - downX) > CLICK_MOVE_THRESHOLD_PX) return;
              onRegionClick?.(region);
            }}
          >
            <div
              className={'tl-handle start' + (sameHandle(startHandle, selectedHandle) ? ' selected' : '')}
              style={handleStyle(handleW, 'start')}
              title="カット開始をドラッグして調整"
              onPointerDown={(e) => { e.stopPropagation(); onHandleDown(startHandle, e); }}
              {...getHandleProps?.(startHandle)}
            />
            <div
              className={'tl-handle end' + (sameHandle(endHandle, selectedHandle) ? ' selected' : '')}
              style={handleStyle(handleW, 'end')}
              title="カット終了をドラッグして調整"
              onPointerDown={(e) => { e.stopPropagation(); onHandleDown(endHandle, e); }}
              {...getHandleProps?.(endHandle)}
            />
          </div>
        );
      })}
    </div>
  );
}
