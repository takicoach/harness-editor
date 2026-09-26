import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject } from '../core';
import { hasTimelinePlacements } from '../core/timelinePlacement';
import { buildPlaybackModel } from '../preview/playbackModel';
import { bgmSourceHasDucking } from '../core/bgmData';
import { buildCutOrdering, reorderSpanCovering, reorderStartEnd } from '../core/cutOrder';
import { applyDuckingToBgm } from '../core/ducking';
import {
  buildExportTimeline,
  attachAudio,
  attachShapes,
  attachTelops,
  attachTitles,
  attachImages,
  attachVideoInserts,
} from '../core/exportTimeline';
import { clampShapes, projectShapes } from '../core/shapeEngine';
import { projectTelops } from '../core/telopEngine';
import { projectTitles } from '../core/titleEngine';
import { clampImages, projectImages } from '../core/imageEngine';
import { clampVideoInserts, projectVideoInserts } from '../core/videoInsertEngine';
import type {
  CutRegion,
  EditorProject,
  ImagePlayback,
  SceneTransition,
  ShapeSegment,
  TelopSegment,
  TitleSegment,
  TitleStyle,
  VideoInsertPlayback,
} from '../core/types';
import type { ExportTimeline } from '../core/exportTimeline';
import { computeJoins, resolveSceneTransitions } from '../core/joinEngine';
import { deriveSePlayback } from '../core/seExport';
import { deriveBgmPlayback } from '../core/bgmExport';
import { nativeUnsupportedReasons } from '../shared/cutsOnly';
import type { RenderOptions } from '../shared/renderPreset';
import { targetResolution } from '../shared/renderPreset';
import { readProjectFiles } from './loadProjectFiles';
import { applyAudioMix } from './nativeExportAudio';
import {
  applyOverlays,
  applySceneFadeLayers,
  applyShapeOverlays,
  computeOverlayInputIndexBase,
  videoInsertPlacement,
  type OverlayLayer,
  type ShapeOverlay,
} from './nativeExportVideo';
import { videoInsertAnimSteps } from './videoInsertAnim';
import {
  deriveSceneFadeSpecs,
  deriveTransitionOverlaps,
  ffmpegColorOrNull,
  type SceneFadeSpec,
  type TransitionOverlapSpec,
} from './transitionFilter';
import { rasterizeShape } from './shapeRaster';
import { sec } from './ffmpegTime';
import { DuckGainRegionLimitExceededError } from './duckGainExpr';
import { probeFrameCount, probeFrameRates, probeSubVideo, probeUniformFrameDurations, probeVideoSize } from './probeFrames';
import { planCaptureRuns, type CaptureRunSpan } from './captureRunPlanner';
import { captureSpecifiedRuns, type CaptureManifestRun } from './captureDriver';
import { resolveChromiumBin, type ResolveChromiumResult, type ResolveChromiumFailKind } from './resolveChromium';
import { hasCaptureOverlays, type FastCutIneligibleReason } from '../shared/captureOverlays';
import { buildCaptureSequenceInput } from './captureSequenceInput';
import { getServerOrigin } from './serverOrigin';
import { loadOverlayComponentsForPlanner } from './loadOverlayComponents';
import { createAssetResolver } from '../capturePage/staticFileResolver';
import type { LoadedComponents } from '../capturePage/layers';
import type { CaptureLayerKind } from '../capturePage/protocol';
import type { FastCutPrepareOutcome } from './fastCutCapture';
import type { RenderCaptureEstimate } from './renderJobTypes';
import { withoutUnsupportedKeyframes } from '../shared/motionKeys';
import { detectMotionKeysSupport } from './motionKeysSupport';
import {
  verifyCutFramesStrict,
  verifyOutputSize,
  applyScaleFilter,
  applySegmentContain,
  buildCutFilterScript,
  containFilterFor,
  buildFastCutArgs,
  scaleFilterFor,
  type KeptSegment,
} from './fastCutRender';

/**
 * 撮影オーバーレイ（テロップ／タイトル／画像）の再生座標への射影（M2d 最終・M-5）。
 *
 * 列は **プレビュー（playbackModel.ts:195/198/209-210）と同一**（M2c 設計判断10・T4 レビュー由来の
 * 訂正）。プレビューは telops/titles に clamp を掛けず projectTelops/projectTitles 直行、
 * images だけ clampImages を先に掛ける。保存側（core/project.ts の clampTelops/clampTitles）は
 * 「保存の都合」であり書き出し座標には現れない——ここで clamp を足すと、カット境界に跨る
 * テロップで**プレビューと違う絵**を書き出す（clamp 有りは端をカット外へ寄せる／無しは縮退して
 * 消える）。描き手は1つ、正はプレビュー。
 *
 * export しているのは、パリティテスト（captureOverlaysParity.test.ts）が同じ列を**手写し**すると
 * 本体の射影を変えてもテストが追随せず、パリティ検査そのものが形骸化するため（M-5）。
 */
export function projectCaptureOverlays(
  project: EditorProject,
  ordering: ReturnType<typeof buildCutOrdering>,
): { telops: TelopSegment[]; titles: TitleSegment[]; images: ImagePlayback[] } {
  const telops: TelopSegment[] = reorderStartEnd(
    projectTelops(project.telops, project.cutRegions),
    ordering,
  ).filter((t) => t.endFrame > t.startFrame);
  const titles: TitleSegment[] = reorderStartEnd(
    projectTitles(project.titles, project.cutRegions),
    ordering,
  ).filter((t) => t.endFrame > t.startFrame);
  const { images: clampedImages } = clampImages(project.images, project.cutRegions);
  const images: ImagePlayback[] = reorderStartEnd(projectImages(clampedImages, project.cutRegions), ordering)
    .map((i) => ({
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
      // playbackModel.ts:224 と同じ既定（InsertImage.tsx の `scale ?? 1`）。
      scale: i.scale ?? 1,
    }))
    .filter((i) => i.playbackEnd > i.playbackStart);
  return { telops, titles, images };
}

/**
 * サブ動画インサート（videoInserts）の再生座標への射影（M4 T3）。
 *
 * 列は **プレビュー（`preview/playbackModel.ts:226-238`）と同一**——
 * `clampVideoInserts` → `projectVideoInserts` → `reorderStartEnd` → 既定値解決 → 縮退除外。
 * 画像（`projectCaptureOverlays` の images）が姉妹実装で、揃えてあるのは「描き手は1つ」の
 * 規律（プレビューと違う座標で書き出さない）。
 *
 * **最終座標（転換の畳み込み）はここでは行わない**——正典⑧ と M3 の ExportTimeline 契約により
 * `playbackToFinal` を呼ぶのは `attachVideoInserts`（core/exportTimeline.ts）だけ。
 *
 * export しているのは、テストが同じ列を手写しすると本体の射影を変えても追随しないため
 * （projectCaptureOverlays と同じ理由・M-5）。
 */
export function projectVideoInsertPlayback(
  project: EditorProject,
  ordering: ReturnType<typeof buildCutOrdering>,
): VideoInsertPlayback[] {
  const { videoInserts: clamped } = clampVideoInserts(project.videoInserts ?? [], project.cutRegions);
  return reorderStartEnd(projectVideoInserts(clamped, project.cutRegions), ordering)
    .map((v) => ({
      id: v.id,
      playbackStart: v.startFrame,
      playbackEnd: v.endFrame,
      file: v.file,
      sourceInFrame: v.sourceInFrame,
      position: v.position,
      // playbackModel.ts:234 と同じ既定（`InsertVideo.tsx` の `scale ?? 1`）。
      scale: v.scale ?? 1,
      enter: v.enter,
      exit: v.exit,
      // playbackRate の既定 1 は layer 生成時に解決する（`InsertVideo.tsx` の `playbackRate ?? 1`）。
      // ここで潰さないのはプレビュー（playbackModel.ts:237）が undefined のまま持つため。
      playbackRate: v.playbackRate,
    }))
    .filter((v) => v.playbackEnd > v.playbackStart);
}

/**
 * 「カットしただけ」の書き出しを ffmpeg 直結で行う計画を立てる。
 * 条件を満たさない・読み取りに失敗した場合は null（通常の Remotion 経路へ落ちる）。
 */
export interface FastCutPlan {
  /**
   * ffmpeg 引数。**prepareCapture がある場合はこの args は暫定値**で、撮影段が返す args が
   * 正（連番 PNG 入力が加わり、filter script も撮影段が書き出す）。renderJob は prepare 成功後に
   * 必ず差し替えてから spawn する契約（契約違反時は filter script 不在/不整合で ffmpeg が
   * 失敗し、フォールバックへ落ちる＝黙ってテロップ抜きの動画を出さない）。
   */
  args: string[];
  /** 書き出し後の検算（出力フレーム数 vs 想定）。 */
  verify: (output: string, expectedFrames: number) => string | null;
  /** 出力されるはずのフレーム数（進捗の分母＋書き出し後の検算）。 */
  totalFrames: number;
  /** 出力解像度（表示用）。 */
  target: { width: number; height: number };
  /**
   * 完了時の一時ファイル後始末（焦点再レビュー必須1の対処）。**非撮影経路
   * （`prepareCapture` が undefined の plan）のときだけ非 undefined**——図形PNG
   * （`.shape-{i}-{token}.png`）と filter script（`cut-filter-{token}.txt`）を削除する。
   * 撮影経路はこれらを prepareCapture の tempDirs（既存の cleanup 経路）へ既に積んでいるため
   * ここでは重複させない。renderJob が job 終端（done/failed/cancelled）で1回だけ呼ぶ契約
   * （prepareCleanups と同じ規約）。
   */
  cleanup?: () => void;
  /**
   * 撮影段（M2c 設計判断5）。オーバーレイ（テロップ/タイトル/画像）が1つでもあるときだけ
   * 非 undefined。同期段の後に renderJob が実行し、成功した args で ffmpeg を起動する。
   */
  prepareCapture?: (report: (estimate: RenderCaptureEstimate) => void) => Promise<FastCutPrepareOutcome>;
}

