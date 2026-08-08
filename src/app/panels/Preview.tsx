import { forwardRef, useMemo, type RefObject, type ComponentType } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import {
  makeEditorComposition,
  type EditorCompositionInputProps,
  type SeAudioInput,
  type ImageInput,
  type VideoInsertInput,
  type BgmInput,
  type ShapeInput,
} from '../../preview/EditorComposition';
import type { TelopComponent } from '../../preview/loadTelopComponent';
import type { InsertImageComponent } from '../../preview/loadInsertImageComponent';
import type { InsertVideoComponent } from '../../preview/loadInsertVideoComponent';
import type { PlaybackModel } from '../../preview/playbackModel';
import type { EditState } from '../edit/editState';
import { formatClock } from '../../shared/format';
import { PreviewOverlay, type DrawingKind } from '../preview/PreviewOverlay';
import { ShapeToolbar } from '../preview/ShapeToolbar';
import { assetUrl, assetPathFor } from './materialList';

interface PreviewProps {
  model: PlaybackModel;
  telop: TelopComponent;
  /** プロジェクトに InsertImage.tsx が無い場合は null。画像レイヤを描かない。 */
  insertImage: InsertImageComponent | null;
  /** プロジェクトに InsertVideo.tsx が無い場合は null。 */
  insertVideo: InsertVideoComponent | null;
  /**
   * insertVideo が null のとき同梱部品で代替描画してよいか（＝未導入プロジェクトか）。
   * 導入済みなのに読込失敗した場合は false＝描かない（書き出しとの乖離を無警告で隠さない）。
   */
  allowInsertVideoFallback: boolean;
  videoUrl: string;
  hasVideo: boolean;
  /** API id。SE 音声 URL の組み立てに使う。 */
  projectId: string;
  /** public/se/ にある効果音ファイル名。実体の無い SE はプレビューで鳴らさない。 */
  seLibrary: string[];
  /** public/images/ にある画像ファイル相対パス。実体の無い画像はプレビューで描かない。 */
  imageLibrary: string[];
  /** public/ にあるサブ動画ファイル名（メイン除く）。実体の無いサブ動画はプレビューで描かない。 */
  videoLibrary: string[];
  /** public/BGM/ にある BGM ファイル名。実体の無い BGM はプレビューで鳴らさない。 */
  bgmLibrary: string[];
  /** ライブラリ各ファイルの size-mtime トークン。asset URL の &v=（同名差し替えバスト）用。 */
  assetVersions?: Record<string, string>;
  /** 編集状態（オーバーレイの選択テロップ取得元）。 */
  state: EditState;
  /** ドラッグ追従用のライブ更新（履歴を積まない）。 */
  onLive: (next: EditState) => void;
  /** ドラッグ確定用の更新（履歴を 1 件積む）。 */
  onEdit: (next: EditState) => void;
  /** 描画ツール種別（null なら通常の選択・移動モード）。 */
  drawingKind?: DrawingKind;
  /** 描画ツール切替ハンドラ。同じ kind を渡すとトグル解除（null）。 */
  onDrawingKindChange: (v: DrawingKind) => void;
  /**
   * プレビュー再読み込み（C-4）。key として @remotion/player の Player に渡し、
   * 値が変わると Player だけを再マウントする（編集状態・PreviewOverlay は保持）。
   * 0（既定）の間は通常マウントのまま。
   */
  reloadKey?: number;
  /** 「プレビューを再読み込み」ボタン押下ハンドラ。 */
  onReloadPreview: () => void;
  /** 再生速度（JKL トランスポート。負＝逆再生・未指定＝等速）。 */
  playbackRate?: number;
}

