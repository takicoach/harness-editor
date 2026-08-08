import React from 'react';
import { AbsoluteFill, Audio, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { TransitionSeries } from '@remotion/transitions';
import { activeTelopsAt } from './playbackModel';
import { telopTransform, telopScaleOriginY } from './telopLayout';
import { sampleMotion, motionProgress } from '../core/motion';
import { bgmFadeVolume } from '../core/bgmFade';
import { duckFactorAt } from '../core/ducking';
import { overlayColorFor, joinOverlayOpacityAt, edgeOverlayOpacityAt } from '../core/transitionStyle';
import { playbackToFinal, type PlaybackOverlap } from '../core/transitionEngine';
import { presentationFor, timingFor } from '../core/transitionPresentation';
import { buildTransitionSeriesChildren } from './transitionSeriesChildren';
import type { Join } from '../core/joinEngine';
import type { TelopComponent } from './loadTelopComponent';
import type { InsertImageComponent } from './loadInsertImageComponent';
import type { InsertVideoComponent } from './loadInsertVideoComponent';
import { InsertVideo as BundledInsertVideo } from '../server/videoInsertPayload/InsertVideo';
import type { VideoInsert as BundledVideoInsert } from '../server/videoInsertPayload/types';
import { InsertShape } from '../shapePayload/InsertShape';
import { TitleLayer } from './TitleLayer';
import type { BgmClip, CutSegment, ElementAnim, ImageSegment, ImageType, MainLayout, SceneTransition, SegmentLayout, ShapeKind, ShapeThickness, TelopPosition, TelopSegment, TitleSegment, TitleStyle, VideoInsert } from '../core/types';
import { DEFAULT_MAIN_LAYOUT, isIdentityMainLayout, mainLayoutTransform } from '../core/mainLayout';
import { effectiveLayoutAt } from '../core/segmentLayout';
import type { LayoutKeyframe } from '../core/layoutKeyframes';

/**
 * カット区間の境界で次区間のベース動画を先読みするフレーム数。
 * プレビューの @remotion/player では OffthreadVideo が通常の <video> 要素として動くため、
 * 区間境界で次の Sequence がマウント→別位置へシークし、完了までの一瞬だけ背景の黒が透けて
 * 「チカッ」と暗くなる。premountFor で境界より手前から次区間を不可視・無音でマウントし、
 * シーク完了済みの状態で表示へ切り替えることでチラつきを消す。
 * 60fps で 0.5 秒・30fps で 1 秒の先読みに相当（シーク+デコードの猶予として十分）。
 * 注: 最終書き出しは frame ごとに OffthreadVideo がフレーム抽出するためチラつかず、ここは
 * プレビュー専用の体感改善。
 */
const SEGMENT_PREMOUNT_FRAMES = 30;

// buildTransitionSeriesChildren と関連型は transitionSeriesChildren.ts へ切り出し済み。
// @remotion/transitions を import しない純関数ファイルとすることでユニットテストの
// Remotion バージョン衝突エラーを防ぐ。
export { buildTransitionSeriesChildren } from './transitionSeriesChildren';
export type { TSCItem, TSCSequenceItem, TSCTransitionItem } from './transitionSeriesChildren';

/**
 * 合成へ渡す 1 つの挿入画像（URL 解決済み・プレーンデータ）。
 * file は ハーネス上流のオリジナルファイル名（例: 'photo.png' や 'gen/info.png'）。
 * imageUrl はエディタプレビュー用の解決済み API URL（`/api/asset?id=…&path=images/…`）。
 * プロジェクトの InsertImage.tsx は `segment.imageUrl ?? staticFile('images/' + segment.file)`
 * のように imageUrl を優先しつつ staticFile へフォールバックすると、エディタプレビューと
 * 最終 Remotion render の両方で正しく描画される。
 */
export interface ImageInput {
  id: number;
  playbackStart: number;
  playbackEnd: number;
  /** ハーネス上流の元ファイル名（最終 render の staticFile 用）。 */
  file: string;
  /** エディタプレビュー用の解決済み URL（`/api/asset?…`）。 */
  imageUrl: string;
  type: ImageType;
  scale: number;
  /** 中心からの正規化オフセット（未指定＝中央）。サブ動画と同じ意味論。 */
  position?: TelopPosition;
  /** ユーザー不透明度（未指定＝1）。 */
  opacity?: number;
  /** ユーザー回転角（度、未指定＝0）。 */
  rotation?: number;
  /** 登場アニメ（未指定＝InsertImage の既定 fade）。 */
  enter?: ElementAnim;
  /** 退場アニメ（未指定＝InsertImage の既定 fade）。 */
  exit?: ElementAnim;
}

/**
 * 合成へ渡す 1 つのサブ動画（URL 解決済み・プレーンデータ）。
 * file は ハーネス上流のオリジナルファイル名（最終 render の staticFile 用）。
 * videoUrl はエディタプレビュー用の解決済み API URL（`/api/asset?…`）。
 */
export interface VideoInsertInput {
  id: number;
  playbackStart: number;
  playbackEnd: number;
  /** ハーネス上流の元ファイル名（最終 render の staticFile 用）。public/ 相対。 */
  file: string;
  /** エディタプレビュー用の解決済み URL（`/api/asset?…`）。 */
  videoUrl: string;
  sourceInFrame: number;
  position?: TelopPosition;
  scale: number;
  /** 登場アニメ（未指定＝InsertVideo の既定 none）。 */
  enter?: ElementAnim;
  /** 退場アニメ（未指定＝InsertVideo の既定 none）。 */
  exit?: ElementAnim;
  /** 再生速度（倍率・未指定＝1.0）。 */
  playbackRate?: number;
}

/**
 * 合成へ渡す 1 つの図形オーバーレイ（再生フレーム基準・プレーンデータ）。
 * ShapeSequence/InsertShape と同じスキーマ（staticFile/node:vm 非依存・外部アセット不要）。
 */
export interface ShapeInput {
  id: number;
  playbackStart: number;
  playbackEnd: number;
  kind: ShapeKind;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  thickness: ShapeThickness;
  /** 不透明度（0..1、未指定＝1）。 */
  opacity?: number;
}

/**
 * 合成へ渡す 1 つの BGM クリップ（URL 解決済み・プレーンデータ）。
 * bgmUrl はエディタプレビュー用の解決済み API URL（`/api/asset?id=…&path=BGM/…`）。
 * bgmUrl が無い場合は staticFile(`BGM/<file>`) へフォールバックする。
 */
export interface BgmInput extends BgmClip {
  bgmUrl?: string;
}

/** 合成へ渡す 1 つの効果音（URL 解決済み・プレーンデータ）。 */
export interface SeAudioInput {
  id: number;
  playbackFrame: number;
  /** 区間終端フレーム。区間長 = playbackEnd - playbackFrame。 */
  playbackEnd: number;
  audioUrl: string;
  volume: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

/** @remotion/player へ inputProps として渡す（プレーンデータのみ）。 */
export interface EditorCompositionInputProps {
  videoUrl: string;
  hasVideo: boolean;
  keptSegments: CutSegment[];
  telops: TelopSegment[];
  se: SeAudioInput[];
  /** 再生タイムラインへ射影済みの挿入画像（実体のあるファイルのみ）。 */
  images: ImageInput[];
  /** 再生タイムラインへ射影済みのサブ動画（Task 6 で App/Preview が populate するまで任意）。 */
  videoInserts?: VideoInsertInput[];
  /** 再生タイムラインへ射影済みの BGM クリップ（URL 解決済み）。 */
  bgm?: BgmInput[];
  /** 再生タイムラインへ射影済みのタイトル。 */
  titles?: TitleSegment[];
  /** タイトル帯の標準スタイル（位置・フォント忠実描画用）。未指定時は TitleLayer 側で解像度から既定値を導く。 */
  titleStyle?: TitleStyle;
  /** 再生タイムラインへ射影済みの図形オーバーレイ。外部アセット不要（SVG 描画）。 */
  shapes?: ShapeInput[];
  /** シーン転換リスト（at は原本フレーム）。SceneOverlayLayer で使用。 */
  sceneTransitions?: SceneTransition[];
  /** computeJoins の結果（atOriginal→playbackFrame 対応表）。SceneOverlayLayer で使用。 */
  joins?: Join[];
  /**
   * 重なる系トランジションのオーバーラップ情報（Task 6 で Preview が渡す）。
   * 空配列または未指定のとき TransitionSeries は Transition を 1 つも挟まず、
   * 従来の keptSegments map と同一描画になる（後方互換）。
   */
  overlaps?: PlaybackOverlap[];
  /**
   * メイン動画速度（倍率・未指定＝1）。ベース動画を `playbackRate={mainSpeed}` で再生する。
   * mainSpeed!==1 のときは `endAt` を外す（endAt は playbackRate で割られず途中で透明化するため。
   * 表示窓は Sequence の durationInFrames＝スケール済み尺が規定する）。
   */
  mainSpeed?: number;
  /** 区間 id → 実効倍率（区間ごと速度・未指定＝全区間 mainSpeed）。 */
  segmentRates?: Record<number, number>;
  /** メイン動画の自由レイアウト（全区間共通・未指定＝全画面）。ベース動画のみに transform を掛ける。 */
  mainLayout?: MainLayout;
  /** 区間 id → 個別レイアウト上書き（未指定＝全区間 mainLayout をそのまま使う）。 */
  segmentLayouts?: Record<number, SegmentLayout>;
  /** メイン動画の大域キーフレーム列（原本フレームアンカー・2 点以上でカット非依存の連続補間を駆動）。 */
  layoutKeyframes?: LayoutKeyframe[];
}

/** 区間 id の実効再生レート（segmentRates にあればそれ、無ければ mainSpeed）。 */
export function segmentPlaybackRate(
  id: number,
  segmentRates: Record<number, number> | undefined,
  mainSpeed: number,
): number {
  return segmentRates?.[id] ?? mainSpeed;
}

function TelopLayer({ Telop, telops }: { Telop: TelopComponent; telops: TelopSegment[] }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  // 現在フレームで表示中のテロップを「全件」描く。字幕は重ならないので通常 1 件だが、
  // 装飾テロップ（旧タイトル含む）は字幕と重なって同時表示されうる。1 件だけ描くと
  // 長尺の装飾が字幕の表示中に消えてしまう（書き出しの TelopPlayer も同様に全件描画）。
  const active = activeTelopsAt(telops, frame);
  if (active.length === 0) return null;
  return (
    <>
      {active.map((current) => {
        // position / scale はラッパーの transform で適用する（フォーマット連動・下端基準で拡縮）。
        // テロップ部品（パックのアダプタ等）も position/scale/motion を読んで自分で適用しうるため、
        // 二重適用を避けて segment からは外して渡す（プレビュー＝最終 render 一致）。
        // motion があるフレームは補間した位置/スケール/不透明度を使う（2点アニメ）。
        const sampled = sampleMotion(
          current.motion,
          {
            x: current.position?.x ?? 0,
            y: current.position?.y ?? 0,
            scale: current.scale ?? 1,
            opacity: 1,
            rotation: 0,
          },
          motionProgress(frame, current.startFrame, current.endFrame),
        );
        const pos = sampled.x !== 0 || sampled.y !== 0 ? { x: sampled.x, y: sampled.y } : undefined;
        const transform = telopTransform(pos, sampled.scale, width, height);
        const segmentForStyle: TelopSegment = {
          ...current, position: undefined, scale: undefined, motion: undefined,
        };
        const style = transform !== undefined || sampled.opacity !== 1
          ? {
              transform,
              transformOrigin: `50% ${telopScaleOriginY(width, height)}%`,
              ...(sampled.opacity !== 1 ? { opacity: sampled.opacity } : {}),
            }
          : undefined;
        return (
          <AbsoluteFill key={current.id} style={style}>
            <Telop segment={segmentForStyle} />
          </AbsoluteFill>
        );
      })}
    </>
  );
}

function InsertImageLayer({
  InsertImage,
  images,
}: {
  InsertImage: InsertImageComponent;
  images: ImageInput[];
}) {
  return (
    <>
      {images
        // Codex P2 指摘: カットへ完全に飲まれた画像は playbackStart === playbackEnd の縮退区間で
        // 来うる。`Math.max(1, ...)` で 1 フレーム描いてしまうとカット済みの画像が一瞬チラつくため、
        // 0 以下長は描かない（保存出力が縮退している＝不可視という意味論を保つ）。
        .filter((i) => i.playbackEnd > i.playbackStart)
        .map((i) => {
        // プロジェクト側 ImageSegment 互換のプレーンデータを渡す。
        // file は元ファイル名のまま（最終 render 互換）、imageUrl は解決済み URL を別フィールドで
        // 注入する。InsertImage.tsx は `segment.imageUrl ?? staticFile('images/' + segment.file)`
        // で imageUrl 優先・staticFile フォールバックする想定（spec §7.2・フィクスチャ参照）。
        const segment: ImageSegment & { imageUrl: string } = {
          id: i.id,
          startFrame: i.playbackStart,
          endFrame: i.playbackEnd,
          file: i.file,
          type: i.type,
          position: i.position,
          scale: i.scale,
          opacity: i.opacity,
          rotation: i.rotation,
          enter: i.enter,
          exit: i.exit,
          imageUrl: i.imageUrl,
        };
        const duration = i.playbackEnd - i.playbackStart;
        return (
          <Sequence key={i.id} from={i.playbackStart} durationInFrames={duration}>
            <InsertImage segment={segment} />
          </Sequence>
        );
      })}
    </>
  );
}

/**
 * サブ動画未導入プロジェクト用のフォールバック部品。
 *
 * プロジェクトに `src/InsertVideo/InsertVideo.tsx` が無いと `useEditorProject` は
 * console.warn だけして `insertVideo=null` で続行する。従来はそのままサブ動画レイヤを
 * 描かなかったため、タイムラインにクリップと選択枠だけが出て「メイン動画の背面に
 * 隠れている」と誤認された（2026-08-08 報告）。実際のレイヤ順は設計どおりで、
 * 描画自体が黙殺されていた。
 *
 * ここではエディタ同梱の `videoInsertPayload/InsertVideo`（プロジェクトへコピーされる
 * 部品そのもの）で代替描画する。図形レイヤが `shapePayload/InsertShape` を直接 import
 * しているのと同型。**書き出しには入らない**ので `VideoInsertInstallBanner` の警告は残す。
 */
export const FALLBACK_INSERT_VIDEO: InsertVideoComponent = ({ segment }) => (
  // InsertVideoComponent の segment は unknown（プロジェクト側の型が未知のため）。
  // 同梱部品へ渡す時だけ payload の VideoInsert として解釈する（VideoInsertLayer が
  // core/types の VideoInsert 形で構築しており、payload 側と構造は同一）。
  <BundledInsertVideo segment={segment as BundledVideoInsert} />
);

function VideoInsertLayer({
  InsertVideo,
  videoInserts,
}: {
  InsertVideo: InsertVideoComponent;
  videoInserts: VideoInsertInput[];
}) {
  return (
    <>
      {videoInserts
        // InsertImageLayer と同じく縮退区間（飲まれたクリップ）は描かない。
        .filter((v) => v.playbackEnd > v.playbackStart)
        .map((v) => {
          // InsertImageLayer の `ImageSegment & { imageUrl }` と対称に型注釈を付ける
          // （VideoInsert スキーマにフィールドが増えた時の渡し漏れを静的検出する）。
          const segment: VideoInsert & { videoUrl: string } = {
            id: v.id,
            startFrame: v.playbackStart,
            endFrame: v.playbackEnd,
            file: v.file,
            sourceInFrame: v.sourceInFrame,
            position: v.position,
            scale: v.scale,
            enter: v.enter,
            exit: v.exit,
            playbackRate: v.playbackRate,
            videoUrl: v.videoUrl,
          };
          const duration = v.playbackEnd - v.playbackStart;
          return (
            <Sequence key={v.id} from={v.playbackStart} durationInFrames={duration}>
              <InsertVideo segment={segment} />
            </Sequence>
          );
        })}
    </>
  );
}

function ShapeLayer({ shapes }: { shapes: ShapeInput[] }) {
  const { width, height } = useVideoConfig();
  return (
    <>
      {shapes
        // InsertImageLayer と同じく縮退区間（飲まれた図形）は描かない。
        .filter((s) => s.playbackEnd > s.playbackStart)
        .map((s) => {
          // shapePayload/InsertShape.tsx が受け取る ShapeSegment と互換のプレーンデータ。
          // startFrame/endFrame は Sequence の from/durationInFrames で制御するため
          // Sequence 内での useCurrentFrame() が 0 起点になる。
          const shapeSegment = {
            id: s.id,
            startFrame: 0,
            endFrame: s.playbackEnd - s.playbackStart,
            kind: s.kind,
            x1: s.x1,
            y1: s.y1,
            x2: s.x2,
            y2: s.y2,
            color: s.color,
            thickness: s.thickness,
            opacity: s.opacity,
          };
          const duration = s.playbackEnd - s.playbackStart;
          return (
            <Sequence key={s.id} from={s.playbackStart} durationInFrames={duration}>
              {/* エディタでは fade を切り、描いた図形を即不透明で見せる（書き出しは fade あり）。 */}
              <InsertShape shape={shapeSegment} width={width} height={height} disableFade />
            </Sequence>
          );
        })}
    </>
  );
}

function BgmLayer({ bgm }: { bgm: BgmInput[] }) {
  return (
    <>
      {bgm.map((c) => {
        const duration = c.endFrame - c.startFrame;
        if (duration <= 0) return null;
        return (
          <Sequence key={c.id} from={c.startFrame} durationInFrames={duration}>
            <Audio
              src={c.bgmUrl ?? staticFile(`BGM/${c.file}`)}
              volume={(f) => bgmFadeVolume(f, duration, c.volume, c.fadeInFrames, c.fadeOutFrames) * duckFactorAt(f, c.ducking)}
              loop
            />
          </Sequence>
        );
      })}
    </>
  );
}

/**
 * メイン動画レイアウトのフレーム対応ラッパー。現フレームが属する区間の実効レイアウト
 * （区間ごとの個別指定があればそれ、無ければ全体 base）を effectiveLayoutAt で解決し、
 * 恒等（isIdentityMainLayout）なら children をそのまま返す（後方互換・passthrough）。
 * 重なる系トランジション中（hasOverlap）は区間指定を無視し全体 base を使う（Plan 3 まで非対応）。
 */
const MainVideoLayoutFrame: React.FC<{
  keptSegments: CutSegment[];
  base: MainLayout;
  segmentLayouts: Record<number, SegmentLayout>;
  hasOverlap: boolean;
  layoutKeyframes: LayoutKeyframe[];
  children: React.ReactNode;
}> = ({ keptSegments, base, segmentLayouts, hasOverlap, layoutKeyframes, children }) => {
  const frame = useCurrentFrame();
  const layout = effectiveLayoutAt(frame, keptSegments, base, segmentLayouts, hasOverlap, layoutKeyframes);
  if (isIdentityMainLayout(layout)) return <>{children}</>;
  return (
    <AbsoluteFill style={{ backgroundColor: layout.background }}>
      <AbsoluteFill style={{ transform: mainLayoutTransform(layout), transformOrigin: 'center' }}>
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/**
 * シーン転換オーバーレイレイヤ。fade 系のみ描画。最上位に重ねる（テロップ・タイトルより後）。
 * at=number のつなぎ目は joins で playbackFrame へ解決する。null color（重なる系）は描かない。
 *
 * overlaps が渡されたとき、join の中心フレームを `playbackToFinal(join.playbackFrame, overlaps)`
 * で最終尺へ補正する（重なる系が再生尺を縮めた分だけ前へシフト）。
 * head/tail の edgeOverlayOpacityAt は durationInFrames（=最終尺・useVideoConfig）基準なので補正不要。
 */
function SceneOverlayLayer({
  sceneTransitions,
  joins,
  overlaps = [],
}: {
  sceneTransitions: SceneTransition[];
  joins: Join[];
  overlaps?: PlaybackOverlap[];
}) {
  const { durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  return (
    <>
      {sceneTransitions.map((t) => {
        const color = overlayColorFor(t.kind, t.color);
        if (color === null) return null; // crossfade/slide/wipe は TransitionSeries が担当
        let opacity = 0;
        if (t.at === 'head') {
          opacity = edgeOverlayOpacityAt(frame, 'head', durationInFrames, t.durationFrames);
        } else if (t.at === 'tail') {
          opacity = edgeOverlayOpacityAt(frame, 'tail', durationInFrames, t.durationFrames);
        } else {
          const join = joins.find((j) => j.atOriginal === t.at);
          if (join === undefined) return null;
          // 重なる系が再生尺を縮めているとき、fade オーバーレイの中心フレームを最終尺へ補正する。
          const finalCenter = playbackToFinal(join.playbackFrame, overlaps);
          opacity = joinOverlayOpacityAt(frame, finalCenter, t.durationFrames);
        }
        if (opacity <= 0) return null;
        return <AbsoluteFill key={t.id} style={{ backgroundColor: color, opacity, pointerEvents: 'none' }} />;
      })}
    </>
  );
}

/**
 * Telop 部品と InsertImage 部品を閉じ込めた合成コンポーネントを生成する。
 * 部品を inputProps ではなくクロージャで渡すことで、Player の inputProps は
 * プレーンデータだけになり型・直列化の制約に触れない。
 *
 * InsertImage が null の場合（プロジェクトに InsertImage.tsx が無い）は
 * 画像レイヤを描かない（graceful）。
 *
 * InsertVideo が null の場合（サブ動画未導入）は描画を諦めず、エディタ同梱の
 * FALLBACK_INSERT_VIDEO で代替描画する（プレビューでは見える／書き出しには入らない）。
 *
 * この合成はエディタの @remotion/player プレビュー専用。最終書き出しは
 * 従来どおりプロジェクト本体の MainVideo.tsx を `remotion render` するため、
 * hasVideo=false 時の注意表示が動画へ焼き込まれることはない。
 */
export function makeEditorComposition(
  Telop: TelopComponent,
  InsertImage: InsertImageComponent | null,
  InsertVideo: InsertVideoComponent | null = null,
  /**
   * `InsertVideo` が null のとき同梱部品で代替描画してよいか。
   * **未導入プロジェクトのときだけ true**。導入済みなのに読み込みへ失敗した場合に
   * 代替描画すると「プレビューには映るのに書き出しは壊れている」乖離を、
   * 未導入バナーも出ない状態で隠してしまう（導入済みなのでバナーは出ない）。
   */
  allowFallback = false,
) {
  // 実際に使うサブ動画部品。null なら描かない（＝導入済み×読込失敗）。
  const resolvedInsertVideo: InsertVideoComponent | null =
    InsertVideo ?? (allowFallback ? FALLBACK_INSERT_VIDEO : null);

  return function EditorComposition({
    videoUrl,
    hasVideo,
    keptSegments,
    telops,
    se,
    images,
    videoInserts = [],
    bgm = [],
    titles = [],
    titleStyle,
    shapes = [],
    sceneTransitions = [],
    joins = [],
    overlaps = [],
    mainSpeed = 1,
    segmentRates,
    mainLayout = DEFAULT_MAIN_LAYOUT,
    segmentLayouts = {},
    layoutKeyframes = [],
  }: EditorCompositionInputProps) {
    // TransitionSeries の子要素記述子を組む（純関数・テスト済み）。
    // overlaps 空のとき Transition は 1 つも含まれず、TransitionSeries は
    // 連続 Sequence を前詰め描画＝従来の keptSegments map と同一挙動（後方互換）。
    const tscItems = buildTransitionSeriesChildren(keptSegments, sceneTransitions, joins);
    // overlaps がある（重なる系転換が 1 つ以上ある）かどうか。
    const hasOverlap = overlaps.length > 0;

    // メイン動画（ベース）出力。内容は従来どおり（hasOverlap で TransitionSeries/keptSegments map を出し分け）。
    const mainVideoContent = hasVideo ? (
      hasOverlap ? (
        // 重なる系あり: TransitionSeries でベース動画を描く。
        // TransitionSeries 自体が時間管理を行うため、外側の Sequence は不要。
        // premountFor は TransitionSeries.Sequence が未対応のため省略
        // （プレビューのチラつき対策は失われるが機能への影響はなし）。
        <TransitionSeries>
          {tscItems.map((item, idx) => {
            if (item.type === 'transition') {
              const pres = presentationFor(item.kind, item.direction);
              if (pres === null) return null;
              return (
                <TransitionSeries.Transition
                  key={`tr-${idx}`}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  presentation={pres as any}
                  timing={timingFor(item.overlap)}
                />
              );
            }
            const seg = item.seg;
            const dur = Math.max(1, seg.playbackEnd - seg.playbackStart);
            const segRate = segmentPlaybackRate(seg.id, segmentRates, mainSpeed);
            return (
              <TransitionSeries.Sequence key={seg.id} durationInFrames={dur}>
                <OffthreadVideo
                  src={videoUrl}
                  startFrom={seg.originalStart}
                  {...(segRate === 1 ? { endAt: seg.originalEnd } : { playbackRate: segRate })}
                />
              </TransitionSeries.Sequence>
            );
          })}
        </TransitionSeries>
      ) : (
        // 重なる系なし: 従来の keptSegments map（premountFor あり・後方互換）。
        keptSegments.map((seg) => {
          const segRate = segmentPlaybackRate(seg.id, segmentRates, mainSpeed);
          return (
            <Sequence
              key={seg.id}
              from={seg.playbackStart}
              durationInFrames={Math.max(1, seg.playbackEnd - seg.playbackStart)}
              premountFor={SEGMENT_PREMOUNT_FRAMES}
            >
              <OffthreadVideo
                src={videoUrl}
                startFrom={seg.originalStart}
                {...(segRate === 1 ? { endAt: seg.originalEnd } : { playbackRate: segRate })}
              />
            </Sequence>
          );
        })
      )
    ) : (
      <AbsoluteFill
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#8A8F96',
          fontSize: 28,
          textAlign: 'center',
          padding: 40,
        }}
      >
        動画ファイルが見つかりません（public/ に動画を配置してください）
      </AbsoluteFill>
    );
    return (
      <AbsoluteFill style={{ backgroundColor: 'black' }}>
        <MainVideoLayoutFrame keptSegments={keptSegments} base={mainLayout} segmentLayouts={segmentLayouts} hasOverlap={hasOverlap} layoutKeyframes={layoutKeyframes}>
          {mainVideoContent}
        </MainVideoLayoutFrame>
        {/* 画像レイヤ（テロップの下に描く）。InsertImage.tsx が無いプロジェクトでは描かない（graceful）。 */}
        {InsertImage !== null && <InsertImageLayer InsertImage={InsertImage} images={images} />}
        {/* サブ動画レイヤ（画像の上・テロップの下）。
            未導入プロジェクト（allowFallback）はエディタ同梱の FALLBACK_INSERT_VIDEO で
            代替描画する＝プレビューでは必ず見える（書き出しへは入らないので
            VideoInsertInstallBanner が警告を出し続ける）。
            導入済みなのに読み込みへ失敗した場合は代替せず描かない＝従来どおり graceful。
            そのケースは useEditorProject が警告として表に出す。 */}
        {resolvedInsertVideo !== null && (
          <VideoInsertLayer InsertVideo={resolvedInsertVideo} videoInserts={videoInserts} />
        )}
        {/* 図形レイヤ（サブ動画の上・テロップの下）。SVG ベクター描画・外部アセット不要。 */}
        {shapes.length > 0 && <ShapeLayer shapes={shapes} />}
        <TelopLayer Telop={Telop} telops={telops} />
        {/* タイトル */}
        <TitleLayer titles={titles} titleStyle={titleStyle} />
        {/* シーン転換オーバーレイ（最上位＝テロップ・タイトルより後）。fade 系のみ描画。 */}
        {sceneTransitions.length > 0 && (
          <SceneOverlayLayer sceneTransitions={sceneTransitions} joins={joins} overlaps={overlaps} />
        )}
        {/* BGM レイヤ（SE と同様・音声のみ・視覚レイヤ順は無関係）。 */}
        {bgm.length > 0 && <BgmLayer bgm={bgm} />}
        {/* 効果音。ハーネス形式の SESequence と同じく区間長で鳴らす（ループしない）。 */}
        {se.map((s) => {
          const duration = Math.max(1, s.playbackEnd - s.playbackFrame);
          const base = s.volume ?? 1;
          const fadeIn = s.fadeInFrames ?? 0;
          const fadeOut = s.fadeOutFrames ?? 0;
          const hasFade = fadeIn > 0 || fadeOut > 0;
          return (
            <Sequence key={s.id} from={s.playbackFrame} durationInFrames={duration}>
              <Audio
                src={s.audioUrl}
                volume={hasFade ? (f) => bgmFadeVolume(f, duration, base, fadeIn, fadeOut) : base}
              />
            </Sequence>
          );
        })}
      </AbsoluteFill>
    );
  };
}