/**
 * 撮影単価（ms/フレーム）。T1(c) の実測値（1080x1920・setFrame+screenshot のみ・3,000fr ラン
 * の平均 68.23ms）。予測時間の算出にのみ使い、退避判断には使わない（設計判断6）。
 */
export const CAPTURE_MS_PER_FRAME = 68.23;

/** 撮影段に必要な依存（テストはここを差し替えて実 Chromium 無しで配線を pin する）。 */
export interface FastCutCaptureDeps {
  /** 撮影ページ URL と /api/asset の解決に要る projectId。無ければ撮影経路を使わない。 */
  projectId?: string;
  /** シグネチャ run 分類（既定: captureRunPlanner.planCaptureRuns）。 */
  planCaptureRuns?: typeof planCaptureRuns;
  /** run 指定撮影（既定: captureDriver.captureSpecifiedRuns）。 */
  captureSpecifiedRuns?: typeof captureSpecifiedRuns;
  /** 密連番ハードリンク化（既定: captureSequenceInput.buildCaptureSequenceInput）。 */
  buildCaptureSequenceInput?: typeof buildCaptureSequenceInput;
  /** 撮影ドライバへ渡す origin（既定: serverOrigin.getServerOrigin）。 */
  serverOrigin?: () => string | null;
  /**
   * Node 側の run 分類に要る Telop / InsertImage 部品の解決。
   *
   * **未注入の既定は loadOverlayComponentsForPlanner（M2c T5b で配線）**。プロジェクトの
   * Telop.tsx / InsertImage.tsx は `'remotion'` を直接 import するため Node で読むには解決が
   * 要る（capturePage はブラウザの importmap で解決している）。既定実体は esbuild で
   * external 'remotion' のままバンドルし、評価時に captureRunPlanner と**同一インスタンス**の
   * captureRuntime を注入する（loadOverlayComponents.ts の doc 参照）。読み込みに失敗したら
   * prepare が ok:false を返し、renderJob が従来どおり Remotion 経路へフォールバックする。
   * 本フィールドはテストのスパイ差し替え用に残す。
   * タイトルのみのプロジェクトは部品を要らない（CaptureTitleLayer は capturePage 側の
   * 独立実装）ため、ファイルに触れずに撮影経路へ乗る。
   */
  loadComponents?: () => LoadedComponents | Promise<LoadedComponents>;
  /** 一時ディレクトリの削除（既定: fs.rmSync recursive+force）。 */
  removeDir?: (dir: string) => void;
  /**
   * 撮影一時ディレクトリ名に混ぜるジョブ一意識別子の生成（既定: 時刻+乱数）。
   * plan 1件につき1回だけ呼ばれる。テストで固定値を注入する用。
   */
  tempDirToken?: () => string;
}

/** 既定のジョブ一意識別子（時刻 + 乱数。同一ミリ秒の再実行でも衝突しない）。 */
function defaultTempDirToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 撮影レイヤ1本ぶんの計画（画像 / telop+title の2パス・設計判断3）。 */
interface CaptureLayerJob {
  /** 撮影ページのレイヤ種別。 */
  layer: CaptureLayerKind;
  /** spec.data（layers.tsx の各 LayerData と同形）。 */
  data: unknown;
  /** 撮影対象の再生区間（和集合・昇順・非重複）。 */
  spans: CaptureRunSpan[];
  /** 一時ディレクトリの接頭辞（out/ 配下・ドット始まり）。 */
  slug: string;
}

