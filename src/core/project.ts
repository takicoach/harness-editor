import { cutRegionsFromCutData, playbackTotalFrames } from './cutEngine';
import {
  buildCutOrdering, cutOrderFromCutData,
  reorderSe, reorderStartEnd, unreorderSe, unreorderStartEnd,
} from './cutOrder';
import { parseCutData, serializeCutData } from './cutData';
import { anchorImages, clampImages, projectImages } from './imageEngine';
import { parseInsertImageData, serializeInsertImageData } from './insertImageData';
import { anchorVideoInserts, clampVideoInserts, projectVideoInserts } from './videoInsertEngine';
import { parseInsertVideoData, serializeInsertVideoData } from './insertVideoData';
import { anchorBgm, clampBgm, projectBgm } from './bgmEngine';
import { parseBgmData, serializeBgmData } from './bgmData';
import { applyDuckingToBgm } from './ducking';
import { anchorTitles, clampTitles, projectTitles } from './titleEngine';
import { parseTitleData, serializeTitleData, TITLE_DATA_TEMPLATE } from './titleData';
import { parseProjectConfig } from './projectConfig';
import { parseSeData, serializeSeData } from './seData';
import { anchorSe, clampSe, projectSe } from './seAnchor';
import { parseTelopData, serializeTelopData } from './telopData';
import { anchorTelops, clampTelops, projectTelops } from './telopEngine';
import { parseTranscript } from './transcript';
import { parseVideoConfig } from './videoConfig';
import { anchorShapes, clampShapes, projectShapes } from './shapeEngine';
import { parseInsertShapeData, serializeInsertShapeData } from './insertShapeData';
import { anchorSceneTransitions, computeJoins, projectSceneTransitions, resolveSceneTransitions } from './joinEngine';
import { parseTransitionData, serializeTransitionData } from './transitionData';
import { buildOverlaps, finalToPlayback, playbackToFinal } from './transitionEngine';
import { collapseStartEnd, uncollapseStartEnd } from './sceneCollapse';
import { parseSpeedData, serializeSpeedData } from './speedData';
import { parseMainLayoutFile, serializeMainLayoutData } from './mainLayoutData';
import { DEFAULT_MAIN_LAYOUT } from './mainLayout';
import {
  scaleStartEnd, scaleSe, scaleVideoInserts, unscaleStartEnd, unscaleSe, unscaleVideoInserts,
  scaleStartEndPiecewise, scaleSePiecewise, scaleVideoInsertsPiecewise,
  unscaleStartEndPiecewise, unscaleSePiecewise, unscaleVideoInsertsPiecewise,
} from './speedProject';
import { clampMainSpeed, resolveSpeedSegments } from './speedEngine';
import type { EditorProject, SegmentLayout } from './types';

/** loadProject が受け取るプロジェクトファイルの内容一式。 */
export interface ProjectFiles {
  videoConfigSource: string;
  telopDataSource: string;
  cutDataSource: string | null;
  transcriptJson: string;
  projectConfigJson: string | null;
  /** seData.ts の内容。ファイル不在なら null。 */
  seDataSource: string | null;
  /** insertImageData.ts の内容。ファイル不在なら null。 */
  insertImageDataSource: string | null;
  /** insertVideoData.ts の内容。ファイル不在 or 未供給なら null。任意（サーバが未対応でも壊れない）。 */
  videoInsertDataSource?: string | null;
  /** bgmData.ts の内容。ファイル不在 or 未供給なら null。任意（サーバが未対応でも壊れない）。 */
  bgmDataSource?: string | null;
  /** titleData.ts の内容。ファイル不在なら null。 */
  titleDataSource: string | null;
  /** shapeData.ts の内容。ファイル不在 or 未供給なら null。任意（サーバが未対応でも壊れない）。 */
  shapeDataSource?: string | null;
  /** transitionData.ts の内容。ファイル不在 or 未供給なら null。任意（サーバが未対応でも壊れない）。 */
  transitionDataSource?: string | null;
  /** speedData.ts の内容。ファイル不在なら null。 */
  speedDataSource?: string | null;
  /** mainLayoutData.ts の内容。ファイル不在なら null。 */
  mainLayoutDataSource?: string | null;
}

