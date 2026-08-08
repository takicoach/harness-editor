import { applyCuts, playbackTotalFrames } from '../core/cutEngine';
import { projectTelops } from '../core/telopEngine';
import { projectTitles } from '../core/titleEngine';
import { clampSe, projectSe } from '../core/seAnchor';
import { clampImages, projectImages } from '../core/imageEngine';
import { clampVideoInserts, projectVideoInserts } from '../core/videoInsertEngine';
import { clampBgm, projectBgm } from '../core/bgmEngine';
import { clampShapes, projectShapes } from '../core/shapeEngine';
import { applyDuckingToBgm } from '../core/ducking';
import { computeJoins, resolveSceneTransitions } from '../core/joinEngine';
import type { Join } from '../core/joinEngine';
import { buildOverlaps, finalTotalFrames } from '../core/transitionEngine';
import type { PlaybackOverlap } from '../core/transitionEngine';
import { speedScale, hasPerSegmentSpeed, resolveSpeedSegments, playbackToSpeed, speedTotalFrames } from '../core/speedEngine';
import type { SpeedSegment } from '../core/speedEngine';
import { collapseTelops, collapseTitles, collapseSe, collapseImages, collapseVideoInserts, collapseBgm, collapseShapes } from '../core/sceneCollapse';
import type { BgmClip, CutSegment, EditorProject, ElementAnim, ImageType, SceneTransition, ShapeSegment, TelopPosition, TelopSegment, TitleSegment, TitleStyle } from '../core/types';