/** 区間の和集合を昇順・非重複へ正規化する（planCaptureRuns の spans 契約）。 */
export function mergeCaptureSpans(
  ranges: ReadonlyArray<{ start: number; end: number }>,
  durationInFrames: number,
): CaptureRunSpan[] {
  const clipped = ranges
    .map((r) => ({
      start: Math.max(0, Math.min(durationInFrames, Math.floor(r.start))),
      end: Math.max(0, Math.min(durationInFrames, Math.ceil(r.end))),
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const merged: CaptureRunSpan[] = [];
  for (const r of clipped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      continue;
    }
    merged.push({ start: r.start, end: r.end });
  }
  return merged;
}

/**
 * 転換配線（I-4）: 原本 at の sceneTransitions から
 * 「ExportTimeline → overlaps / fade 色レイヤ / filter script（scale 挿入まで）」を作る純関数。
 *
 * fastCutPlan の本体から切り出してあるのは、**ゲート（cutsOnly.ts）が閉じている間は
 * この配線が製品経路から一度も実行されない**ため——planFastCut 経由でしか触れない形だと
 * 「配線したつもりで通電していない」誤りを T5 まで検出できない（H-27 / H-53）。
 * 例外は投げるだけにして、Remotion 退避の判断は呼び出し側が行う。
 */
export interface TransitionWiringInput {
  fps: number;
  /** 原本の総フレーム数（computeJoins の入力）。 */
  originalTotalFrames: number;
  cutRegions: CutRegion[];
  ordering: ReturnType<typeof buildCutOrdering>;
  /** `project.sceneTransitions`（**at は原本フレーム**）。 */
  sceneTransitions: readonly SceneTransition[];
  options: RenderOptions;
  /** composition（= `videoConfig.resolution`。preset 縮小 scale の要否判定）。 */
  source: { width: number; height: number };
  /**
   * 素材寸法 ≠ composition のときに各区間へ挟む contain フィルタ（C-0・`containFilterFor` の結果）。
   * 同寸・未指定なら 1 文字も足さない（受入 E）。
   */
  contain?: string | null;
}

export interface TransitionWiring {
  /** 唯一の時間軸（再生 at へ解決した転換で組んだもの）。 */
  timeline: ExportTimeline;
  /** 再生フレームへ解決済みの転換（head/tail は素通し）。 */
  playbackTransitions: SceneTransition[];
  segments: KeptSegment[];
  totalFrames: number;
  overlaps: TransitionOverlapSpec[];
  sceneFades: SceneFadeSpec[];
  /** buildCutFilterScript + scale 挿入まで済んだ script（音声ミックス前）。 */
  script: string;
}

export function buildTransitionWiring(input: TransitionWiringInput): TransitionWiring {
  /**
   * C-1: `sceneTransitions[].at` は**原本フレーム**。正典の列（`preview/playbackModel.ts` の
   * `resolveSceneTransitions(…, computeJoins(…))` → `at: playbackFrame` → `buildOverlaps`）を
   * そのまま通してから ExportTimeline へ渡す。素通しするとカットのあるプロジェクトで
   * 原本 at がどの再生境界にも一致せず、**転換が静かに消えた動画**が出る。
   * head/tail は座標を持たないので素通し（resolveSceneTransitions は number だけを扱う）。
   */
  const joins = computeJoins(input.originalTotalFrames, input.cutRegions, input.ordering);
  const resolved = resolveSceneTransitions([...input.sceneTransitions], joins);
  const playbackAt = new Map<SceneTransition, number>();
  for (const r of resolved) playbackAt.set(r.transition, r.playbackFrame);
  const playbackTransitions: SceneTransition[] = input.sceneTransitions.flatMap((t) => {
    if (t.at === 'head' || t.at === 'tail') return [t];
    const at = playbackAt.get(t);
    // 一致する join が無い at は捨てる（正典 SceneOverlayLayer / buildOverlaps と同じ扱い）。
    return at === undefined ? [] : [{ ...t, at }];
  });

  const timeline = buildExportTimeline({
    fps: input.fps,
    segments: input.ordering.segments.map((s) => ({
      originalStart: s.originalStart,
      originalEnd: s.originalEnd,
    })),
    transitions: playbackTransitions,
  });
  const segments: KeptSegment[] = timeline.segments.map((s) => ({
    start: s.originalStart,
    end: s.originalEnd,
  }));
  const totalFrames = timeline.totalFrames;
  const overlaps = deriveTransitionOverlaps(timeline, playbackTransitions);
  const sceneFades = deriveSceneFadeSpecs(timeline, playbackTransitions);

  // totalFrames（= finalTotalFrames）と組み立てた chain の理論フレーム数の一致を検算する
  // （不一致は throw → 呼び出し側が Remotion 退避）。
  let script = buildCutFilterScript(segments, input.fps, overlaps, { expectTotalFrames: totalFrames });
  // C-0: 素材寸法を composition へ contain で合わせる（xfade・fade 色レイヤ・overlay 鎖より上流）。
  if (input.contain !== undefined && input.contain !== null) {
    script = applySegmentContain(script, input.contain, segments.length);
  }
  const scale = scaleFilterFor(input.options, input.source);
  if (scale !== null) {
    // 縮小は concat / xfade 群のあとに 1 回だけ掛ける（区間ごとに掛けると無駄が大きい）。
    script = applyScaleFilter(script, scale);
  }
  return { timeline, playbackTransitions, segments, totalFrames, overlaps, sceneFades, script };
}

/**
 * オーバーレイ鎖の合成（設計判断5・M2c 設計判断8・M4 T2）。
 * z 順は **画像 → サブ動画 → 図形 → 色レイヤ → 撮影 PNG（telop+title）**（M4 正典⑦）。
 */
export interface ComposeOverlayChainsInput {
  script: string;
  fps: number;
  imageLayers: readonly OverlayLayer[];
  /**
   * サブ動画（videoInserts）レイヤ（M4 T2）。**画像の後・図形の前**（正典⑦）。
   * 省略・空なら script は1文字も変わらない（受入 E）。
   */
  videoLayers?: readonly OverlayLayer[];
  shapeLayers: readonly OverlayLayer[];
  telopTitleLayers: readonly OverlayLayer[];
  sceneFades: readonly SceneFadeSpec[];
  imagesBase: number;
  /** サブ動画群の先頭入力 index（videoLayers が空なら参照されない）。 */
  videosBase?: number;
  telopTitleBase: number;
  /** 色レイヤの寸法（= 出力解像度）。 */
  size: { width: number; height: number };
  totalFrames: number;
}

export function composeOverlayChains(input: ComposeOverlayChainsInput): string {
  const videoLayers = input.videoLayers ?? [];
  /**
   * 入力 index の割当は `imagesBase + 配列順` の一本道（applyOverlays の契約）。
   * サブ動画群の先頭は「画像群の直後」でなければならず、ここが食い違うと
   * **別の入力の絵を合成した動画が静かに出る**ので fail-loud にする（黙って続けない）。
   */
  if (videoLayers.length > 0) {
    const expected = input.imagesBase + input.imageLayers.length;
    /**
     * I-4: **省略も許さない**（旧実装は `videosBase !== undefined` を条件にしていたため、
     * 渡し忘れると検算ごと素通りした＝「検算を `if (false)` にする」変異が生存した）。
     */
    if (input.videosBase === undefined) {
      throw new Error(
        `composeOverlayChains: サブ動画 ${videoLayers.length} 件に対して videosBase が未指定です（画像群の直後 ${expected} を渡すこと）`,
      );
    }
    if (input.videosBase !== expected) {
      throw new Error(
        `composeOverlayChains: videosBase(${input.videosBase}) が画像群の直後(${expected})と一致しません`,
      );
    }
  }
  /**
   * M-4: **最後の群まで検算する**。`videosBase` の検算は「画像群の直後」しか見ないので、
   * `computeOverlayInputIndexBase` に `videosCount` を渡し忘れた変異では素通りする
   * （`videosBase` は画像群の直後のまま・ずれるのは後ろの `telopTitleBase`）。その場合
   * 撮影 PNG 鎖がサブ動画の入力を指す＝**別の入力の絵がテロップとして乗る**ので fail-loud にする。
   * 並びは `imagesBase → 画像 → サブ動画 → 図形 → 撮影PNG`（applyOverlays の契約と同順）。
   */
  const expectedTelopTitleBase =
    input.imagesBase + input.imageLayers.length + videoLayers.length + input.shapeLayers.length;
  if (input.telopTitleBase !== expectedTelopTitleBase) {
    throw new Error(
      `composeOverlayChains: telopTitleBase(${input.telopTitleBase}) が 画像+サブ動画+図形 の直後(${expectedTelopTitleBase})と一致しません`,
    );
  }
  if (input.sceneFades.length === 0) {
    // 色レイヤが無ければ従来どおり1回で積む（4群は連続した入力 index を占めるので
    // applyOverlays の配列順がそのまま z 順・出力は1文字も変わらない）。
    return applyOverlays(
      input.script,
      [...input.imageLayers, ...videoLayers, ...input.shapeLayers, ...input.telopTitleLayers],
      input.fps,
      input.imagesBase,
    );
  }
  // 色レイヤは**図形鎖の後・撮影 PNG（telop+title）鎖の前**（設計判断5・64f5fd4）。
  // 正典の重なりは 主映像 → 画像 → 図形 → 色レイヤ（zIndex なし）→ タイトル(100) → テロップ(200)。
  const belowColor = applyOverlays(
    input.script,
    [...input.imageLayers, ...videoLayers, ...input.shapeLayers],
    input.fps,
    input.imagesBase,
  );
  const withColor = applySceneFadeLayers(
    belowColor,
    input.sceneFades,
    input.fps,
    input.size,
    input.totalFrames,
  );
  // 2回目の overlay 鎖は中間ラベルを接頭辞で分離する（1回目と衝突させない）。
  return applyOverlays(withColor, input.telopTitleLayers, input.fps, input.telopTitleBase, 'tt');
}

/** titleStyle が実値として揃っているか（黙って既定値へ落とさないための fail-loud 判定）。 */
function isUsableTitleStyle(style: TitleStyle | undefined): style is TitleStyle {
  return (
    style !== undefined &&
    Number.isFinite(style.top) &&
    Number.isFinite(style.left) &&
    Number.isFinite(style.fontSize)
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function planFastCutImpl(
  projectDir: string,
  options: RenderOptions,
  output: string,
  deps: {
    hardware?: boolean;
    writeFile?: (p: string, data: string) => void;
    /** 図形 PNG のバイナリ書き出し（deps 注入・既定は fs 直書き）。 */
    writeBinaryFile?: (p: string, data: Buffer) => void;
    /** 図形 1 個の PNG ラスタライズ（deps 注入・既定は resvg 実体）。throw は plan 不成立として扱う。 */
    rasterizeShape?: (shape: ShapeSegment, width: number, height: number) => Buffer;
    probeRates?: (path: string) => { r: number; avg: number } | null;
    probeUniform?: (path: string, fps: number) => boolean | null;
    /**
     * 動画の実寸（C-0・既定は probeFrames.probeVideoSize）。
     * **素材（main.mp4）の計測**と **`verify` の出力寸法検収（I-2）**の両方で使う同一の口。
     * `exact: false`（SAR≠1:1・回転不明）は「表示寸法を読み切れていない」印で、
     * 同寸でも contain を入れる側へ倒す。`sar`（C-8）は非正方画素の正規化と
     * `verifyOutputSize` の SAR=1:1 検収に使う（数値・不明は null）。
     */
    probeSize?: (path: string) => { width: number; height: number; exact?: boolean; sar?: number | null } | null;
    /**
     * サブ動画の time_base / SAR（I-1 / M-3・既定は probeFrames.probeSubVideo）。
     * 読めなければ null＝**Remotion 経路へ退避**（分からないまま canon 写像を掛けない）。
     */
    probeSubVideo?: (path: string) => { timeBaseDen: number; sar: number | null } | null;
    exists?: (p: string) => boolean;
    /** 撮影段（M2c）の依存。省略時は既定実装（実 Chromium・実 origin）。 */
    capture?: FastCutCaptureDeps;
    /**
     * 撮影エンジン（chrome-headless-shell）の存在検査（M2d T2・設計判断5）。
     * 既定は resolveChromiumBin（起動はしない・存在検査のみ）。テストは fake に差し替える。
     */
    resolveChromium?: () => ResolveChromiumResult;
  },
  /** 撮影エンジン解決に失敗した理由を呼び出し元へ伝える（planFastCutDetailed 用）。 */
  onIneligible: (reason: FastCutIneligibleReason) => void,
): FastCutPlan | null {
  const hardware = deps.hardware ?? process.platform === 'darwin';
  const write = deps.writeFile ?? ((p: string, data: string) => writeFileSync(p, data, 'utf8'));
  const writeBinary = deps.writeBinaryFile ?? ((p: string, data: Buffer) => writeFileSync(p, data));
  const rasterize = deps.rasterizeShape ?? rasterizeShape;
  /**
   * ジョブ一意識別子（M-4）。撮影一時ディレクトリ（`.capture-*`）と同じ理由で
   * `cut-filter.txt` / `.shape-{i}.png` にも混ぜる: これらも固定名だと「キャンセル→
   * すぐ再実行」で旧ジョブの書き込みが新ジョブのファイルを上書きしうる（ffmpeg 起動前の
   * 同期書き込みなので撮影ほど窓は広くないが、同一 projectId の連続 POST /api/render は
   * 理論上あり得るため名前空間を分離しておく）。
   */
  const jobToken = (deps.capture?.tempDirToken ?? defaultTempDirToken)();

  let project;
  try {
    project = loadProject(readProjectFiles(projectDir));
  } catch {
    return null; // 読めないなら通常経路（そちらでエラーになる）
  }
  if (
    nativeUnsupportedReasons({
      ...project,
      // 二層ゲート: リクエストに ducking 設定が同梱されていれば native 側で処理できるため
      // 理由を立てない（false 固定）。未供給（旧クライアント/未対応 UI 経路）のときだけ、
      // 評価済みモジュール（normalize 前の生オブジェクト）による焼き込み検知で安全側へ倒す
      // （整形＝インデント・改行・コメントに依存しない。旧: 正規表現アンカー一致）。
      bgmDucking: options.ducking !== undefined ? false : bgmSourceHasDucking(project.bgmDataSource ?? null),
    }).length > 0
  ) {
    return null;
  }

  const { videoConfig } = project;

  // VFR・宣言 fps との乖離は nativeExport 非対応（trim 秒指定がフレーム境界とずれるため）。
  // 計測できない場合も安全側で Remotion 経路へ。
  const rates = (deps.probeRates ?? probeFrameRates)(
    join(projectDir, 'public', videoConfig.videoFile),
  );
  if (rates === null) return null;
  if (Math.abs(rates.r - rates.avg) > 0.001) return null;
  if (Math.abs(rates.avg - videoConfig.fps) > 0.01) return null;

  // 平均レートが公称と一致する VFR の素通し対策: 先頭サンプルのフレーム長一様性を実測。
  // 判定不能（null）も安全側で Remotion 経路へ。
  const uniform = (deps.probeUniform ?? probeUniformFrameDurations)(
    join(projectDir, 'public', videoConfig.videoFile),
    videoConfig.fps,
  );
  if (uniform !== true) return null;
  // 並び替え（cutData.ts の配列順）を反映した再生順で連結する（恒等順列なら原素材順のまま）。
  const ordering = buildCutOrdering(videoConfig.durationFrames, project.cutRegions, project.cutOrder);

  /**
   * **composition（合成解像度）= `videoConfig.resolution`**。素材寸法ではない（C-0）。
   * 正典（Remotion）は composition の中へ素材を `objectFit:'contain'` で置くので、
   * 出力寸法・色レイヤ・図形・撮影 PNG の幾何はすべてこちらが正本。
   */
  const source = { width: videoConfig.resolution.width, height: videoConfig.resolution.height };
  const target = targetResolution(source.width, source.height, options.resolution);
  const exists = deps.exists ?? existsSync;
  const probeSize = deps.probeSize ?? probeVideoSize;

  /**
   * 素材の実寸を計測し、composition と違えば contain を各区間へ挟む（C-0・受入 F）。
   *
   * **計測は無条件**（C-6）。旧コードは `exists(videoPath)` で囲っていたため、素材ファイルを
   * 置かないテスト（fastCutPlan.test.ts の大半）が製品と**別の分岐**を通っており、
   * probe まわりの回帰をどれも検出できなかった。素材が無ければ probe は null を返し、
   * 計測不能と同じ扱い（plan null → Remotion 退避）になる——そのプロジェクトは
   * native でも Remotion でも入力が無く必ず失敗するので、退避先が変わるだけ。
   * 計測できない・0 のときも **plan null（Remotion 退避）**。
   */
  const videoPath = join(projectDir, 'public', videoConfig.videoFile);
  const probed = probeSize(videoPath);
  if (probed === null || probed.width <= 0 || probed.height <= 0) {
    console.warn(
      '[sme] 素材の寸法を計測できませんでした（Remotion 経路へ退避）:',
      videoPath,
    );
    return null;
  }
  const contain: string | null = containFilterFor(probed, source);

  // ExportTimeline（唯一の時間軸）と転換配線（I-4 の純関数）。ゲート（cutsOnly.ts）が
  // 開くまで sceneTransitions は常に空なので overlaps=[] / sceneFades=[] になり、
  // 既存経路の script は 1 文字も変わらない（受入 E）。
  const sceneTransitions = project.sceneTransitions ?? [];
  let wiring: TransitionWiring;
  try {
    wiring = buildTransitionWiring({
      fps: videoConfig.fps,
      originalTotalFrames: videoConfig.durationFrames,
      cutRegions: project.cutRegions,
      ordering,
      sceneTransitions,
      options,
      source,
      contain,
    });
  } catch (err) {
    // 無言退避にしない（契約違反のバグが「なぜか Remotion 経路」に化けるのを防ぐ）。
    if (sceneTransitions.length > 0) {
      console.warn('[sme] シーン転換の配線に失敗（Remotion 経路へ退避）:', err);
    }
    return null;
  }
  const base = wiring.timeline;
  const totalFrames = wiring.totalFrames; // M1a では expectedCutFrames と等値（重なり系開放時に自動で正しくなる）
  if (totalFrames <= 0) return null;
  const sceneFades = wiring.sceneFades;
  let script = wiring.script;

  // BGM 導出はプレビュー（src/preview/playbackModel.ts）と同一列: deriveBgmPlayback
  // （単調再生座標）→ applyDuckingToBgm（設定未供給/OFF なら不変で返る）→ 並び替え → 縮退区間除外。
  const bgmPlayback = reorderSpanCovering(applyDuckingToBgm(
    deriveBgmPlayback(project.bgm ?? [], project.cutRegions),
    project.transcript.words,
    project.cutRegions,
    project.videoConfig.fps,
    options.ducking,
  ), ordering).filter((c) => c.endFrame > c.startFrame);
  // 図形導出はプレビュー（playbackModel.ts:256-260）と同一列: clampShapes → projectShapes →
  // 並び替え → 縮退区間除外（M1d 設計判断8）。
  const shapesPlayback: ShapeSegment[] = reorderStartEnd(
    projectShapes(clampShapes(project.shapes ?? [], project.cutRegions).shapes, project.cutRegions),
    ordering,
  ).filter((s) => s.endFrame > s.startFrame);
  // テロップ／タイトル／画像の導出はプレビューと同一列（正本は projectCaptureOverlays の doc）。
  const {
    telops: telopsPlayback,
    titles: titlesPlayback,
    images: imagesPlayback,
  } = projectCaptureOverlays(project, ordering);
  // サブ動画の射影も同じ層で（正本は projectVideoInsertPlayback の doc・M4 T3）。
  const videoInsertsPlayback = projectVideoInsertPlayback(project, ordering);
  // attachShapes 等は attachAudio の後に掛ける（T2 レビュー申し送り: attachAudio が非ジェネリックのため
  // 逆順は型から shapes が落ちる）。
  let timeline = attachVideoInserts(
    attachImages(
      attachTitles(
        attachTelops(
          attachShapes(
            attachAudio(base, deriveSePlayback(project.se, project.cutRegions, ordering), bgmPlayback),
            shapesPlayback,
          ),
          telopsPlayback,
        ),
        titlesPlayback,
      ),
      imagesPlayback,
    ),
    videoInsertsPlayback,
  );
  if (hasTimelinePlacements(project)) {
    // The shared model has already applied order, overlap and speed. Attach
    // functions above collapse their inputs, so never feed this final clock
    // through them again. Main-video wiring and output duration stay intact.
    const { telops, titles, images, videoInserts, bgm, se, shapes } = buildPlaybackModel({ ...project, ducking: options.ducking });
    timeline = { ...timeline, telops, titles, images, videoInserts, bgm, se, shapes };
  }
  // SE / BGM ファイルの実在チェック（無ければ安全側で Remotion 経路へ）。exists は C-0 の
  // 素材実在チェックと同一（関数冒頭で解決済み）。
  const seInputs = timeline.se.map((s) => join(projectDir, 'public', 'se', s.file));
  const bgmInputs = timeline.bgm.map((c) => join(projectDir, 'public', 'BGM', c.file));
  if ([...seInputs, ...bgmInputs].some((p) => !exists(p))) return null;
  // mixClips と extraInputs（音声側）は同一ソース（se→bgm）から導出する（入力 index の対応が命）。
  const mixClips = [
    ...timeline.se.map((s) => ({
      startFrame: s.playbackFrame,
      endFrame: s.playbackEnd,
      volume: s.volume,
      fadeInFrames: s.fadeInFrames,
      fadeOutFrames: s.fadeOutFrames,
    })),
    ...timeline.bgm.map((c) => ({
      startFrame: c.startFrame,
      endFrame: c.endFrame,
      volume: c.volume,
      fadeInFrames: c.fadeInFrames,
      fadeOutFrames: c.fadeOutFrames,
      ducking: c.ducking,
    })),
  ];
  const audioExtraInputs = [
    ...seInputs.map((p) => ({ path: p })),
    ...bgmInputs.map((p) => ({ path: p, loop: true })),
  ];

  /**
   * サブ動画（videoInserts）の入力と layer（M4 T3・正典①〜⑤⑦）。
   *
   * 入力は **`{ path }` だけ**（`-i <sub>` 1 本）。時間軸（正典①②③）は
   * `nativeExportVideo.videoSourceChain` の canon 写像が filter 側で解くので、入力側で
   * `-r` や `-ss` を足すと**二重に時間を触る**ことになる（正典から外れる）。
   *
   * placement は **`target`（出力解像度）基準**。overlay 鎖は preset 縮小（`scaleFilterFor`）の
   * **後**に積まれるため、下地は既に target 寸法になっている（図形 PNG のラスタライズ寸法が
   * target なのと同じ理由）。
   *
   * ここで plan が成立しない条件（ファイル不在・不正な rate/scale/position・placement の
   * 寸法が 0）は **fail-loud で Remotion 経路へ退避**する。黙って近似すると
   * 「サブ動画だけ消えた／別位置に載った動画」が静かに出る。判定は**図形 PNG の
   * ラスタライズより前**に置く（退避時に残骸を残さない・C-1(b) と同じ規律）。
   */
  const videoInsertInputs: { path: string }[] = [];
  const videoLayers: OverlayLayer[] = [];
  try {
    for (const v of timeline.videoInserts) {
      // 正典（`InsertVideo.tsx`）の `staticFile(segment.file)` と同じ解決（public/ 直下起点）。
      const path = join(projectDir, 'public', v.file);
      if (!exists(path)) {
        throw new Error(`サブ動画のファイルがありません: ${path}`);
      }
      /**
       * 素材諸元の probe（I-1 / M-3）。canon 写像の PTS 量子化は**素材の time_base の粒度**で
       * 行われるので、粗い素材（`den` が合成 fps に近い）は plan 段で実値を渡して
       * `settb` の整数倍へ引き上げる必要がある。読めなければ退避する（黙って近似しない）。
       */
      const probedSub = (deps.probeSubVideo ?? probeSubVideo)(path);
      if (probedSub === null) {
        throw new Error(`サブ動画の time_base / SAR を読めません: ${path}`);
      }
      /**
       * **M-3: SAR≠1（アナモルフィック）は退避する**。正典（ブラウザの `objectFit: contain`）は
       * **表示アスペクト比**で内接させるが、`scale=…:force_original_aspect_ratio=decrease` は
       * 標本寸法で内接させるので、非正方画素だと**黙って縦横比の違う絵**が出る
       * （実測: SAR 2:1 の 640×360 を 1920×1080 枠へ通すと余白なしで枠いっぱいになる）。
       * 前段正規化（`scale=trunc(iw*sar/2)*2:ih,setsar=1`）で揃える案は正典一致の実証
       * （アナモルフィック fixture × Remotion 基準線）が要るので、この修正ラウンドでは採らない。
       * 実データ（画面収録・DJI）は SAR 1:1 なので実害ゼロ。
       *
       * **未指定（`sar === null`）は弾かない**: ffmpeg も Remotion も未指定 SAR を正方画素として
       * 扱う（実測: libx264 で焼いた mp4 の `sample_aspect_ratio` は `N/A`）。ここで弾くと
       * 普通の素材が軒並み退避する。**既知の非 1:1 だけ**を退避条件にする。
       */
      if (probedSub.sar !== null && Math.abs(probedSub.sar - 1) > 1e-9) {
        throw new Error(
          `サブ動画の SAR が 1:1 ではありません（${String(probedSub.sar)}・${path}）。非正方画素の contain は正典と別物になるため native では描きません`,
        );
      }
      // 既定値は**ここで実値へ解決**する（正典は `InsertVideo.tsx` / `playbackModel.ts`）。
      const rate = v.playbackRate ?? 1; // InsertVideo.tsx: `playbackRate ?? 1`
      const position = v.position ?? { x: 0, y: 0 }; // InsertVideo.tsx: `position ?? { x: 0, y: 0 }`
      const scale = v.scale; // projectVideoInsertPlayback で `scale ?? 1` 済み
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`サブ動画の playbackRate が不正です（id=${v.id}・${String(v.playbackRate)}）`);
      }
      if (!Number.isFinite(v.sourceInFrame)) {
        throw new Error(`サブ動画の sourceInFrame が不正です（id=${v.id}・${String(v.sourceInFrame)}）`);
      }
      /**
       * enter/exit（正典⑥）は 5 種すべて native で描く（M4 T4）。窓を「静的な配置＋定数 alpha が
       * 続く区間」へ割り、区間ごとに既存の静的経路（scale/pad/crop/overlay）を積む
       * ——ffmpeg の時変式を使わないので丸めも crop も T1〜T3 で実測済みの経路と同一。
       *
       * `videoInsertAnimSteps` が `undefined` を返すのは**アニメが恒等のとき**（`none` /
       * `frames<=0`）で、そのときは従来どおり 1 レイヤ＝ filter 文字列は 1 文字も変わらない
       * （受入 E）。段数が上限を超えるプロジェクトだけ throw → Remotion 経路へ退避する。
       */
      const animSteps = videoInsertAnimSteps(
        target,
        position,
        scale,
        v.playbackEnd - v.playbackStart,
        v.enter,
        v.exit,
      );
      videoLayers.push({
        kind: 'video',
        startFrame: v.playbackStart,
        endFrame: v.playbackEnd,
        sourceInFrame: v.sourceInFrame,
        playbackRate: rate,
        // videoInsertPlacement は scale<=0 / position 非有限を throw する（正典⑤ の契約ガード）。
        placement: videoInsertPlacement(target, position, scale),
        // I-1: 素材 time_base（粗い素材は canon 鎖の先頭で整数倍へ引き上げる）。
        timeBaseDen: probedSub.timeBaseDen,
        ...(animSteps === undefined ? {} : { animSteps }),
      });
      videoInsertInputs.push({ path });
    }
  } catch (err) {
    // 無言退避にしない（「なぜか Remotion 経路」に化けるのを防ぐ・図形/転換の退避と同じ流儀）。
    console.warn('[sme] サブ動画の native 合成に失敗（Remotion 経路へ退避）:', err);
    return null;
  }

  // SE/BGM ミックスは scale 挿入（buildTransitionWiring の中）の後に適用する
  // （'[outa]' の付け替え対象を確定させてから）。
  // region 数が安全上限を超える場合（DuckGainRegionLimitExceededError）は Remotion 経路へ
  // 明示的に退避する（「正しい音で遅い」が最悪ケース。黙って壊れた filter を出さない）。
  try {
    script = applyAudioMix(script, mixClips, videoConfig.fps);
  } catch (err) {
    if (err instanceof DuckGainRegionLimitExceededError) return null;
    throw err;
  }

  // 撮影対象（テロップ/タイトル/画像）が1つでもあるか。あれば overlay 鎖の合成は
  // 撮影段（prepareCapture）が行う——z 順が「画像 → 図形 → telop+title」（設計判断8）で、
  // 図形だけを先に合成すると画像より上に来てしまい、入力 index も食い違うため。
  // 撮影が要るかの判定は src/shared/captureOverlays.ts が正本（I-3）。
  // クライアント（ExportDialog の needsCapture）も同じ述語を、同じ射影後の配列に当てる。
  const needsCapture = hasCaptureOverlays(timeline);

  /**
   * 撮影経路の適格性チェック（projectId・titleStyle）を図形 PNG ラスタライズより**前**に
   * 行う（codex-review P2）。旧コードはラスタライズ（副作用・PNG書き出し）の**後**でこれらを
   * 検査しており、不適格で null 返す時点で plan.cleanup/prepareCapture が未生成のため、
   * 書き出し済み `.shape-*-{token}.png` が後始末先を持たず書き出しのたびに残骸として
   * 溜まっていた。チェック順を入れ替えても判定結果自体は変わらない——両チェックとも
   * `deps`/`timeline`/`videoConfig` だけを参照し、ラスタライズ（図形PNG書き出し）の結果には
   * 一切依存しないため（判定に使う値がラスタライズ前後で変化しない）。
   */
  if (needsCapture) {
    // 撮影エンジン（chrome-headless-shell）実体の存在検査（M2d T2・設計判断5）。
    // 「高速→実は失敗→Remotion 退避」ではなく、撮影に入る前に事前分岐する（スペック
    // 「既知の未対応は事前分岐・フォールバックではない」）。存在検査のみで起動はしない。
    const resolveChromium = deps.resolveChromium ?? resolveChromiumBin;
    const chromium = resolveChromium();
    if (!chromium.ok) {
      // I-2: 退避理由を呼び出し元（renderApi → UI）へ一本化して伝える。
      onIneligible(chromium.kind);
      console.warn('[sme] 撮影エンジン（chrome-headless-shell）が見つからないためテロップ等の native 撮影を見送ります（Remotion 経路へ退避・setup を再実行で導入）');
      return null;
    }
    // projectId が無いと撮影ページ URL も /api/asset も解決できない。従来どおり Remotion へ。
    if ((deps.capture ?? {}).projectId === undefined) return null;
    // titleStyle は明示必須（T3 申し送り）。実値が取れないなら黙って既定値へ落とさず Remotion へ退避する。
    if (timeline.titles.length > 0 && !isUsableTitleStyle(videoConfig.titleStyle)) {
      console.warn('[sme] videoConfig.titleStyle の実値が取れないためタイトルの native 撮影を見送ります（Remotion 経路へ退避）');
      return null;
    }
  }

  /**
   * fade 色の適格性（C-1・codex-review P2）。**図形ラスタライズより前**に見る。
   *
   * 旧コードは色レイヤ合成（`applySceneFadeLayers` → `ffmpegColor`）の throw を捕まえて
   * plan null にしていたが、その時点で `.shape-{i}-{token}.png` は書き出し済みで、
   * plan（＝cleanup の持ち主）も prepareCapture も返らないため残骸が out/ に溜まっていた。
   * 判定は色文字列だけを見る（ラスタライズの結果に依存しない）ので、順序を入れ替えても
   * 判定結果は変わらない。
   */
  const badFade = sceneFades.find((f) => ffmpegColorOrNull(f.color) === null);
  if (badFade !== undefined) {
    console.warn(
      `[sme] シーン転換の色 "${badFade.color}" を native で描けません（Remotion 経路へ退避・#RRGGBB / #RGB / CSS 基本 16 色のみ）`,
    );
    return null;
  }

  /**
   * 図形 PNG の撮影（出力解像度で全画面1枚・M1d 設計判断5）。inputIndexBase は
   * 「1(main) + 音声 extraInputs 数」（applyAudioMix の `[i+1:a]` 添字には一切触れない・設計判断6）。
   *
   * **M-1（中間レビュー）**: ここに `+ videoLayers.length` の補正を足していたが、この値を使う
   * `applyShapeOverlays` 呼び出しは `videoLayers.length === 0` の分岐でしか通らないので
   * 補正は**常に 0**（計画書 T3「赤にならなかった軸 2」で撤回済みと記録した内容）。
   * 記録と実装を一致させ、補正を落とした。サブ動画があるときの index は
   * `composeOverlayChains`（`videosBase` を検算する側）が持つ。
   */
  const inputIndexBase = 1 + audioExtraInputs.length;
  /**
   * 一時ファイル 1 個の削除（deps.capture?.removeDir を流用し、テストのスパイ差し替えと
   * 挙動を統一する。既定は fs.rmSync force:true）。plan.cleanup（非撮影経路）と
   * **plan が返らない退避経路の後始末**（C-1(b)）の両方がこれを使う。
   */
  const removeFile = deps.capture?.removeDir ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const shapePngPaths: string[] = [];
  const shapeOverlays: ShapeOverlay[] = [];
  /**
   * 書き出し済みの図形 PNG を消す（C-1(b)）。plan を返さずに抜ける経路は cleanup の
   * 持ち主が居ないので、ここで消さないと out/ に残骸が溜まる（ベストエフォート）。
   */
  const removeShapePngs = (): void => {
    for (const p of shapePngPaths) {
      try {
        removeFile(p);
      } catch {
        // 後始末の失敗で退避判断は変えない。
      }
    }
  };
  // M-1: ラスタライズ・PNG 書き出し・applyShapeOverlays の失敗を図形処理全体でまとめて
  // 捕捉し plan 不成立（Remotion 経路への退避）に落とす。範囲は図形処理ブロックだけに
  // 留める（前段の音声ミックス等・後段の filterScript 書き出しは巻き込まない）。
  try {
    for (let i = 0; i < timeline.shapes.length; i += 1) {
      const shape = timeline.shapes[i]!;
      const png = rasterize(shape, target.width, target.height);
      // M-2: renderApi.ts:62 の一時出力規約（out/ 配下はドット始まり）に合わせる。
      // M-4: ジョブ token を混ぜて名前空間を分離する。
      const pngPath = join(projectDir, 'out', `.shape-${i}-${jobToken}.png`);
      writeBinary(pngPath, png);
      shapePngPaths.push(pngPath);
      shapeOverlays.push({
        startFrame: shape.startFrame,
        endFrame: shape.endFrame,
        durationFrames: shape.endFrame - shape.startFrame,
      });
    }
    // applyShapeOverlays は applyAudioMix の後（設計判断: T3 の合成不干渉 pin と同順）。
    // 撮影オーバーレイがある場合はここでは積まず、撮影段が画像→図形→telop+title の順で
    // まとめて1回だけ積む（既存経路のスクリプトは1文字も変えない）。
    // M4 T3: サブ動画があるときは z 順（サブ動画 → 図形 → 色レイヤ）を一度に積む必要があるため
    // ここでは積まず、下の composeOverlayChains へ委ねる（サブ動画 0 件なら従来どおり・受入 E）。
    if (!needsCapture && videoLayers.length === 0) {
      // M-1: **この分岐は `videoLayers.length === 0` でしか通らない**——図形群は音声 extraInputs の
      // 直後に並ぶ（サブ動画の本数ぶんの順送りは起きえない）。分岐条件そのものが不変条件。
      script = applyShapeOverlays(script, shapeOverlays, videoConfig.fps, inputIndexBase);
    }
  } catch (err) {
    // 無言退避にしない: 契約違反（[outv] 一意性・durationFrames 不変条件）のバグが
    // 「なぜか Remotion 経路になる」現象に化けて発見不能になるのを防ぐ。
    console.warn('[sme] 図形オーバーレイの native 合成に失敗（Remotion 経路へ退避）:', err);
    removeShapePngs(); // C-1(b): 途中まで書き出した PNG を残さない。
    return null;
  }

  // 画像入力の -t は図形ごとの長さ（durationFrames）を秒に変換した値（framerate は共通で videoConfig.fps）。
  const shapePngInputs = shapePngPaths.map((p, i) => ({
    path: p,
    image: { framerate: videoConfig.fps, durationSec: sec(shapeOverlays[i]!.durationFrames, videoConfig.fps) },
  }));

  // M-4: ジョブ token を混ぜて名前空間を分離する（.shape-*.png と同じ理由）。
  const filterScript = join(projectDir, 'out', `cut-filter-${jobToken}.txt`);
  /**
   * 検収は 2 本立て（I-2）: フレーム数（尺）と**出力寸法**。受入 F の事故は
   * 「フレーム数は合っているのに寸法が素材のまま」だったので、寸法検査が無いと素通しになる。
   */
  const verify = (out: string, expected: number): string | null =>
    verifyCutFramesStrict(out, expected, probeFrameCount) ?? verifyOutputSize(out, target, probeSize);
  type ExtraInput = Parameters<typeof buildFastCutArgs>[0]['extraInputs'];
  const buildArgs = (extraInputs: ExtraInput): string[] =>
    buildFastCutArgs({
      input: join(projectDir, 'public', videoConfig.videoFile),
      filterScript,
      output,
      options,
      target,
      hardware,
      extraInputs,
    });

  /**
   * fade 色レイヤ（fadeBlack/fadeWhite/fadeColor）の合成位置は
   * **図形鎖の後・撮影 PNG（telop+title）鎖の前**（設計判断5・64f5fd4）。
   * 非撮影経路には撮影 PNG が無いので、図形鎖（applyShapeOverlays 済み）の後段＝最後に掛ける。
   * sceneFades が空なら script は1文字も変わらない。
   */
  const withSceneFades = (s: string): string =>
    applySceneFadeLayers(s, sceneFades, videoConfig.fps, target, totalFrames);

  /**
   * 非撮影経路の入力 index 割当（M4 T3）。撮影オーバーレイが無いので画像・telop+title は 0 件で、
   * `imagesBase === videosBase`（＝サブ動画群が音声の直後）になる。
   * composeOverlayChains は `videosBase === imagesBase + imageLayers.length` を検算する。
   */
  const nonCaptureBases = computeOverlayInputIndexBase({
    audioInputCount: audioExtraInputs.length,
    imagesCount: 0,
    videosCount: videoLayers.length,
    shapesCount: shapeOverlays.length,
    telopTitleCount: 0,
  });

  if (!needsCapture) {
    let faded: string;
    try {
      /**
       * M4 T3: サブ動画があるときは overlay 鎖を composeOverlayChains へ一本化する
       * （z 順 サブ動画 → 図形 → 色レイヤ を1か所が持つ・正典⑦）。撮影オーバーレイは
       * 無い経路なので imageLayers / telopTitleLayers は空。
       * サブ動画 0 件なら従来どおり `withSceneFades(script)` で 1 文字も変わらない（受入 E）。
       */
      faded = videoLayers.length === 0
        ? withSceneFades(script)
        : composeOverlayChains({
            script,
            fps: videoConfig.fps,
            imageLayers: [],
            videoLayers,
            shapeLayers: shapeOverlays.map((o) => ({ kind: 'static', ...o })),
            telopTitleLayers: [],
            sceneFades,
            imagesBase: nonCaptureBases.imagesBase,
            videosBase: nonCaptureBases.videosBase,
            telopTitleBase: nonCaptureBases.telopTitleBase,
            size: target,
            totalFrames,
          });
    } catch (err) {
      // 無言退避にしない（[outv] 一意性・色形式の契約違反を握り潰さない）。
      // M-3: この catch は `composeOverlayChains` **全体**（サブ動画・図形・色レイヤ・撮影 PNG）を
      // 包んでいる。「色レイヤ」と名指しすると、サブ動画の配線ミスが
      // 「シーン転換の失敗」として報告されて原因追跡が遠回りになる。
      console.warn('[sme] オーバーレイ合成（サブ動画・図形・シーン転換の色レイヤ）に失敗（Remotion 経路へ退避）:', err);
      removeShapePngs(); // C-1(b): 色の適格性は前段で見ているが、他の契約違反でもここへ来る。
      return null;
    }
    write(filterScript, faded);
    // 焦点再レビュー必須1: 非撮影経路には prepareCapture の tempDirs が無いため、ここで
    // plan.cleanup として持たせる（removeFile は図形 PNG 書き出しの前で解決済み）。
    return {
      verify,
      // 入力順は z 順と1対1（音声 → サブ動画 → 図形 PNG・M4 正典⑦）。
      args: buildArgs([...audioExtraInputs, ...videoInsertInputs, ...shapePngInputs]),
      totalFrames,
      target,
      cleanup: () => {
        for (const p of [...shapePngPaths, filterScript]) {
          try {
            removeFile(p);
          } catch {
            // ベストエフォート: 後始末の失敗で書き出し結果を壊さない。
          }
        }
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 撮影段（M2c 設計判断5）— テロップ / タイトル / 挿入画像がある経路
  // ---------------------------------------------------------------------------
  const captureDeps = deps.capture ?? {};
  // projectId の非 undefined は上の適格性チェック（ラスタライズ前・P2）で確定済み。
  const projectId = captureDeps.projectId as string;
  const needsTelopComponent = timeline.telops.length > 0;
  const needsImageComponent = timeline.images.length > 0;
  /**
   * Node 側の run 分類に要る部品の解決（M2c T5b で既定実体を配線）。注入があればそちらが正
   * （テストのスパイ差し替えは温存）。要らない部品は読まない（タイトルのみのプロジェクトは
   * ファイルに触れずに null 部品で成立する＝従来どおり）。読み込み失敗は throw して
   * prepare の ok:false へ流し、renderJob が Remotion 経路へフォールバックする。
   */
  const loadComponents =
    captureDeps.loadComponents ??
    (async (): Promise<LoadedComponents> => {
      const result = await loadOverlayComponentsForPlanner(projectDir, {
        telop: needsTelopComponent,
        image: needsImageComponent,
      });
      if (!result.ok) throw new Error(`${result.message}（種別: ${result.kind}）`);
      return result.components;
    });
  // titleStyle の有効性も上の適格性チェック（ラスタライズ前・P2）で確定済み。

  const layerJobs: CaptureLayerJob[] = [];
  if (timeline.images.length > 0) {
    /**
     * 素材 URL の解決（M2c T5b 修正1）。既定テンプレの InsertImage.tsx は
     * `segment.imageUrl ?? staticFile('images/' + segment.file)` と書かれており、
     * imageUrl が無いと **Node 側の分類**で captureRuntime.staticFile が
     * 「リゾルバ未設定」で throw する（＝挿入画像プロジェクトが常に Remotion 退避になる）。
     * エディタプレビュー（EditorComposition の InsertImageLayer）と同じく解決済み URL を
     * 別フィールドで注入する。file は元ファイル名のまま（最終 render 互換）。
     * 撮影ページへ渡す data も同一オブジェクトなので、**分類に使う DOM と撮る DOM が
     * 一致する**（シグネチャの片側保証の前提）。撮影ページ側は同じ createAssetResolver で
     * staticFile を解決しているので、生成される URL 文字列も従来と同値。
     */
    const resolveAsset = createAssetResolver(projectId);
    layerJobs.push({
      layer: 'image',
      // layers.tsx の ImageLayerData（ImageSegment 形＝startFrame/endFrame）。
      data: {
        images: timeline.images.map((i) => ({
          id: i.id,
          startFrame: i.playbackStart,
          endFrame: i.playbackEnd,
          file: i.file,
          imageUrl: resolveAsset(`images/${i.file}`),
          type: i.type,
          scale: i.scale,
          position: i.position,
          opacity: i.opacity,
          rotation: i.rotation,
          // motion は部品が適用する。落とすと高速書き出しだけ静止した絵になる（F-1）。
          motion: i.motion,
          enter: i.enter,
          exit: i.exit,
        })),
      },
      spans: mergeCaptureSpans(
        timeline.images.map((i) => ({ start: i.playbackStart, end: i.playbackEnd })),
        totalFrames,
      ),
      slug: 'image',
    });
  }
  if (timeline.telops.length > 0 || timeline.titles.length > 0) {
    layerJobs.push({
      // テロップが無ければ 'title'（CaptureTitleLayer 単体）で足りる。統合レイヤは Telop 部品を
      // 必ず要求する（renderCaptureLayer の telop-title 分岐）ため、無駄に要求しない。
      layer: needsTelopComponent ? 'telop-title' : 'title',
      data: {
        // 未対応案件ではキーを落として通常書き出し（Remotion 経路）と絵を揃える（F-1）。
        // 高速書き出しはエディタ側のラッパーで描くため、落とさないと同じ案件で
        // 書き出しエンジンごとに別の絵が出る（利用者はどちらが選ばれるか分からない）。
        telops: withoutUnsupportedKeyframes(
          timeline.telops,
          detectMotionKeysSupport(projectDir).telop,
        ),
        titles: timeline.titles,
        titleStyle: videoConfig.titleStyle,
      },
      spans: mergeCaptureSpans(
        [
          ...timeline.telops.map((t) => ({ start: t.startFrame, end: t.endFrame })),
          ...timeline.titles.map((t) => ({ start: t.startFrame, end: t.endFrame })),
        ],
        totalFrames,
      ),
      slug: 'telop-title',
    });
  }

  const planRuns = captureDeps.planCaptureRuns ?? planCaptureRuns;
  const capture = captureDeps.captureSpecifiedRuns ?? captureSpecifiedRuns;
  const buildSequence = captureDeps.buildCaptureSequenceInput ?? buildCaptureSequenceInput;
  const origin = captureDeps.serverOrigin ?? getServerOrigin;
  const removeDir = captureDeps.removeDir ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));
  /**
   * 撮影一時ディレクトリのジョブ一意識別子（レビュー Important）。
   *
   * cancel() は起動済みの Chromium を止められない（撮影は job のプロセスツリー外）。
   * 固定名だと「キャンセル → すぐ再実行」で**旧撮影が新ジョブの同名ファイルを上書きし、
   * マニフェストと中身が食い違って別フレームの絵が静かに合成される**。さらに旧 cleanup が
   * 新ジョブの連番ディレクトリごと消す。plan 1件（= ジョブ1本）につき1つの token を混ぜて
   * 名前空間を分離する（関数冒頭で生成した jobToken と同一——cut-filter.txt/.shape-*.png と
   * 同じ token を使うことで「1ジョブ分の一時ファイル群」であることが名前からも判る・M-4）。
   */
  const captureRunToken = jobToken;
  // CSS合成座標は常に原寸。画像の一様縮小は撮影DPRで最終画素数へ直接描き、
  // 小さな画像を拡大してから縮める輪郭の劣化を避ける。字幕/タイトルと非一様縮小は
  // 既存の原寸撮影→scaleを維持する。
  const captureSize = source;
  const scaleTo = target.width !== source.width || target.height !== source.height ? target : undefined;

  const prepareCapture = async (
    report: (estimate: RenderCaptureEstimate) => void,
  ): Promise<FastCutPrepareOutcome> => {
    const tempDirs: string[] = [];
    // M-4: cut-filter.txt / .shape-*.png も撮影一時ディレクトリと同じ後始末経路に乗せる
    // （shapePngPaths は planFastCut 本体で同期的に書き出し済み・filterScript はこの後
    // prepareCapture 内で書き出す。どちらも removeDir=rmSync(force:true) なので未書き出しでも
    // 安全）。
    tempDirs.push(...shapePngPaths, filterScript);
    const cleanup = (): void => {
      for (const dir of tempDirs) {
        try {
          removeDir(dir);
        } catch {
          // 一時ディレクトリの掃除失敗で書き出し結果は変えない。
        }
      }
      tempDirs.length = 0;
    };
    const failWith = (reason: string): FastCutPrepareOutcome => ({ ok: false, reason, cleanup });

    const serverUrl = origin();
    if (serverUrl === null) {
      return failWith('撮影用サーバの URL が記録されていません（エディタのサーバ未起動）');
    }
    let loaded: LoadedComponents;
    try {
      loaded = await loadComponents();
    } catch (err) {
      return failWith(`描画部品の読み込みに失敗しました: ${messageOf(err)}`);
    }

    const captureVideoConfig = {
      width: captureSize.width,
      height: captureSize.height,
      fps: videoConfig.fps,
      durationInFrames: totalFrames,
    };

    // 1) シグネチャ分類（Chromium を起動する前に撮影枚数を確定させる・設計判断1）。
    const plans: { job: CaptureLayerJob; runs: ReturnType<typeof planCaptureRuns> }[] = [];
    let distinctFrames = 0;
    /**
     * 実際に撮る枚数（全レイヤの run 総数・C-1）。`distinctFrames` は**一意シグネチャ数**で、
     * 非連続な区間に同じシグネチャが再登場すると run は分かれる（planCaptureRuns の契約：
     * スパン境界でも必ず切る）ため `capturedTotal >= distinctFrames`。進捗の分母・完了判定・
     * 予測時間はすべてこちらに揃える（distinctFrames を分母にすると最終報告が間引きに消え、
     * 残り約1分の表示が固まったままになる）。
     */
    let capturedTotal = 0;
    for (const job of layerJobs) {
      try {
        const runPlan = planRuns({
          layer: job.layer,
          data: job.data,
          videoConfig: captureVideoConfig,
          spans: job.spans,
          loaded,
        });
        distinctFrames += runPlan.distinctFrames;
        capturedTotal += runPlan.runs.length;
        plans.push({ job, runs: runPlan });
      } catch (err) {
        return failWith(`撮影計画（${job.layer}）に失敗しました: ${messageOf(err)}`);
      }
    }
    // 2) 予測時間（設計判断6: 超過しても続行し、情報として流すだけ）。
    report({ distinctFrames, capturedTotal, estimatedMs: capturedTotal * CAPTURE_MS_PER_FRAME });

    // 3) レイヤごとに撮影 → スパン単位で密連番化（1スパン=1入力）。
    const sequenceInputs: { slug: string; path: string; framerate: number; startNumber: number }[] = [];
    const sequenceLayers: { slug: string; layer: OverlayLayer }[] = [];
    // 撮影枚数の途中経過報告（M2d T3・設計判断9・申し送り⑥）: レイヤをまたいだ累積カウンタ。
    let capturedSoFar = 0;
    /**
     * 進捗整合が壊れたら**そのジョブの進捗報告だけ**を止める（I-2）。表示の不整合ごときで
     * throw して撮影全体を Remotion 退避に落とすと、**出力そのものが変わる**（副作用の
     * 大きさが釣り合わない）。warn は1回だけ（run ごとに撒かない）。
     */
    let progressBroken = false;
    for (const { job, runs: runPlan } of plans) {
      // run ゼロは「撮る対象があるのに1枚も撮れない」状態＝黙って通すと**オーバーレイ抜きの
      // 動画が静かに出る**（サブ動画の黙殺と同型）。レイヤ自体は実在オーバーレイがある時に
      // しか作られない（layerJobs の生成条件）ので、ここに来るのは spans のクリップ等で
      // 対象が消えた異常系だけ。fail-loud で Remotion 経路へ退避する。
      if (runPlan.runs.length === 0) {
        return failWith(`撮影対象（${job.layer}）の run が0本になりました（スパン: ${JSON.stringify(job.spans)}）`);
      }
      const outDir = join(projectDir, 'out', `.capture-${job.slug}-${captureRunToken}`);
      tempDirs.push(outDir);
      const baseCaptured = capturedSoFar;
      const runsForJob = runPlan.runs.length;
      let result;
      try {
        result = await capture(
          {
            serverUrl,
            layer: job.layer,
            projectId,
            data: job.data,
            width: captureSize.width,
            height: captureSize.height,
            ...(job.layer === 'image' && target.width < source.width
              && target.width * source.height === target.height * source.width
              ? { pixelRatio: target.width / source.width } : {}),
            fps: videoConfig.fps,
            durationInFrames: totalFrames,
            runs: runPlan.runs,
            outDir,
          },
          {
            // M-4: 適格性チェックで使った実体解決を撮影段へもそのまま渡す。伝播しないと
            // 「plan は deps の resolver で通したのに、撮影は resolveChromiumBin（実機の実体）で
            // 起動する」二重解決になり、テストからは「plan ok・撮影だけ chromium 不在」という
            // 実在する状況を再現できない（実機に実体がある限り撮影が通ってしまう）。
            resolveChromium: deps.resolveChromium,
            onProgress: (captured, total) => {
              if (progressBroken) return;
              // 撮影側が報告する total は「このジョブに渡した run 数」と常に一致するはず
              // （captureSpecifiedRuns は req.runs.length をそのまま返す契約）。食い違えば
              // 撮影実装のバグなので、狂った数字を UI に出し続けずに**進捗報告を止める**
              // （capturedFrames を出さなければ UI は従来文言に戻る）。撮影自体は続行する。
              if (total !== runsForJob) {
                progressBroken = true;
                console.warn(
                  `fastCutPlan: 撮影進捗の total(${total}) が run 数(${runsForJob})と一致しません（${job.layer}）。` +
                    'このジョブの進捗表示を止めます（撮影は続行）。',
                );
                return;
              }
              const cumulative = baseCaptured + captured;
              report({
                distinctFrames,
                capturedTotal,
                estimatedMs: Math.max(0, capturedTotal - cumulative) * CAPTURE_MS_PER_FRAME,
                capturedFrames: cumulative,
              });
            },
          },
        );
      } catch (err) {
        return failWith(`撮影（${job.layer}）が失敗しました: ${messageOf(err)}`);
      }
      if (!result.ok) {
        return failWith(`撮影（${job.layer}）が失敗しました[${result.kind}]: ${result.message}`);
      }
      capturedSoFar += runsForJob;
      const manifestRuns = result.manifest.runs;
      for (let s = 0; s < job.spans.length; s += 1) {
        const span = job.spans[s]!;
        // スパン→runs→frameCount の整合は構造的に保つ: run はスパン境界で必ず切れる
        // （planCaptureRuns の契約）ので、スパン内に落ちる run だけを順序どおり取り出せば
        // 先頭が span.start・末尾が span.end になる。ずれていれば buildCaptureSequenceInput が
        // spanStart と連続性の assert で fail-loud にする。
        const spanRuns: CaptureManifestRun[] = manifestRuns.filter(
          (r) => r.startFrame >= span.start && r.endFrame <= span.end,
        );
        if (spanRuns.length === 0) {
          return failWith(`撮影結果にスパン [${span.start},${span.end}) の run がありません（${job.layer}）`);
        }
        // M-2: run はスパン境界で必ず切れる契約（planCaptureRuns の設計点）を、末尾側でも
        // 明示的に検算する。先頭の欠落は spanRuns.length===0 や filter で暗黙に弾かれるが、
        // 末尾だけ欠けたケース（spanRuns はあるが最後の run がスパン終端に届いていない）は
        // これまで検出されず、buildCaptureSequenceInput の assert 頼みだった——ここで
        // fail-loud にして「末尾が静かに短い動画」を防ぐ。
        const lastSpanRun = spanRuns[spanRuns.length - 1]!;
        if (lastSpanRun.endFrame !== span.end) {
          return failWith(
            `撮影結果にスパン [${span.start},${span.end}) の末尾 run がありません` +
              `（${job.layer}・最後の run.endFrame=${lastSpanRun.endFrame}）`,
          );
        }
        const seqDir = join(projectDir, 'out', `.capture-${job.slug}-${captureRunToken}-seq${s}`);
        tempDirs.push(seqDir);
        try {
          const seq = buildSequence(spanRuns, result.manifest.pngFiles, {
            dir: seqDir,
            fps: videoConfig.fps,
            spanStart: span.start,
          });
          sequenceInputs.push({
            slug: job.slug,
            path: join(seq.dir, '%06d.png'),
            framerate: seq.framerate,
            startNumber: seq.startNumber,
          });
        } catch (err) {
          return failWith(`連番化（${job.layer}）に失敗しました: ${messageOf(err)}`);
        }
        sequenceLayers.push({
          slug: job.slug,
          layer: { kind: 'sequence', startFrame: span.start, endFrame: span.end, ...(scaleTo ? { scaleTo } : {}) },
        });
      }
    }

    // 4) z 順（画像 → 図形 → telop+title）に1回で積む。入力 index は
    //    computeOverlayInputIndexBase の順送り（音声 [i+1:a] には触れない・設計判断8）。
    const imageLayers = sequenceLayers.filter((l) => l.slug === 'image').map((l) => l.layer);
    const telopTitleLayers = sequenceLayers.filter((l) => l.slug === 'telop-title').map((l) => l.layer);
    const staticShapeLayers: OverlayLayer[] = shapeOverlays.map((o) => ({ kind: 'static', ...o }));
    const bases = computeOverlayInputIndexBase({
      audioInputCount: audioExtraInputs.length,
      imagesCount: imageLayers.length,
      // M4 T3: サブ動画群は画像の後・図形の前（正典⑦）。0 件なら割当は1つも動かない（受入 E）。
      videosCount: videoLayers.length,
      shapesCount: staticShapeLayers.length,
      telopTitleCount: telopTitleLayers.length,
    });
    // z 順は composeOverlayChains が持つ（画像 → 図形 → 色レイヤ → 撮影 PNG・設計判断5）。
    // 色レイヤが無ければ従来どおり applyOverlays 1回（ラベルも出力も従来と同一）。
    // M-3: 合成の throw（[outv] 一意性・色形式）と書き出しの I/O エラーは別 try で扱う
    // ——同じ try に入れると合成の契約違反が「書き出しに失敗」という誤った文言に畳まれる。
    let composed: string;
    try {
      composed = composeOverlayChains({
        script,
        fps: videoConfig.fps,
        imageLayers,
        videoLayers,
        shapeLayers: staticShapeLayers,
        telopTitleLayers,
        sceneFades,
        imagesBase: bases.imagesBase,
        videosBase: bases.videosBase,
        telopTitleBase: bases.telopTitleBase,
        size: target,
        totalFrames,
      });
    } catch (err) {
      return failWith(`オーバーレイの合成に失敗しました: ${messageOf(err)}`);
    }
    try {
      write(filterScript, composed);
    } catch (err) {
      return failWith(`フィルタスクリプトの書き出しに失敗しました: ${messageOf(err)}`);
    }

    const imageInputs = sequenceInputs.filter((i) => i.slug === 'image');
    const telopTitleInputs = sequenceInputs.filter((i) => i.slug === 'telop-title');
    return {
      ok: true,
      // 入力順は z 順と1対1（音声 → 画像連番 → サブ動画 → 図形 PNG → telop+title 連番・正典⑦）。
      args: buildArgs([
        ...audioExtraInputs,
        ...imageInputs.map((i) => ({ path: i.path, sequence: { framerate: i.framerate, startNumber: i.startNumber } })),
        ...videoInsertInputs,
        ...shapePngInputs,
        ...telopTitleInputs.map((i) => ({ path: i.path, sequence: { framerate: i.framerate, startNumber: i.startNumber } })),
      ]),
      cleanup,
    };
  };

  return {
    verify,
    // 暫定 args（prepare 成功時に差し替わる契約・FastCutPlan の doc 参照）。
    args: buildArgs([...audioExtraInputs, ...shapePngInputs]),
    totalFrames,
    target,
    prepareCapture,
  };
}

/**
 * ResolveChromiumFailKind と shared の FastCutIneligibleReason が同一集合であることの型検査
 * （どちらかに値を足して他方を忘れたら tsc がここで落ちる）。
 */
const REASON_TYPE_CHECK: FastCutIneligibleReason = 'chromium-missing' as ResolveChromiumFailKind;
void REASON_TYPE_CHECK;

export type { FastCutIneligibleReason };

/** planFastCutDetailed の戻り値。plan が null の理由が撮影エンジンなら ineligible が付く。 */
export interface FastCutPlanOutcome {
  plan: FastCutPlan | null;
  /**
   * 撮影経路に入れなかった理由（撮影エンジンの解決失敗のみ・受入 C）。
   * projectId 無し・titleStyle 不正などの他の非適格は undefined のまま
   * （UI は従来文言へ落ちる）。
   */
  ineligible?: FastCutIneligibleReason;
}

/**
 * 高速書き出し計画を、退避理由つきで立てる（M2d T2 修正 I-2・受入 C）。
 * 理由値の正本はここ 1 か所——UI の文言も API の kind もこの値から導く。
 */
export function planFastCutDetailed(
  projectDir: string,
  options: RenderOptions,
  output: string,
  deps: Parameters<typeof planFastCutImpl>[3] = {},
): FastCutPlanOutcome {
  let ineligible: FastCutIneligibleReason | undefined;
  const plan = planFastCutImpl(projectDir, options, output, deps, (reason) => {
    ineligible = reason;
  });
  return ineligible === undefined ? { plan } : { plan, ineligible };
}

/** 既存呼び出し側のための薄いラッパ（戻り値も引数も従来どおり）。 */
export function planFastCut(
  projectDir: string,
  options: RenderOptions,
  output: string,
  deps: Parameters<typeof planFastCutImpl>[3] = {},
): FastCutPlan | null {
  return planFastCutDetailed(projectDir, options, output, deps).plan;
}