/** プロジェクトファイル群を EditorProject へ束ねる。 */
export function loadProject(files: ProjectFiles): EditorProject {
  const videoConfig = parseVideoConfig(files.videoConfigSource);
  // mainSpeed と区間速度マップを先に解決して、各 parse 結果の unscale に使う。
  const { mainSpeed: r, segmentSpeeds: rawSegSpeeds } = parseSpeedData(files.speedDataSource ?? null);
  const { layout: mainLayout, segmentLayouts: segmentLayoutsRaw, layoutKeyframes: layoutKeyframesRaw } = parseMainLayoutFile(
    files.mainLayoutDataSource ?? null,
  );
  const projectConfig = files.projectConfigJson
    ? parseProjectConfig(files.projectConfigJson)
    : null;
  const transcript = parseTranscript(files.transcriptJson);

  const cutData = parseCutData(files.cutDataSource);
  // 空の cutData.ts（cutData: []）は「全カット」を意味する。cutDataSource が null
  // （ファイル自体が無い）の「カット無し」とは区別する。
  const cutRegions =
    files.cutDataSource !== null && cutData.length === 0
      ? [{ start: 0, end: videoConfig.durationFrames }]
      : cutRegionsFromCutData(cutData, videoConfig.durationFrames);
  // cutData.ts の配列順＝再生順。削除区間モデルでは表せないので別に保持する（案A）。
  const cutOrder = cutOrderFromCutData(cutData);
  const ordering = buildCutOrdering(videoConfig.durationFrames, cutRegions, cutOrder);

  // transitionData は再生座標で保存されているため、そのまま buildOverlaps へ渡せる（循環なし）。
  // overlaps が空（transitionData 無し or overlap 系 0 件）なら uncollapseStartEnd は恒等。
  const parsedTransitions = parseTransitionData(files.transitionDataSource ?? null, videoConfig.fps);
  // 並び替え後の再生順区間（恒等順列なら applyCuts の出力と同一）。
  const cutSegments = ordering.segments;
  const overlaps = buildOverlaps(parsedTransitions, cutSegments);

  // 速度逆射影ヘルパ: 個別指定ありなら区分線形、なければ一律（cutSegments が resolve の基準）。
  // M-1: serialize と同基準で「実在 cutSegment に効く個別指定があるか」を判定する（phantom id 除外）。
  // I-2: serialize がトランジションあり時に uniform で焼いているため、load も uniform で戻す（round-trip 対称）。
  const effectivePerSegLoad = cutSegments.some((s) => {
    const o = rawSegSpeeds[s.id];
    return o !== undefined && clampMainSpeed(o) !== clampMainSpeed(r);
  });
  const hasTransitionsLoad = parsedTransitions.length > 0;
  const usePiecewiseLoad = effectivePerSegLoad && !hasTransitionsLoad;
  const loadSpeedSegs = usePiecewiseLoad ? resolveSpeedSegments(cutSegments, r, rawSegSpeeds) : null;
  const unscaleSE_ = <U extends { startFrame: number; endFrame: number }>(items: U[]): U[] =>
    loadSpeedSegs ? unscaleStartEndPiecewise(items, loadSpeedSegs) : unscaleStartEnd(items, r);
  const unscaleSe_ = <U extends { startFrame: number; endFrame?: number }>(items: U[]): U[] =>
    loadSpeedSegs ? unscaleSePiecewise(items, loadSpeedSegs) : unscaleSe(items, r);
  const unscaleVI_ = <U extends { startFrame: number; endFrame: number; playbackRate?: number }>(items: U[]): U[] =>
    loadSpeedSegs ? unscaleVideoInsertsPiecewise(items, loadSpeedSegs) : unscaleVideoInserts(items, r);

  // 各データは最終座標で保存されているため、anchorX へ渡す前に:
  //   1) unscale（速度スケールを逆適用して再生座標へ戻す）
  //   2) uncollapse（overlap 分の詰めを逆適用して再生座標へ戻す）
  //   3) unreorder（並び替えを逆適用して単調＝原素材順の再生座標へ戻す）
  // の順で適用する。rate===1 / overlaps=[] / 恒等順列 のいずれも恒等なので既存テストに影響なし。
  const rawTelops = unreorderStartEnd(
    uncollapseStartEnd(
      unscaleSE_(
        parseTelopData(files.telopDataSource, videoConfig.fps, videoConfig.durationFrames),
      ),
      overlaps,
    ),
    ordering,
  );
  const telops = anchorTelops(rawTelops, cutRegions);

  // SE は endFrame? 省略可能（undefined）なので uncollapseStartEnd の汎用型に通せない。
  // 個別に finalToPlayback を適用し、endFrame undefined は undefined のまま通過させる。
  // unscaleSe_ で速度座標 → 再生座標へ戻してから uncollapse する。
  const parsedSe = unscaleSe_(parseSeData(files.seDataSource));
  const uncollapsedSe = overlaps.length === 0
    ? parsedSe
    : parsedSe.map((s) => ({
        ...s,
        startFrame: finalToPlayback(s.startFrame, overlaps),
        endFrame: s.endFrame !== undefined ? finalToPlayback(s.endFrame, overlaps) : undefined,
      }));
  const se = anchorSe(unreorderSe(uncollapsedSe, ordering), cutRegions);

  const images = anchorImages(
    unreorderStartEnd(
      uncollapseStartEnd(
        unscaleSE_(parseInsertImageData(files.insertImageDataSource, videoConfig.fps)),
        overlaps,
      ),
      ordering,
    ),
    cutRegions,
  );
  const videoInserts = anchorVideoInserts(
    unreorderStartEnd(
      uncollapseStartEnd(
        unscaleVI_(parseInsertVideoData(files.videoInsertDataSource ?? null, videoConfig.fps)),
        overlaps,
      ),
      ordering,
    ),
    cutRegions,
  );
  const bgm = anchorBgm(
    unreorderStartEnd(
      uncollapseStartEnd(
        unscaleSE_(parseBgmData(files.bgmDataSource ?? null)),
        overlaps,
      ),
      ordering,
    ),
    cutRegions,
  );

  const rawTitles = files.titleDataSource
    ? unreorderStartEnd(
        uncollapseStartEnd(
          unscaleSE_(
            parseTitleData(files.titleDataSource, videoConfig.fps, videoConfig.durationFrames),
          ),
          overlaps,
        ),
        ordering,
      )
    : [];
  const titles = anchorTitles(rawTitles, cutRegions);

  const shapes = anchorShapes(
    unreorderStartEnd(
      uncollapseStartEnd(
        unscaleSE_(parseInsertShapeData(files.shapeDataSource ?? null)),
        overlaps,
      ),
      ordering,
    ),
    cutRegions,
  );

  // transitionData は再生座標のまま anchorSceneTransitions へ渡す（据え置き）。
  const sceneTransitions = anchorSceneTransitions(
    parsedTransitions,
    computeJoins(videoConfig.durationFrames, cutRegions, ordering),
  );

  return {
    videoConfig,
    projectConfig,
    transcript,
    telops,
    cutRegions,
    cutOrder,
    se,
    images,
    telopDataSource: files.telopDataSource,
    cutDataSource: files.cutDataSource,
    seDataSource: files.seDataSource,
    insertImageDataSource: files.insertImageDataSource,
    videoInserts,
    videoInsertDataSource: files.videoInsertDataSource ?? null,
    bgm,
    bgmDataSource: files.bgmDataSource ?? null,
    titles,
    titleDataSource: files.titleDataSource,
    shapes,
    shapeDataSource: files.shapeDataSource ?? null,
    sceneTransitions,
    transitionDataSource: files.transitionDataSource ?? null,
    mainSpeed: r,
    segmentSpeeds: (() => {
      // applyCuts 結果（cutSegments）に存在しない区間 id は stale（削除済み）として破棄する。
      // cutSegments はエディタが区間速度を割り当てる id ソースと同一なので、必ずこちらで照合する。
      const validIds = new Set(cutSegments.map((s) => s.id));
      const filtered: Record<number, number> = {};
      for (const [k, v] of Object.entries(rawSegSpeeds)) {
        if (validIds.has(Number(k))) filtered[Number(k)] = v;
      }
      return filtered;
    })(),
    mainLayout,
    segmentLayouts: (() => {
      // applyCuts 結果（cutSegments）に存在しない区間 id は stale（削除済み）として破棄する。
      const validIds = new Set(cutSegments.map((s) => s.id));
      const filtered: Record<number, SegmentLayout> = {};
      for (const [k, v] of Object.entries(segmentLayoutsRaw)) {
        if (validIds.has(Number(k))) filtered[Number(k)] = v;
      }
      return filtered;
    })(),
    // 大域キーフレームはカット区間 id に紐付かない（originalFrame アンカー）ため、区間 stale フィルタは不要。
    // 動画尺を超える originalFrame だけ安全側でクランプする。
    layoutKeyframes: layoutKeyframesRaw.map((kf) => ({
      ...kf,
      originalFrame: Math.min(Math.max(0, kf.originalFrame), Math.max(0, videoConfig.durationFrames)),
    })),
  };
}