/** プレビューで描く 1 つの挿入画像（カット適用済み）。 */
export interface ImagePlayback {
  id: number;
  /** カット適用後（再生）の開始フレーム。 */
  playbackStart: number;
  /** カット適用後（再生）の終了フレーム（排他的）。 */
  playbackEnd: number;
  file: string;
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

/** プレビューで描く 1 つのサブ動画（カット適用済み）。 */
export interface VideoInsertPlayback {
  id: number;
  /** カット適用後（再生）の開始フレーム。 */
  playbackStart: number;
  /** カット適用後（再生）の終了フレーム（排他的）。 */
  playbackEnd: number;
  file: string;
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

/** プレビューで鳴らす 1 つの効果音（カット適用済み）。 */
export interface SePlayback {
  id: number;
  /** カット適用後（再生）の開始フレーム。 */
  playbackFrame: number;
  /** カット適用後（再生）の終端フレーム。区間長 = playbackEnd - playbackFrame。 */
  playbackEnd: number;
  file: string;
  volume: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

/** プレビュー（@remotion/player）に渡す、カット適用済みの再生モデル。 */
export interface PlaybackModel {
  fps: number;
  width: number;
  height: number;
  /** トランジション重なり適用後の最終総フレーム数（最低 1）。重なりなしなら playbackDurationInFrames と同値。 */
  durationInFrames: number;
  /** 重なり前の再生総フレーム数（タイムライン定規・再生ヘッド変換用）。 */
  playbackDurationInFrames: number;
  /** 再生境界の重なり（重なる系トランジション・空なら最終=再生）。mainSpeed≠1 ではスケール済み。 */
  overlaps: PlaybackOverlap[];
  /**
   * 速度前（speedScale 前）の境界重なり。定規⇄プレイヤーの座標橋渡し専用。
   * mainSpeed で割らない（橋渡しは「再生座標」で行い、最後に speedScale を 1 段挟む）。
   */
  playbackOverlaps: PlaybackOverlap[];
  /** 残す（再生する）区間。動画を非破壊で詰めるための Sequence 情報。再生座標のまま（TransitionSeries が畳む）。 */
  keptSegments: CutSegment[];
  /** 再生タイムラインのフレームへ射影済みのテロップ。 */
  telops: TelopSegment[];
  /** 再生タイムラインへ射影済みのタイトル。 */
  titles: TitleSegment[];
  /** タイトル帯の標準スタイル（最終書き出しと一致する位置・フォント描画用）。 */
  titleStyle: TitleStyle;
  /** 再生タイムラインへ射影済みの効果音。 */
  se: SePlayback[];
  /** 再生タイムラインへ射影済みの挿入画像。 */
  images: ImagePlayback[];
  /** 再生タイムラインへ射影済みのサブ動画インサート。 */
  videoInserts: VideoInsertPlayback[];
  /** 再生タイムラインへ射影済みの BGM クリップ（縮退区間は除外済み）。 */
  bgm: BgmClip[];
  /** 再生タイムラインへ射影済みの図形オーバーレイ（縮退区間は除外済み）。 */
  shapes: ShapeSegment[];
  /** 透過 carry: プロジェクトの sceneTransitions（at は原本フレーム）。 */
  sceneTransitions: SceneTransition[];
  /** computeJoins の結果（atOriginal→playbackFrame 対応表）。SceneOverlayLayer で使用。 */
  joins: Join[];
  /** メイン動画 全体一律の速度（倍率・1.0=速度なし）。全フレーム量を 1/mainSpeed 倍へスケール済み。 */
  mainSpeed: number;
  /** 区間ごと速度の区間（速度前＝再生座標・null なら一律 mainSpeed）。橋渡しに使う。 */
  speedSegments: SpeedSegment[] | null;
}

/**
 * メイン動画速度をプレビューモデルへ適用する（フレームスケール方式）。
 *
 * Remotion では動画再生レートは `playbackRate` のみで決まり fps に非依存のため、
 * 「ベース動画 playbackRate=rate」＋「全フレーム量を 1/rate 倍へスケール」で表現する。
 * Player の fps は通常どおり model.fps を使い、durationInFrames とすべての要素位置を
 * speedScale(_, rate)=round(_/rate) で引き伸ばす（rate<1 なら尺が伸びる）。
 *
 * 不変（スケールしない）:
 * - playbackDurationInFrames（速度前の総尺・橋渡しの基準）
 * - playbackOverlaps（速度前 overlaps・橋渡し用）
 * - 各「キー」フィールド: keptSegments.originalStart/End（ソースフレーム）、
 *   joins.atOriginal、sceneTransitions.at
 *
 * rate===1 は同一参照を返す（無回帰＝バイト同値）。
 */
export function applyMainSpeed(model: PlaybackModel, rate: number): PlaybackModel {
  if (rate === 1) return model;
  const sc = (f: number): number => speedScale(f, rate);
  return {
    ...model,
    durationInFrames: Math.max(1, sc(model.durationInFrames)),
    // playbackDurationInFrames: 不変（速度前の総尺を保持）
    overlaps: model.overlaps.map((o) => ({ boundary: sc(o.boundary), overlap: sc(o.overlap) })),
    // playbackOverlaps: 不変（速度前のまま carry）
    keptSegments: model.keptSegments.map((s) => ({
      ...s,
      // originalStart/originalEnd は不変（ソースフレーム）。
      playbackStart: sc(s.playbackStart),
      playbackEnd: sc(s.playbackEnd),
    })),
    telops: model.telops.map((t) => ({ ...t, startFrame: sc(t.startFrame), endFrame: sc(t.endFrame) })),
    titles: model.titles.map((t) => ({ ...t, startFrame: sc(t.startFrame), endFrame: sc(t.endFrame) })),
    se: model.se.map((s) => ({ ...s, playbackFrame: sc(s.playbackFrame), playbackEnd: sc(s.playbackEnd) })),
    images: model.images.map((i) => ({ ...i, playbackStart: sc(i.playbackStart), playbackEnd: sc(i.playbackEnd) })),
    videoInserts: model.videoInserts.map((v) => ({
      ...v,
      playbackStart: sc(v.playbackStart),
      playbackEnd: sc(v.playbackEnd),
      // サブ動画も own×rate で追従（メイン速度に乗算）。
      playbackRate: (v.playbackRate ?? 1) * rate,
    })),
    bgm: model.bgm.map((c) => ({ ...c, startFrame: sc(c.startFrame), endFrame: sc(c.endFrame) })),
    shapes: model.shapes.map((s) => ({ ...s, startFrame: sc(s.startFrame), endFrame: sc(s.endFrame) })),
    // at は不変（原本/'head'/'tail' のキー）。durationFrames は常に number なので無条件 scale。
    sceneTransitions: model.sceneTransitions.map((t) => ({ ...t, durationFrames: sc(t.durationFrames) })),
    // atOriginal は不変（原本フレームのキー）。playbackFrame は再生座標なので scale。
    joins: model.joins.map((j) => ({ ...j, playbackFrame: sc(j.playbackFrame) })),
    mainSpeed: rate,
    speedSegments: null,
  };
}

/**
 * 速度を適用する。個別指定ゼロ（または冗長のみ）なら applyMainSpeed（一律・バイト同値）。
 * 個別指定ありなら区分線形（区間ごとに rate）でスケールする。
 */
export function applySpeed(
  model: PlaybackModel,
  mainSpeed: number,
  segmentSpeeds: Record<number, number>,
): PlaybackModel {
  if (!hasPerSegmentSpeed(segmentSpeeds, mainSpeed)) return applyMainSpeed(model, mainSpeed);
  const segs = resolveSpeedSegments(model.keptSegments, mainSpeed, segmentSpeeds);
  const sc = (f: number): number => playbackToSpeed(f, segs);
  // 区間内の局所速度（要素の伸縮レート＝その要素が属する区間の rate）
  const rateAt = (f: number): number => {
    for (const s of segs) {
      if (f >= s.start && f < s.end) return s.rate;
    }
    return segs.at(-1)?.rate ?? mainSpeed;
  };
  return {
    ...model,
    durationInFrames: Math.max(1, speedTotalFrames(segs)),
    // playbackDurationInFrames / playbackOverlaps: 不変（橋渡し用の速度前）
    // NOTE: o.overlap は尺（duration）。区分線形では境界をまたぐ overlap は近似になる。
    // 本スコープ（区間速度有効時 overlaps 空＝フェード系は尺不変）では未到達。
    // 重なる系トランジション × 区間速度 の厳密統合は Plan 3。
    overlaps: model.overlaps.map((o) => ({ boundary: sc(o.boundary), overlap: sc(o.overlap) })),
    keptSegments: model.keptSegments.map((s) => ({
      ...s,
      playbackStart: sc(s.playbackStart),
      playbackEnd: sc(s.playbackEnd),
    })),
    telops: model.telops.map((t) => ({ ...t, startFrame: sc(t.startFrame), endFrame: sc(t.endFrame) })),
    titles: model.titles.map((t) => ({ ...t, startFrame: sc(t.startFrame), endFrame: sc(t.endFrame) })),
    se: model.se.map((s) => ({ ...s, playbackFrame: sc(s.playbackFrame), playbackEnd: sc(s.playbackEnd) })),
    images: model.images.map((i) => ({ ...i, playbackStart: sc(i.playbackStart), playbackEnd: sc(i.playbackEnd) })),
    videoInserts: model.videoInserts.map((v) => ({
      ...v,
      playbackStart: sc(v.playbackStart),
      playbackEnd: sc(v.playbackEnd),
      playbackRate: (v.playbackRate ?? 1) * rateAt(v.playbackStart),
    })),
    bgm: model.bgm.map((c) => ({ ...c, startFrame: sc(c.startFrame), endFrame: sc(c.endFrame) })),
    shapes: model.shapes.map((s) => ({ ...s, startFrame: sc(s.startFrame), endFrame: sc(s.endFrame) })),
    sceneTransitions: model.sceneTransitions.map((t) => ({ ...t, durationFrames: sc(t.durationFrames) })),
    joins: model.joins.map((j) => ({ ...j, playbackFrame: sc(j.playbackFrame) })),
    mainSpeed,
    speedSegments: segs,
  };
}

/** EditorProject からカット適用済みの再生モデルを組み立てる。 */
export function buildPlaybackModel(project: EditorProject): PlaybackModel {
  const original = project.videoConfig.durationFrames;
  const keptSegments = applyCuts(original, project.cutRegions);
  const joins = computeJoins(original, project.cutRegions);
  const playbackDurationInFrames = Math.max(1, playbackTotalFrames(original, project.cutRegions));

  // sceneTransitions（at=原本フレーム）を再生フレームへ解決し overlaps を構築する。
  const resolved = resolveSceneTransitions(project.sceneTransitions ?? [], joins);
  const playbackTransitions = resolved.map((r) => ({ ...r.transition, at: r.playbackFrame }));
  const overlaps = buildOverlaps(playbackTransitions, keptSegments);

  // overlaps を考慮した最終尺（重なりなしなら playbackDurationInFrames と同値）。
  const durationInFrames = Math.max(1, finalTotalFrames(playbackDurationInFrames, overlaps));

  // 再生座標の各要素を collapse で最終座標へ写す（overlaps 空なら恒等）。
  const projectedTelops = projectTelops(project.telops, project.cutRegions);
  const telops = collapseTelops(projectedTelops, overlaps);

  const projectedTitles = projectTitles(project.titles, project.cutRegions);
  const titles = collapseTitles(projectedTitles, overlaps);

  // serializeProject と同型: clampSe→projectSe の順で射影し、縮退区間（endFrame<=startFrame）を除外。
  const { se: clampedSe } = clampSe(project.se, project.cutRegions);
  const projectedSe: SePlayback[] = projectSe(clampedSe, project.cutRegions)
    .filter((s) => (s.endFrame ?? 0) > s.startFrame)
    .map((s) => ({
      id: s.id,
      playbackFrame: s.startFrame,
      playbackEnd: s.endFrame ?? s.startFrame,
      file: s.file,
      volume: s.volume ?? 1,
      fadeInFrames: s.fadeInFrames,
      fadeOutFrames: s.fadeOutFrames,
    }));
  const se = collapseSe(projectedSe, overlaps);

  // serializeProject と同じく clamp してから project する。Codex P2 指摘:
  // 端がカット区間に落ちている画像を生で projectImages へ渡すと、フォールバックが
  // 「事前 clamp 済み」を前提にしているため再生フレーム 0 へ寄ってしまい、保存時の
  // 結果（clamp 後の値）と乖離する。プレビュー＝保存と一致させるためここで clamp する。
  const { images: clampedImages } = clampImages(project.images, project.cutRegions);
  const projectedImages: ImagePlayback[] = projectImages(clampedImages, project.cutRegions).map((i) => ({
    id: i.id,
    playbackStart: i.startFrame,
    playbackEnd: i.endFrame,
    file: i.file,
    type: i.type,
    position: i.position,
    opacity: i.opacity,
    rotation: i.rotation,
    enter: i.enter,
    exit: i.exit,
    // scale 未指定は playback 側で 1 既定（InsertImage.tsx の `scale ?? 1` と一致）。
    // ★M5 注意★ インスペクタの scale 既定表示も必ず `?? 1` と揃えること
    // （Plan A Codex P2-2 と同型のバグ予防：ファイル経由 SE で `?? 0.3` 表示と `?? 1` 再生がズレた）。
    scale: i.scale ?? 1,
  }));
  const images = collapseImages(projectedImages, overlaps);

  const { videoInserts: clampedVi } = clampVideoInserts(project.videoInserts ?? [], project.cutRegions);
  const projectedVi: VideoInsertPlayback[] = projectVideoInserts(clampedVi, project.cutRegions).map((v) => ({
    id: v.id,
    playbackStart: v.startFrame,
    playbackEnd: v.endFrame,
    file: v.file,
    sourceInFrame: v.sourceInFrame,
    position: v.position,
    scale: v.scale ?? 1,
    enter: v.enter,
    exit: v.exit,
    playbackRate: v.playbackRate,
  }));
  const videoInserts = collapseVideoInserts(projectedVi, overlaps);

  // サブ動画と同型: clampBgm→projectBgm の順で射影し、縮退区間（endFrame<=startFrame）を除外。
  const { bgm: clampedBgm } = clampBgm(project.bgm ?? [], project.cutRegions);
  const projectedBgm = projectBgm(clampedBgm, project.cutRegions).filter((c) => c.endFrame > c.startFrame);
  const duckedBgm = applyDuckingToBgm(
    projectedBgm,
    project.transcript.words,
    project.cutRegions,
    project.videoConfig.fps,
    project.ducking,
  );
  const bgm = collapseBgm(duckedBgm, overlaps);

  // 画像・サブ動画と同型: clampShapes→projectShapes の順で射影し、縮退区間を除外。
  const { shapes: clampedShapes } = clampShapes(project.shapes ?? [], project.cutRegions);
  const projectedShapes: ShapeSegment[] = projectShapes(clampedShapes, project.cutRegions)
    .filter((s) => s.endFrame > s.startFrame)
    .map((s) => ({ ...s, opacity: s.opacity }));
  const shapes = collapseShapes(projectedShapes, overlaps);

  // まず速度前（mainSpeed=1）のモデルを組み、最後に applyMainSpeed で一括スケールする。
  // playbackOverlaps は速度前 overlaps をそのまま carry（定規⇄プレイヤー橋渡し用）。
  const base: PlaybackModel = {
    fps: project.videoConfig.fps,
    width: project.videoConfig.resolution.width,
    height: project.videoConfig.resolution.height,
    durationInFrames,
    playbackDurationInFrames,
    overlaps,
    playbackOverlaps: overlaps,
    keptSegments,
    telops,
    titles,
    titleStyle: project.videoConfig.titleStyle,
    se,
    images,
    videoInserts,
    bgm,
    shapes,
    sceneTransitions: project.sceneTransitions ?? [],
    joins,
    mainSpeed: 1,
    speedSegments: null,
  };
  return applySpeed(base, project.mainSpeed, project.segmentSpeeds ?? {});
}

/** 指定フレームで表示中のテロップを返す（startFrame 含む / endFrame 排他）。 */
export function activeTelopAt(telops: TelopSegment[], frame: number): TelopSegment | null {
  for (const t of telops) {
    if (frame >= t.startFrame && frame < t.endFrame) return t;
  }
  return null;
}

/**
 * 指定フレームで表示中（startFrame<=frame<endFrame）の全テロップを入力順で返す。
 * 字幕は時間が重ならないため通常 0〜1 件だが、装飾テロップ（旧タイトル含む）は字幕と
 * 重なって同時表示されうる。各テロップは自身の position/scale で別位置に描かれるため、
 * すべて同時に描画する（1 件だけ描くと長尺の装飾が字幕に奪われて一瞬で消える）。
 */
export function activeTelopsAt(telops: TelopSegment[], frame: number): TelopSegment[] {
  return telops.filter((t) => frame >= t.startFrame && frame < t.endFrame);
}

/** 指定再生フレームで表示中（startFrame<=frame<endFrame）の全タイトルを入力順で返す。 */
export function activeTitlesAt(titles: TitleSegment[], frame: number): TitleSegment[] {
  return titles.filter((t) => frame >= t.startFrame && frame < t.endFrame);
}