/** カット適用済みプレビュー。@remotion/player を埋め込み、上に直接ドラッグ用オーバーレイを重ねる。 */
export const Preview = forwardRef<PlayerRef, PreviewProps>(function Preview(
  { model, telop, insertImage, insertVideo, allowInsertVideoFallback, videoUrl, hasVideo, projectId, seLibrary, imageLibrary, videoLibrary, bgmLibrary, assetVersions, state, onLive, onEdit, drawingKind, onDrawingKindChange, reloadKey, onReloadPreview, playbackRate },
  ref,
) {
  // Remotion の Player は Props extends Record<string, unknown> を要求するが、
  // EditorCompositionInputProps は関数引数の反変性により直接代入不可。
  // ここではキャストで型制約を満たし、inputProps との整合は useMemo<EditorCompositionInputProps> で保証する。
  const Composition = useMemo(
    () => makeEditorComposition(telop, insertImage, insertVideo, allowInsertVideoFallback) as unknown as ComponentType<Record<string, unknown>>,
    [telop, insertImage, insertVideo, allowInsertVideoFallback],
  );
  // 実体のある効果音だけを合成へ渡す（欠落ファイルは Remotion 再生エラーになるため除外）。
  const se = useMemo<SeAudioInput[]>(
    () =>
      model.se
        .filter((s) => seLibrary.includes(s.file))
        .map((s) => ({
          id: s.id,
          playbackFrame: s.playbackFrame,
          playbackEnd: s.playbackEnd,
          volume: s.volume,
          fadeInFrames: s.fadeInFrames,
          fadeOutFrames: s.fadeOutFrames,
          audioUrl: assetUrl(projectId, assetPathFor('se', s.file), assetVersions),
        })),
    [model.se, seLibrary, projectId, assetVersions],
  );
  // 実体のある画像だけを合成へ渡す（欠落ファイルは Remotion 再生エラーになるため除外）。
  const images = useMemo<ImageInput[]>(
    () =>
      model.images
        .filter((i) => imageLibrary.includes(i.file))
        .map((i) => ({
          id: i.id,
          playbackStart: i.playbackStart,
          playbackEnd: i.playbackEnd,
          file: i.file,
          type: i.type,
          scale: i.scale,
          position: i.position,
          opacity: i.opacity,
          rotation: i.rotation,
          enter: i.enter,
          exit: i.exit,
          imageUrl: assetUrl(projectId, assetPathFor('image', i.file), assetVersions),
        })),
    [model.images, imageLibrary, projectId, assetVersions],
  );
  const videoInserts = useMemo<VideoInsertInput[]>(
    () =>
      model.videoInserts
        .filter((v) => videoLibrary.includes(v.file))
        .map((v) => ({
          id: v.id,
          playbackStart: v.playbackStart,
          playbackEnd: v.playbackEnd,
          file: v.file,
          sourceInFrame: v.sourceInFrame,
          position: v.position,
          scale: v.scale,
          enter: v.enter,
          exit: v.exit,
          playbackRate: v.playbackRate,
          videoUrl: assetUrl(projectId, assetPathFor('video', v.file), assetVersions),
        })),
    [model.videoInserts, videoLibrary, projectId, assetVersions],
  );
  // 実体のある BGM クリップだけを合成へ渡す（欠落ファイルは Remotion 再生エラーになるため除外）。
  const bgm = useMemo<BgmInput[]>(
    () =>
      model.bgm
        .filter((c) => bgmLibrary.includes(c.file))
        .map((c) => ({
          id: c.id,
          startFrame: c.startFrame,
          endFrame: c.endFrame,
          file: c.file,
          volume: c.volume,
          fadeInFrames: c.fadeInFrames,
          fadeOutFrames: c.fadeOutFrames,
          ducking: c.ducking,
          bgmUrl: assetUrl(projectId, assetPathFor('bgm', c.file), assetVersions),
        })),
    [model.bgm, bgmLibrary, projectId, assetVersions],
  );
  const shapes = useMemo<ShapeInput[]>(
    () =>
      (model.shapes ?? []).map((s) => ({
        id: s.id,
        playbackStart: s.startFrame,
        playbackEnd: s.endFrame,
        kind: s.kind,
        x1: s.x1,
        y1: s.y1,
        x2: s.x2,
        y2: s.y2,
        color: s.color,
        thickness: s.thickness,
        opacity: s.opacity,
      })),
    [model.shapes],
  );
  const inputProps = useMemo<EditorCompositionInputProps>(
    () => ({
      videoUrl, hasVideo, keptSegments: model.keptSegments, telops: model.telops, se, images, videoInserts, bgm,
      titles: model.titles, titleStyle: model.titleStyle, shapes, sceneTransitions: model.sceneTransitions,
      joins: model.joins, overlaps: model.overlaps, mainSpeed: model.mainSpeed,
      segmentRates: model.speedSegments
        ? Object.fromEntries(model.speedSegments.map((s) => [s.id, s.rate]))
        : undefined,
      mainLayout: state.mainLayout,
      segmentLayouts: state.segmentLayouts,
      layoutKeyframes: state.layoutKeyframes,
    }),
    [videoUrl, hasVideo, model.keptSegments, model.telops, se, images, videoInserts, bgm, model.titles, model.titleStyle, shapes, model.sceneTransitions, model.joins, model.overlaps, model.mainSpeed, model.speedSegments, state.mainLayout, state.segmentLayouts, state.layoutKeyframes],
  );
  const seconds = model.fps > 0 ? model.durationInFrames / model.fps : 0;

  return (
    <div className="pv">
      <div className="pv-stage">
        <Player
          key={reloadKey ?? 0}
          ref={ref}
          component={Composition}
          inputProps={inputProps}
          durationInFrames={model.durationInFrames}
          fps={model.fps}
          compositionWidth={model.width}
          compositionHeight={model.height}
          playbackRate={playbackRate ?? 1}
          controls
          style={{ width: '100%', height: '100%' }}
        />
        <PreviewOverlay
          compWidth={model.width}
          compHeight={model.height}
          state={state}
          onLive={onLive}
          onEdit={onEdit}
          playerRef={ref as RefObject<PlayerRef | null>}
          drawingKind={drawingKind}
          mainSpeed={model.mainSpeed}
          speedSegments={model.speedSegments}
          playbackOverlaps={model.playbackOverlaps}
        />
        <ShapeToolbar active drawingKind={drawingKind ?? null} onDrawingKindChange={onDrawingKindChange} />
      </div>
      <div className="pv-foot">
        <span className="pv-foot-info">
          <span>{model.width}×{model.height}</span>
          <span>{formatClock(seconds)}</span>
        </span>
        <button
          type="button"
          className="pv-reload-btn"
          title="プレビューが黒くなった・止まった時に（編集内容は失われません）"
          aria-label="プレビューを再読み込み"
          onClick={onReloadPreview}
        >
          ⟳ 再読み込み
        </button>
      </div>
    </div>
  );
});