/** EditorProject の編集結果を telopData.ts / cutData.ts / seData.ts / insertImageData.ts / insertVideoData.ts / bgmData.ts / titleData.ts / shapeData.ts / transitionData.ts のソースへ書き戻す。 */
export function serializeProject(project: EditorProject): {
  telopDataSource: string;
  cutDataSource: string;
  seDataSource: string | null;
  insertImageDataSource: string | null;
  videoInsertDataSource: string | null;
  bgmDataSource: string | null;
  /** 元ファイルが存在するか、保存すべきタイトルがある場合のみ非 null。孤立ファイル防止のため 0 件・元ソース null なら null を返す（bgm 等と対称）。 */
  titleDataSource: string | null;
  /** 元ファイルが存在するか、保存すべき図形がある場合のみ非 null。孤立ファイル防止のため 0 件・元ソース null なら null を返す（bgm 等と対称）。 */
  shapeDataSource: string | null;
  /** 元ファイルが存在するか、保存すべきトランジションがある場合のみ非 null。孤立ファイル防止のため 0 件・元ソース null なら null を返す（shape 等と対称）。 */
  transitionDataSource: string | null;
  /** mainSpeed=1 なら null（ファイル不要）、それ以外は speedData.ts ソース。 */
  speedDataSource: string | null;
  /** 完全既定（全画面・黒）なら null（ファイル不要）、それ以外は mainLayoutData.ts ソース。 */
  mainLayoutDataSource: string | null;
} {
  const original = project.videoConfig.durationFrames;
  const rate = project.mainSpeed; // 速度最外段スケール係数（下の resolved.map((r)=>...) の r とは別物）
  // 再生順アンカーから並び替えを再導出する（恒等順列なら applyCuts の出力そのもの＝従来と同一）。
  const ordering = buildCutOrdering(original, project.cutRegions, project.cutOrder);
  const cutSegments = ordering.segments;
  const cutTotal = playbackTotalFrames(original, project.cutRegions);

  // 区間ごと速度が「実質」効いているか。効いていれば区分線形 segs を構築し、
  // スケール関数を差し替える（uniform は既存パス＝バイト同値）。
  const segSpeeds = project.segmentSpeeds ?? {};
  // M-1: cutData に実在する区間 id のみを対象に「有効な個別指定」を判定する。
  // phantom id（cutData に無い id）は applyCuts の出力に現れないため、
  // resolveSpeedSegments が全区間を base speed で埋めてしまい uniform と等価になる。
  // hasPerSegmentSpeed（全値チェック）との分岐を防ぐため、実在 id のみで判定する。
  const effectivePerSeg = cutSegments.some((s) => {
    const o = segSpeeds[s.id];
    return o !== undefined && clampMainSpeed(o) !== clampMainSpeed(rate);
  });
  // overlaps: crossfade/slide/wipe 系のつなぎ目による最終座標の詰め量を計算する。
  // transitionData が無いか overlap 系が 0 件なら overlaps = [] → collapseStartEnd は恒等。
  const joins = computeJoins(original, project.cutRegions, ordering);
  const resolved = resolveSceneTransitions(project.sceneTransitions ?? [], joins);
  const playbackTransitions = resolved.map((r) => ({ ...r.transition, at: r.playbackFrame }));
  const overlaps = buildOverlaps(playbackTransitions, cutSegments);

  // 範囲外テロップを寄せてから再生フレームへ射影する。
  const { telops, flaggedIds } = clampTelops(project.telops, project.cutRegions);
  const projected = projectTelops(telops, project.cutRegions);

  // flagged（カット区間に完全に飲まれた）テロップにだけ originalStart/originalEnd を付与する。
  // 再生フレームが潰れていても再読込時に原本区間を復元できるようにする（I-1 修正）。
  const flaggedSet = new Set(flaggedIds);
  const projectedWithOriginalPlayback = projected.map((seg) => {
    if (!flaggedSet.has(seg.id)) return seg;
    // 原本区間は project.telops（未加工の原本アンカー＝正）から引く。clamp 後の値ではない。
    const source = project.telops.find((t) => t.id === seg.id);
    if (source === undefined) return seg;
    return { ...seg, originalStart: source.originalStart, originalEnd: source.originalEnd };
  });
  // 単調再生フレーム → 並び替え後の再生フレーム → 最終フレームへ写す
  // （originalStart/End は ...x スプレッドで不変。恒等順列なら reorderStartEnd は恒等）。
  const projectedWithOriginal = collapseStartEnd(
    reorderStartEnd(projectedWithOriginalPlayback, ordering),
    overlaps,
  );

  // 画像も clamp してから再生フレームへ射影する。
  const { images: clampedImages } = clampImages(project.images, project.cutRegions);

  // サブ動画も clamp してから再生フレームへ射影する。
  const { videoInserts: clampedVideoInserts } = clampVideoInserts(
    project.videoInserts ?? [],
    project.cutRegions,
  );

  // BGM も clamp してから再生フレームへ射影する。
  const { bgm: clampedBgm } = clampBgm(
    project.bgm ?? [],
    project.cutRegions,
  );

  // タイトルも clamp してから再生フレームへ射影する（telop と同型・ただし position/style 等は無し）。
  // I-1 修正: TitleSegment は下流の上流スキーマに originalStart/End が無いため、
  // flagged であっても originalStart/End を書き出さない（telop と異なり title は標準型を保持）。
  const { titles: clampedTitles } = clampTitles(
    project.titles ?? [],
    project.cutRegions,
  );
  const projectedTitlesPlayback = projectTitles(clampedTitles, project.cutRegions);
  const projectedTitles = collapseStartEnd(reorderStartEnd(projectedTitlesPlayback, ordering), overlaps);
  // 元ファイルが存在するか、保存すべきタイトルがある場合のみ書き出す（bgm と対称）。
  // 0 件かつ titleDataSource:null → 孤立ファイル防止のため null を返す。
  const titleOutput =
    project.titleDataSource !== null || (project.titles ?? []).length > 0
      ? serializeTitleData(project.titleDataSource ?? TITLE_DATA_TEMPLATE, projectedTitles)
      : null;

  // 図形も clamp してから再生フレームへ射影する（bgm/title と同じパターン）。
  const { shapes: clampedShapes } = clampShapes(
    project.shapes ?? [],
    project.cutRegions,
  );
  const projectedShapesPlayback = projectShapes(clampedShapes, project.cutRegions);
  const projectedShapes = collapseStartEnd(reorderStartEnd(projectedShapesPlayback, ordering), overlaps);
  // 元ファイルが存在するか、保存すべき図形がある場合のみ書き出す。
  // 0 件かつ shapeDataSource:null → 孤立ファイル防止のため null を返す。
  const shapeOutput = serializeInsertShapeData(
    project.shapeDataSource ?? null,
    projectedShapes,
  );

  // SE も clamp してから再生フレームへ射影し、最終フレームへ写す。
  // SoundEffect.endFrame は省略可能（undefined）なので collapseStartEnd の汎用型に通せない。
  // playbackToFinal を直接使い、endFrame undefined は undefined のまま通過させる。
  const sePlayback = reorderSe(
    projectSe(clampSe(project.se, project.cutRegions).se, project.cutRegions),
    ordering,
  );
  const seCollapsed = overlaps.length === 0
    ? sePlayback
    : sePlayback.map((s) => ({
        ...s,
        startFrame: playbackToFinal(s.startFrame, overlaps),
        endFrame: s.endFrame !== undefined ? playbackToFinal(s.endFrame, overlaps) : undefined,
      }));

  // 各インライン射影を最終座標化（const に切り出して collapseStartEnd を通す）。
  const imagesPlayback = projectImages(clampedImages, project.cutRegions);
  const imagesCollapsed = collapseStartEnd(reorderStartEnd(imagesPlayback, ordering), overlaps);

  const videoInsertsPlayback = projectVideoInserts(clampedVideoInserts, project.cutRegions);
  const videoInsertsCollapsed = collapseStartEnd(reorderStartEnd(videoInsertsPlayback, ordering), overlaps);

  const bgmPlayback = applyDuckingToBgm(
    projectBgm(clampedBgm, project.cutRegions),
    project.transcript.words,
    project.cutRegions,
    project.videoConfig.fps,
    project.ducking,
  );
  const bgmCollapsed = collapseStartEnd(reorderStartEnd(bgmPlayback, ordering), overlaps);

  // トランジションを原本フレームから再生フレームへ射影してから直列化する。
  // transitionData は再生座標のまま据え置き（at は overlaps の定義元）。
  // 0 件かつ transitionDataSource:null → 孤立ファイル防止のため null を返す（shape と対称）。
  const projectedTransitions = projectSceneTransitions(
    project.sceneTransitions ?? [],
    computeJoins(original, project.cutRegions, ordering),
  );
  const transitionOutput = serializeTransitionData(
    project.transitionDataSource ?? null,
    projectedTransitions,
  );

  // I-2（修正）: hasTransitions を「実際に書き出す transitions 集合」基準へ変える。
  // 孤立トランジション（join に一致しない at）は projectSceneTransitions でドロップされるため、
  // projectedTransitions.length で判定することで load 側（parsedTransitions.length > 0）と対称になる。
  // ここに配置することで projectedTransitions（孤立ドロップ済み）を参照できる。
  const hasTransitions = projectedTransitions.length > 0;
  const usePiecewise = effectivePerSeg && !hasTransitions;
  // cutSegments は playbackStart/playbackEnd を持つので resolveSpeedSegments にそのまま渡せる。
  const speedSegs = usePiecewise ? resolveSpeedSegments(cutSegments, rate, segSpeeds) : null;
  const scaleSE_ = <U extends { startFrame: number; endFrame: number }>(items: U[]): U[] =>
    speedSegs ? scaleStartEndPiecewise(items, speedSegs) : scaleStartEnd(items, rate);
  const scaleSe_ = <U extends { startFrame: number; endFrame?: number }>(items: U[]): U[] =>
    speedSegs ? scaleSePiecewise(items, speedSegs) : scaleSe(items, rate);
  const scaleVI_ = <U extends { startFrame: number; endFrame: number; playbackRate?: number }>(items: U[]): U[] =>
    speedSegs ? scaleVideoInsertsPiecewise(items, speedSegs) : scaleVideoInserts(items, rate);

  return {
    // 速度スケール: uniform (usePiecewise=false) は既存 scaleStartEnd(_, rate) と同一＝バイト同値。
    // 個別指定ありのとき区分線形 scaleSE_/scaleSe_/scaleVI_ を使う。
    // cut/transition は不変（速度非依存）。
    telopDataSource: serializeTelopData(project.telopDataSource, scaleSE_(projectedWithOriginal)),
    cutDataSource: serializeCutData(project.cutDataSource, cutSegments, original, cutTotal),
    seDataSource: serializeSeData(project.seDataSource, scaleSe_(seCollapsed)),
    insertImageDataSource: serializeInsertImageData(
      project.insertImageDataSource,
      scaleSE_(imagesCollapsed),
    ),
    videoInsertDataSource: serializeInsertVideoData(
      project.videoInsertDataSource ?? null,
      scaleVI_(videoInsertsCollapsed),
    ),
    bgmDataSource: serializeBgmData(scaleSE_(bgmCollapsed), project.bgmDataSource ?? null),
    // titleOutput / shapeOutput は「0件かつ元ソース null → null」の判定のみに使用。
    // 非 null のときは速度スケール済み配列で再生成する。
    titleDataSource: titleOutput === null
      ? null
      : serializeTitleData(project.titleDataSource ?? TITLE_DATA_TEMPLATE, scaleSE_(projectedTitles)),
    shapeDataSource: shapeOutput === null
      ? null
      : serializeInsertShapeData(project.shapeDataSource ?? null, scaleSE_(projectedShapes)),
    transitionDataSource: transitionOutput,
    speedDataSource: serializeSpeedData(project.mainSpeed, project.segmentSpeeds),
    mainLayoutDataSource: serializeMainLayoutData(
      project.mainLayout ?? DEFAULT_MAIN_LAYOUT,
      project.segmentLayouts ?? {},
      project.layoutKeyframes ?? [],
    ),
  };
}
