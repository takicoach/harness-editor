import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { resizeCutRegion, cutRange, openCutRange, splitTelopWithText, addTelopAtFrame, addSubtitleAtFrame, subtitleInsertSpan, cutButtonMode } from '../edit/cutOps';
import { telopAtFrame } from '../../core/segmentOps';
import { buildWordChips } from '../../core/wordChips';
import { isTranscriptAlignedWithVideo } from '../../core/transcript';
import { moveTelop, setTelopTiming, removeTelops } from '../edit/telopSettingsOps';
import { clearMultiSelection, toggleMultiTelopSelection } from '../edit/editState';
import { addSe, moveSe, resizeSe, selectSe, setSeFadeIn, setSeFadeOut, finalizeAddedSe } from '../edit/seOps';
import { addImage, moveImage, retimeImage, selectImage } from '../edit/imageOps';
import { addVideoInsert, moveVideoInsert, retimeVideoInsert, selectVideoInsert, videoInsertMaxEnd } from '../edit/videoInsertOps';
import { addBgm, moveBgm, resizeBgm, selectBgm, setBgmFadeIn, setBgmFadeOut, normalizeBgmVolume } from '../edit/bgmOps';
import { clampImages } from '../../core/imageEngine';
import { clampVideoInserts } from '../../core/videoInsertEngine';
import { clampBgm } from '../../core/bgmEngine';
import { useTimelineDrag } from '../timeline/useTimelineDrag';
import { commitInPointDrag } from './inPointDrag';
import type { CutHandleId } from '../timeline/CutTrack';
import type { TelopHandleId, TelopOverride } from '../timeline/TelopTrack';
import { SeTrack, type SeHandleId, type SeOverride } from '../timeline/SeTrack';
import { ImageTrack, type ImageHandleId, type ImageOverride } from '../timeline/ImageTrack';
import { VideoInsertTrack, type VideoInsertHandleId, type VideoInsertOverride } from '../timeline/VideoInsertTrack';
import { BgmTrack, type BgmHandleId, type BgmOverride } from '../timeline/BgmTrack';
import { ShapeTrack, type ShapeHandleId, type ShapeOverride } from '../timeline/ShapeTrack';
import { clampShapes } from '../../core/shapeEngine';
import { moveShapeTime, retimeShape, selectShape } from '../edit/shapeOps';
import type { PlayerRef } from '@remotion/player';
import type { Ref, RefObject } from 'react';
import { applyInsertMaterial } from '../edit/insertMaterial';
import { useDropdown } from '../useDropdown';
import type { MaterialKind } from './materialList';
import { playbackTotalFrames, originalToPlayback, playbackToOriginal, normalizeCutRegions, materialBounds } from '../../core/cutEngine';
import { cutOrderingOf } from '../../core/cutOrder';
import type { CutOrdering } from '../../core/types';
import type { PlaybackOverlap } from '../../core/transitionEngine';
import { speedScale, speedTotalFrames, type SpeedSegment } from '../../core/speedEngine';
import { playbackToPlayer, playerToPlayback } from '../../preview/speedBridge';
import { timelineOverlaps } from './timelineCoords';
import type { EditorProject, CutRegion, EditorTelop, EditorVideoInsert, WordChip } from '../../core/types';
import type { EditSession } from '../useEditSession';
import { formatClock } from '../../shared/format';
import { clampZoom, frameToXMapped, widthMapped, xToFrameMapped, TRACK_LABEL_GUTTER_PX } from '../timeline/timelineGeometry';
import { buildDisplayMap, type DisplayMap } from '../../core/timelineDisplayMap';
import { edgeScrollFrameScale, edgeScrollSpeed, edgeScrollVelocity, followScrollLeft, wheelAction, zoomAnchoredScrollLeft } from '../timeline/timelineScroll';
import { nextPlaybackRate, playbackRateLabel, type TransportKey } from '../preview/transport';
import { collectSnapTargets, snapFrameMapped, type SnapTarget } from '../timeline/snapping';
import { pulseKeysForChange } from '../timeline/cutPulse';
import { resolveCutHandle } from '../timeline/timelineBodyHelpers';
import { useTimelineEdgeDrag } from '../timeline/useTimelineEdgeDrag';
import { clampSe } from '../../core/seAnchor';
import { useWaveformSamples } from '../audio/useWaveformSamples';
import { TimelineRuler } from '../timeline/TimelineRuler';
import { CutTrack } from '../timeline/CutTrack';
import type { WaveformPref } from '../layout/waveformPref';
import { TelopTrack } from '../timeline/TelopTrack';
import { DragTooltip } from '../timeline/DragTooltip';
import { TimelineResizer } from '../layout/TimelineResizer';
import { splitTelops } from '../timeline/splitTelops';
import { JoinMarkers } from '../timeline/JoinMarkers';
import { computeJoins } from '../../core/joinEngine';
import { selectJoin } from '../edit/transitionOps';

export interface TimelineDropApi {
  /** client 座標が timeline スクロール領域内ならその位置へ素材を挿入し true。領域外なら false。 */
  dropMaterial(kind: MaterialKind, file: string, clientX: number, clientY: number): boolean;
}

interface TimelineProps {
  /** 編集セッション（null ならプロジェクト未選択）。 */
  session: EditSession | null;
  /** 読込時の不変 EditorProject（原本総フレーム・transcript の取得元）。 */
  baseProject: EditorProject | null;
  /** プレビュープレイヤー参照（再生ヘッド追従・シーク用。Task 10/11 で使用）。 */
  playerRef: RefObject<PlayerRef | null>;
  /** public/se/ にある効果音ファイル名（＋SE ボタン用）。 */
  seLibrary: string[];
  /** public/images/ にある画像ファイル相対パス（＋画像ボタン用）。 */
  imageLibrary: string[];
  /** public/ にあるサブ動画ファイル相対パス（＋サブ動画ボタン用）。 */
  videoLibrary: string[];
  /**
   * サブ動画素材の実フレーム長（file → frames）。区間リサイズを素材内へクランプするのに使う。
   * プローブ未完了・読めない素材はキーごと存在せず、その場合はクランプしない（従来挙動）。
   */
  videoDurations: Record<string, number>;
  /** public/BGM/ にある BGM ファイル相対パス（＋BGM ボタン用）。 */
  bgmLibrary: string[];
  /** 波形デコード用の動画 URL（= /api/video?…）。空なら波形なし。 */
  videoUrl: string;
  /** asset URL 用のプロジェクト ID（SE/BGM 波形・サムネのデコード）。 */
  projectId: string;
  /** ライブラリ各ファイルの size-mtime トークン。asset URL の &v=（同名差し替えバスト）用。 */
  assetVersions?: Record<string, string>;
  /** 双方向ハイライト中の原本フレーム区間（null なら非表示）。 */
  highlightRange: { start: number; end: number } | null;
  /** ハイライト区間の更新（hover でセット・離脱で null）。 */
  onHighlightRange: (range: { start: number; end: number } | null) => void;
  /** 素材ドラッグのドロップ受け口（App が保持）。 */
  dropApiRef?: Ref<TimelineDropApi>;
  /** 区間ごと速度の区間（null なら一律 mainSpeed）。playbackToPlayer/playerToPlayback で使う。 */
  speedSegments: SpeedSegment[] | null;
  /** カット確認モード（プレビューがカット未適用＝原本恒等再生）。 */
  cutsBypassed: boolean;
  /** カット確認モードの切替。 */
  onToggleCutsBypassed: () => void;
  /** 波形の高さ設定（standard/large）。未指定時は 'standard' 扱い。 */
  waveformPref?: WaveformPref;
  /** JKL トランスポートの再生速度（負＝逆再生）。Preview の Player へそのまま渡る。 */
  playbackRate: number;
  /** 再生速度の更新（J/K/L 押下時）。 */
  onPlaybackRateChange: (rate: number) => void;
}

interface TimelineBodyProps {
  session: EditSession;
  baseProject: EditorProject;
  playerRef: RefObject<PlayerRef | null>;
  seLibrary: string[];
  imageLibrary: string[];
  /** public/ にあるサブ動画ファイル相対パス（＋サブ動画ボタン用）。 */
  videoLibrary: string[];
  /**
   * サブ動画素材の実フレーム長（file → frames）。区間リサイズを素材内へクランプするのに使う。
   * プローブ未完了・読めない素材はキーごと存在せず、その場合はクランプしない（従来挙動）。
   */
  videoDurations: Record<string, number>;
  /** public/BGM/ にある BGM ファイル相対パス（＋BGM ボタン用）。 */
  bgmLibrary: string[];
  /** 波形デコード用の動画 URL（= /api/video?…）。空なら波形なし。 */
  videoUrl: string;
  /** asset URL 用のプロジェクト ID（SE/BGM 波形・サムネのデコード）。 */
  projectId: string;
  /** ライブラリ各ファイルの size-mtime トークン。asset URL の &v=（同名差し替えバスト）用。 */
  assetVersions?: Record<string, string>;
  /** 双方向ハイライト中の原本フレーム区間（null なら非表示）。 */
  highlightRange: { start: number; end: number } | null;
  /** ハイライト区間の更新（hover でセット・離脱で null）。 */
  onHighlightRange: (range: { start: number; end: number } | null) => void;
  /** 素材ドラッグのドロップ受け口（App が保持）。 */
  dropApiRef?: Ref<TimelineDropApi>;
  /** 区間ごと速度の区間（null なら一律 mainSpeed）。playbackToPlayer/playerToPlayback で使う。 */
  speedSegments: SpeedSegment[] | null;
  cutsBypassed: boolean;
  onToggleCutsBypassed: () => void;
  waveformPref?: WaveformPref;
  /** JKL トランスポートの再生速度（負＝逆再生）。Preview の Player へそのまま渡る。 */
  playbackRate: number;
  /** 再生速度の更新（J/K/L 押下時）。 */
  onPlaybackRateChange: (rate: number) => void;
}

/** タイムラインの初期ズーム（1 フレームあたりピクセル数）。 */
const DEFAULT_PX_PER_FRAME = 1;

/**
 * 前面に出るモーダル・チュートリアルの目印。表示中は JKL・←→ のトランスポート操作を止め、
 * モーダル側のキー操作（←→ でページ送り等）に譲る。プレビュー上の常設オーバーレイ
 * （.pv-overlay）はモーダルではないので含めない。
 */
const MODAL_SELECTOR = '.help-overlay, .export-overlay, .hjc-overlay, .diff-review-overlay, .tut';

/**
 * プロジェクトが必ず存在する前提のタイムライン本体。
 * すべてのフックをここで呼ぶことで Rules of Hooks を満たす（早期 return なし）。
 */
// 矢印キー微調整の対象つまみ。カット端 or テロップ端 or SE ピン or 画像ブロックの合併型。
type SelectedHandle =
  | { kind: 'cut'; handle: CutHandleId }
  | { kind: 'telop'; handle: TelopHandleId }
  | { kind: 'se'; handle: SeHandleId }
  | { kind: 'image'; handle: ImageHandleId }
  | { kind: 'videoInsert'; handle: VideoInsertHandleId }
  | { kind: 'bgm'; handle: BgmHandleId }
  | { kind: 'shape'; handle: ShapeHandleId };

function TimelineBody({
  session,
  baseProject,
  playerRef,
  seLibrary,
  imageLibrary,
  videoLibrary,
  videoDurations,
  bgmLibrary,
  videoUrl,
  projectId,
  assetVersions,
  highlightRange,
  onHighlightRange,
  dropApiRef,
  speedSegments,
  cutsBypassed,
  onToggleCutsBypassed,
  waveformPref,
  playbackRate,
  onPlaybackRateChange,
}: TimelineBodyProps) {
  const [pxPerFrame, setPxPerFrame] = useState(DEFAULT_PX_PER_FRAME);

  // 波形サンプル（URL ごとに 1 回デコード・失敗時 null）。
  const waveformSamples = useWaveformSamples(videoUrl === '' ? null : videoUrl);

  // プレイヤーの現在の再生フレーム。frameupdate イベントで更新する。
  const [playbackFrame, setPlaybackFrame] = useState(0);

  // 直近のドラッグで吸着したターゲット（ガイド線表示用）。吸着していなければ null。
  const [snapHit, setSnapHit] = useState<SnapTarget | null>(null);

  // 矢印キー微調整の対象つまみ。
  const [selectedHandle, setSelectedHandle] = useState<SelectedHandle | null>(null);

  // tl-body の DOM 参照。Ctrl/Cmd+ホイールズーム用に { passive: false } のネイティブリスナを張る。
  const bodyRef = useRef<HTMLDivElement>(null);

  // ＋追加メニュー（効果音/画像/サブ動画/BGM/テロップの挿入を集約）。
  const addMenu = useDropdown();

  // 押せないボタンをクリックした時に「なぜ押せないか」を表示する一時ヒント（4秒で自動消滅）。
  const [toolHint, setToolHint] = useState<string | null>(null);
  useEffect(() => {
    if (toolHint === null) return;
    const t = setTimeout(() => setToolHint(null), 4000);
    return () => clearTimeout(t);
  }, [toolHint]);

  const { state } = session;

  /**
   * サブ動画クリップを素材内へ収める originalEnd の上限。
   * 実尺が分かっていない素材（プローブ未完了・読めない）は undefined＝クランプなし。
   * リサイズ 3 経路（端ドラッグ・矢印キー・インスペクタ数値）で同じ式を使う。
   */
  function videoInsertEndLimit(clip: EditorVideoInsert, start: number): number | undefined {
    // カット区間を渡す: 消費量は再生尺×速度で決まる（原本尺で測ると過剰にクランプする）。
    return videoInsertMaxEnd(clip, videoDurations[clip.file], start, state.cutRegions);
  }
  function videoInsertEndLimitById(id: number, start: number): number | undefined {
    const clip = state.videoInserts.find((v) => v.id === id);
    return clip === undefined ? undefined : videoInsertEndLimit(clip, start);
  }

  // 新規追加されたカット区間を 500ms パルスさせる（EditState 外のローカル state で追跡）。
  // I-1: pulseKeysForChange で「本数増加のみ」を新規追加とみなし、端調整の誤発火を除外。
  // I-2: バッチごとに独立したタイマーを立て、古いキーが Set に残留しないよう管理する。
  const prevRegionsRef = useRef<CutRegion[]>(state.cutRegions);
  const [pulseKeys, setPulseKeys] = useState<Set<string>>(() => new Set());
  // アクティブなタイマー ID 集合。アンマウント時に一括クリアする。
  const pulseTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // パルス検出: cutRegions が変わるたびに呼ばれるが、cleanup ではタイマーをキャンセルしない。
  // キャンセルすると「1 回目のキーが永久残留する」バグが再現する（I-2 修正）。
  useEffect(() => {
    const added = pulseKeysForChange(prevRegionsRef.current, state.cutRegions);
    prevRegionsRef.current = state.cutRegions;
    if (added.length === 0) return;
    // このバッチのキーを追加。
    setPulseKeys((cur) => {
      const next = new Set(cur);
      for (const k of added) next.add(k);
      return next;
    });
    // このバッチ専用のタイマーを 1 本立て、500ms 後にこのバッチのキーだけを削除する。
    const timerId = setTimeout(() => {
      setPulseKeys((cur) => {
        const next = new Set(cur);
        for (const k of added) next.delete(k);
        return next;
      });
      pulseTimersRef.current.delete(timerId);
    }, 500);
    pulseTimersRef.current.add(timerId);
    // cleanup ではタイマーをキャンセルしない（バッチ独立管理のため）。
  }, [state.cutRegions]);

  // アンマウント時のみ全タイマーを一括クリア。
  useEffect(() => {
    return () => {
      for (const id of pulseTimersRef.current) clearTimeout(id);
    };
  }, []);

  // マグネット吸着の ON/OFF。既定 ON。
  const [snapEnabled, setSnapEnabled] = useState(true);
  // ドラッグ中の Alt 押下を ref で追跡する（吸着を一時解除する）。
  const altHeldRef = useRef(false);
  useEffect(() => {
    function down(e: KeyboardEvent): void {
      if (e.key === 'Alt') altHeldRef.current = true;
    }
    function up(e: KeyboardEvent): void {
      if (e.key === 'Alt') altHeldRef.current = false;
    }
    // Alt+Tab 等でフォーカスを失うと keyup が届かず固着するためリセットする。
    function reset(): void {
      altHeldRef.current = false;
    }
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', reset);
    };
  }, []);

  const fps = baseProject.videoConfig.fps;

  // ---- アンカー固定ズーム ----------------------------------------------------
  // ズームすると「今いる場所」が画面外へ飛ぶ問題への対処。拡縮の前後で固定点
  // （ボタン＝再生ヘッド / ホイール＝マウス位置）が画面上の同じ位置に留まるよう
  // scrollLeft を補正する。補正はレイアウト確定後（scrollWidth が新ズーム幅に
  // なった後）でないと計算できないため、アンカーを ref に預けて useLayoutEffect で適用する。
  const zoomStateRef = useRef({ pxPerFrame, playheadOriginal: 0, displayMap: undefined as DisplayMap | undefined });
  const pendingZoomRef = useRef<{ anchorContentX: number; viewportOffset: number; prevPxPerFrame: number } | null>(null);
  const zoomAnchoredRef = useRef<(factor: number, anchorClientX?: number) => void>(() => {});
  zoomAnchoredRef.current = (factor: number, anchorClientX?: number): void => {
    const { pxPerFrame: cur, playheadOriginal: head, displayMap: map } = zoomStateRef.current;
    const next = clampZoom(cur * factor);
    if (next === cur) return;
    const el = bodyRef.current;
    if (el) {
      let anchorContentX: number;
      let viewportOffset: number;
      if (anchorClientX === undefined) {
        // ボタンズーム＝再生ヘッド（＝今の秒数）を固定点にする。
        // ヘッドが画面外なら、この機会に可視域の中央へ引き寄せる。
        anchorContentX = frameToXMapped(head, cur, map);
        const onScreen = anchorContentX - el.scrollLeft;
        viewportOffset = onScreen >= 0 && onScreen <= el.clientWidth ? onScreen : el.clientWidth / 2;
      } else {
        viewportOffset = anchorClientX - el.getBoundingClientRect().left;
        anchorContentX = el.scrollLeft + viewportOffset;
      }
      pendingZoomRef.current = { anchorContentX, viewportOffset, prevPxPerFrame: cur };
    }
    setPxPerFrame(next);
  };

  // ズーム反映後（レイアウト確定後・描画前）に scrollLeft を補正する。
  useLayoutEffect(() => {
    const pending = pendingZoomRef.current;
    pendingZoomRef.current = null;
    const el = bodyRef.current;
    if (pending === null || el === null || pending.prevPxPerFrame <= 0) return;
    el.scrollLeft = zoomAnchoredScrollLeft({
      anchorContentX: pending.anchorContentX,
      viewportOffset: pending.viewportOffset,
      ratio: pxPerFrame / pending.prevPxPerFrame,
      gutter: TRACK_LABEL_GUTTER_PX,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    });
  }, [pxPerFrame]);

  // React 18 は onWheel を passive リスナとして登録するため e.preventDefault() が無視される。
  // { passive: false } を明示したネイティブリスナで登録し、ブラウザのページズームを抑止する。
  // 判定は純粋関数 wheelAction に委譲（縦ホイール＝縦スクロールで素材トラックを上下に閲覧、
  // Shift＋縦＝横パン、Ctrl/Cmd＝ズーム）。zoom は functional updater なので依存配列は [] でよい。
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const handler = (e: WheelEvent): void => {
      const action = wheelAction(e);
      if (action.kind === 'zoom') {
        e.preventDefault();
        // ホイールズームはマウス位置を固定点にする（見ている場所が動かない）。
        zoomAnchoredRef.current(action.factor, e.clientX);
      } else if (action.kind === 'pan') {
        e.preventDefault();
        el.scrollLeft += action.dx;
      }
      // native: 何もしない（縦スクロール・横スワイプはブラウザ標準に委ねる）。
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // タイムライン上でポインタドラッグが進行中か（下の「端ドラッグ自動スクロール」の
  // ブロックで毎レンダ書き込む）。ホバー版の共存ガードがここを読む。
  // 宣言だけ先に置くのは、ホバー版の useEffect（すぐ下）から参照するため。
  const timelineDragActiveRef = useRef(false);

  // 端ホバー自動スクロール。マウス（横スワイプ不可）で右端より先を見るための操作。
  // カーソルを可視域の左右端へ寄せている間だけ、寄せた深さに応じた速度で横スクロールする。
  // pointermove は window で拾う（ドラッグ中は setPointerCapture で掴んだ要素へ配送されるため、
  // コンテナに貼ると効かなくなる）。速度が 0 の間は rAF を回さない。
  //
  // **ドラッグ中は休止する**（共存ガード）。端スクロールは 2 段構成で、待機中（非ドラッグ）は
  // このホバー版、ドラッグ確定後は下の「端ドラッグ自動スクロール」が担当する。window で
  // 拾う設計上ホバー版はドラッグ中も走ってしまい、放置すると同じ scrollLeft を 2 つの
  // 書き手が奪い合う。さらに **armed 前（ドラッグ確定前）でも休止**させる必要がある——
  // ここで scrollLeft が動くと「端ゾーンのブロックをクリックしただけで区間が動く」
  // （2026-08-17 に潰した事故）がホバー版という別経路で復活するため。
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let speed = 0;
    let raf = 0;
    let last = 0;

    const step = (now: number): void => {
      const dt = last === 0 ? 0 : (now - last) / 1000;
      last = now;
      if (speed === 0 || timelineDragActiveRef.current) {
        raf = 0;
        last = 0;
        return;
      }
      // 再生追従と競合させない（再生中はヘッドが scrollLeft を持つ）。
      if (!isPlayingRef.current) el.scrollLeft += speed * dt;
      raf = requestAnimationFrame(step);
    };

    const onMove = (e: PointerEvent): void => {
      // ドラッグ中は速度を持たない（ループも起こさない）。離して次に動かせば復帰する。
      // ボタンが押されている間も同様。タイムライン外で始まったドラッグが端を通過した
      // だけで走り出さないため（ref はタイムライン内のドラッグしか知らない）。
      if (timelineDragActiveRef.current || e.buttons !== 0) {
        speed = 0;
        return;
      }
      speed = edgeScrollSpeed({
        pointerX: e.clientX,
        pointerY: e.clientY,
        rect: el.getBoundingClientRect(),
        gutter: TRACK_LABEL_GUTTER_PX,
      });
      if (speed !== 0 && raf === 0) raf = requestAnimationFrame(step);
    };
    const stop = (): void => { speed = 0; };
    // ポインタがウィンドウの外へ出た時だけ止める。`pointerout` が
    // `relatedTarget === null` で来るのが「文書の外へ出た」の正規の signal。
    // （`pointerleave` は非バブルなので window に貼っても実質発火しない＝d0a4f89 の穴。）
    //
    // **鮮度（最後の move から N ms）で止めてはいけない。** ホバー版は「カーソルを端に
    // 置いたまま待つ」操作で、可視域内でカーソルを止めている間ブラウザは pointermove を
    // 出さない。実測（Chromium・e2e「待機中」）: 200ms の鮮度ガードを入れると 244px で
    // 打ち切られ、外すと 300px 超まで伸びた＝鮮度ガードは機能そのものを殺す。
    const stopIfLeftWindow = (e: PointerEvent): void => {
      if (e.relatedTarget === null) speed = 0;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerout', stopIfLeftWindow, true);
    // 押した瞬間に止める。ドラッグ開始が React の再レンダ経由で
    // timelineDragActiveRef へ届くまでの 1 フレームでも、掴んだ後にコンテンツが動くと
    // クリック/ドラッグ判定の実移動がずれる（getAutoScrollDx はドラッグ版の量しか数えない）。
    //
    // **capture phase で拾う**。React 18 はルート要素へ委譲するため、ブロック・つまみ・
    // ルーラーの `beginDrag` が呼ぶ `stopPropagation()` は window の bubble リスナまで殺す
    // ＝本命の経路でこのガードが不発になる。とくに `.tl-cut-fab-btn` は stopPropagation
    // するのにドラッグを始めない（＝ドラッグ状態 ref も立たない）唯一の要素で、右端ゾーンで
    // 押している間ホバー版が走り続けると FAB がカーソルの下から逃げてカットが黙って落ちる。
    window.addEventListener('pointerdown', stop, true);
    window.addEventListener('pointerleave', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerout', stopIfLeftWindow, true);
      window.removeEventListener('pointerdown', stop, true);
      window.removeEventListener('pointerleave', stop);
      window.removeEventListener('blur', stop);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, []);

  // 再生追従スクロール。再生中だけ、再生ヘッドの X を可視域の anchor 位置へ毎フレーム寄せる。
  // isPlaying と「最新の pxPerFrame / cutRegions / overlaps」を ref で読み、frameupdate 購読を貼り直さない。
  // overlaps は totalFrames 定義後（下）に算出し followRef.current へ入れる。
  const isPlayingRef = useRef(false);
  // pause 購読（依存 [baseProject]）から最新の速度変更ハンドラを呼ぶための ref。
  const rateChangeRef = useRef(onPlaybackRateChange);
  rateChangeRef.current = onPlaybackRateChange;
  // displayMap は初回レンダ設定時のみ undefined。onFrame 発火前に必ず本体で最新値へ更新される（frameToXMapped は undefined を恒等扱い）。
  const followRef = useRef({ pxPerFrame, cutRegions: state.cutRegions, ordering: undefined as CutOrdering | undefined, overlaps: [] as PlaybackOverlap[], mainSpeed: state.mainSpeed, speedSegments: speedSegments as SpeedSegment[] | null, displayMap: undefined as DisplayMap | undefined });

  // プレイヤーの frameupdate を購読し、再生ヘッド位置を追従させる。
  // あわせて play/pause を購読し、再生中だけ横スクロールを再生ヘッドへ滑らかに追従させる。
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (e: { detail: { frame: number } }): void => {
      // frame は Remotion プレイヤーからの「速度後・最終」フレーム。
      // playerToPlayback で再生フレームへ戻し、playbackFrame state（再生座標）に保存する。
      // seekToOriginal と対称。
      const frame = e.detail.frame;
      const { pxPerFrame: ppf, cutRegions, ordering, overlaps: ovs, mainSpeed, speedSegments: segs, displayMap: dm } = followRef.current;
      const playback = playerToPlayback(frame, { speedSegments: segs, playbackOverlaps: ovs, mainSpeed });
      setPlaybackFrame(playback);
      // 再生中のみ横スクロールを追従させる（一時停止・手動シーク中は触らない）。
      if (!isPlayingRef.current) return;
      const el = bodyRef.current;
      if (!el) return;
      const orig = playbackToOriginal(playback, cutRegions, ordering);
      const playheadX = frameToXMapped(orig, ppf, dm);
      el.scrollLeft = followScrollLeft(playheadX, el.clientWidth, el.scrollWidth);
    };
    const onPlay = (): void => { isPlayingRef.current = true; };
    // 停止したら再生速度を等速へ戻す（早送り・巻き戻しは「再生中だけの状態」）。
    // 端まで巻き戻して自動停止した時も、次の再生が意図せず 8 倍速にならない。
    const onPause = (): void => {
      isPlayingRef.current = false;
      rateChangeRef.current(1);
    };
    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    player.addEventListener('ended', onPause);
    return () => {
      player.removeEventListener('frameupdate', onFrame);
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
      player.removeEventListener('ended', onPause);
    };
    // playerRef は useRef の安定オブジェクトのため依存不要。
    // baseProject が変わる＝プロジェクト開き直し＝Preview 再マウントなので、それを契機に再購読する。
  }, [baseProject]);

  // 選択中つまみを ←/→ で 1 フレーム微調整する（spec §8）。
  useEffect(() => {
    if (selectedHandle === null) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      // 入力欄フォーカス中はテキストのキャレット移動に委ねる。
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target?.isContentEditable ?? false)
      ) {
        return;
      }
      if (selectedHandle === null) return;
      e.preventDefault();
      const delta = e.key === 'ArrowLeft' ? -1 : 1;
      if (selectedHandle.kind === 'cut') {
        const { region, edge } = selectedHandle.handle;
        const cur = edge === 'start' ? region.start : region.end;
        const movedFrame = cur + delta;
        const nextState = resizeCutRegion(state, region, edge, movedFrame);
        session.apply(nextState);
        // 矢印キー後に selectedHandle を実在区間へ再同期（I-1・I-2 修正）。
        // マージが発生した場合もマージ後の実区間を指すため、旧座標ベースの計算を廃止。
        const resolved = resolveCutHandle(nextState.cutRegions, edge, movedFrame);
        setSelectedHandle(resolved === null ? null : { kind: 'cut', handle: resolved });
      } else if (selectedHandle.kind === 'telop') {
        const { telopId, edge } = selectedHandle.handle;
        const telop = state.telops.find((t) => t.id === telopId);
        if (telop === undefined) return;
        if (edge === 'body') {
          session.apply(moveTelop(state, telopId, telop.originalStart + delta));
        } else if (edge === 'start') {
          session.apply(setTelopTiming(state, telopId, telop.originalStart + delta, telop.originalEnd));
        } else {
          session.apply(setTelopTiming(state, telopId, telop.originalStart, telop.originalEnd + delta));
        }
      } else if (selectedHandle.kind === 'se') {
        const { seId, edge } = selectedHandle.handle;
        const se = state.se.find((s) => s.id === seId);
        if (se === undefined) return;
        if (edge === 'body') {
          session.apply(moveSe(state, seId, se.originalStart + delta));
        } else if (edge === 'start') {
          session.apply(resizeSe(state, seId, se.originalStart + delta, se.originalEnd));
        } else if (edge === 'end') {
          session.apply(resizeSe(state, seId, se.originalStart, se.originalEnd + delta));
        } else if (edge === 'fadeIn') {
          session.apply(setSeFadeIn(state, seId, Math.max(0, (se.fadeInFrames ?? 0) + delta)));
        } else if (edge === 'fadeOut') {
          session.apply(setSeFadeOut(state, seId, Math.max(0, (se.fadeOutFrames ?? 0) + delta)));
        }
      } else if (selectedHandle.kind === 'image') {
        const { imageId, edge } = selectedHandle.handle;
        const img = state.images.find((i) => i.id === imageId);
        if (img === undefined) return;
        if (edge === 'body') {
          session.apply(moveImage(state, imageId, img.originalStart + delta));
        } else if (edge === 'start') {
          session.apply(retimeImage(state, imageId, img.originalStart + delta, img.originalEnd));
        } else {
          session.apply(retimeImage(state, imageId, img.originalStart, img.originalEnd + delta));
        }
      } else if (selectedHandle.kind === 'videoInsert') {
        const { videoInsertId, edge } = selectedHandle.handle;
        const vi = state.videoInserts.find((v) => v.id === videoInsertId);
        if (vi === undefined) return;
        if (edge === 'body') {
          session.apply(moveVideoInsert(state, videoInsertId, vi.originalStart + delta));
        } else if (edge === 'start') {
          const start = vi.originalStart + delta;
          session.apply(
            retimeVideoInsert(state, videoInsertId, start, vi.originalEnd, videoInsertEndLimit(vi, start)),
          );
        } else {
          session.apply(
            retimeVideoInsert(
              state,
              videoInsertId,
              vi.originalStart,
              vi.originalEnd + delta,
              videoInsertEndLimit(vi, vi.originalStart),
            ),
          );
        }
      } else if (selectedHandle.kind === 'bgm') {
        const { bgmId, edge } = selectedHandle.handle;
        const clip = state.bgm.find((b) => b.id === bgmId);
        if (clip === undefined) return;
        if (edge === 'body') {
          session.apply(moveBgm(state, bgmId, clip.originalStart + delta));
        } else if (edge === 'start') {
          session.apply(resizeBgm(state, bgmId, clip.originalStart + delta, clip.originalEnd));
        } else if (edge === 'end') {
          session.apply(resizeBgm(state, bgmId, clip.originalStart, clip.originalEnd + delta));
        } else if (edge === 'fadeIn') {
          session.apply(setBgmFadeIn(state, bgmId, Math.max(0, clip.fadeInFrames + delta)));
        } else if (edge === 'fadeOut') {
          session.apply(setBgmFadeOut(state, bgmId, Math.max(0, clip.fadeOutFrames + delta)));
        }
      } else if (selectedHandle.kind === 'shape') {
        const { shapeId, edge } = selectedHandle.handle;
        const shape = state.shapes.find((s) => s.id === shapeId);
        if (shape === undefined) return;
        if (edge === 'body') {
          session.apply(moveShapeTime(state, shapeId, shape.originalStart + delta));
        } else if (edge === 'start') {
          session.apply(retimeShape(state, shapeId, shape.originalStart + delta, shape.originalEnd));
        } else {
          session.apply(retimeShape(state, shapeId, shape.originalStart, shape.originalEnd + delta));
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedHandle, session, state]);

  // トランスポート操作（JKL＋←/→ のコマ送り）。
  // - J/K/L: 巻き戻し / 一時停止 / 早送り（編集ソフト共通の並び）。押すたびに 1→2→4→8 倍。
  // - ←/→: 1 フレーム送り（Shift で 1 秒）。定規のドラッグより正確に位置を合わせるため。
  //   つまみ選択中は上の effect（つまみを 1 フレーム動かす）が優先で、こちらは何もしない。
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.isComposing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // 入力欄フォーカス中はキャレット移動・文字入力に委ねる。
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target?.isContentEditable ?? false)
      ) {
        return;
      }
      // モーダル・チュートリアル表示中はそちらのキー操作（←→ でページ送り等）に譲る。
      if (document.querySelector(MODAL_SELECTOR) !== null) return;
      const player = playerRef.current;
      if (player === null) return;

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (selectedHandle !== null) return;
        e.preventDefault();
        const step = e.shiftKey ? Math.max(1, Math.round(fps)) : 1;
        const delta = (e.key === 'ArrowLeft' ? -1 : 1) * step;
        // プレイヤー座標のまま動かす（完成尺の 1 コマ＝ユーザーが期待する 1 コマ）。
        // 上限は Player の seekTo 側でクランプされる。
        player.seekTo(Math.max(0, Math.round(player.getCurrentFrame()) + delta));
        return;
      }

      const key = e.key.toLowerCase();
      if (key !== 'j' && key !== 'k' && key !== 'l') return;
      e.preventDefault();
      const rate = nextPlaybackRate(player.isPlaying() ? playbackRate : 0, key as TransportKey);
      onPlaybackRateChange(rate);
      if (key === 'k') {
        player.pause();
      } else if (!player.isPlaying()) {
        player.play();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedHandle, fps, playerRef, playbackRate, onPlaybackRateChange]);

  const totalFrames = baseProject.videoConfig.durationFrames;
  const playbackFrames = playbackTotalFrames(totalFrames, state.cutRegions);

  // カット並び替え（再生順）の対応表。恒等順列なら従来の単調モデルと完全一致。
  const ordering = useMemo(() => cutOrderingOf(state), [state]);

  // つなぎ目マーク（JoinMarkers）用: カット後タイムラインの境界一覧（再生順で隣接する境界）。
  const joins = useMemo(
    () => computeJoins(totalFrames, state.cutRegions, ordering),
    [totalFrames, state.cutRegions, ordering],
  );

  // 残す区間（速度選択用）。区間は原本座標を持つため CutTrack と座標系が一致する。
  const keptSegments = ordering.segments;

  // 区間速度表示マップ。identity（全速度 1）なら frameToX と同一。Task 5。
  const displayMap = useMemo(
    () => buildDisplayMap(totalFrames, state.cutRegions, keptSegments, state.segmentSpeeds, state.mainSpeed),
    [totalFrames, state.cutRegions, keptSegments, state.segmentSpeeds, state.mainSpeed],
  );

  const trackWidth = frameToXMapped(totalFrames, pxPerFrame, displayMap);
  // 範囲選択カットの可能範囲＝素材（残す区間）の原本範囲。先頭/末尾のカット済み（素材なし）は選択不可。
  // カット確認モード中は「カットを開ける」で先頭/末尾のカットも対象にできるよう全域を許可する。
  const cutSelBounds = useMemo(
    () =>
      cutsBypassed
        ? { start: 0, end: totalFrames }
        : materialBounds(totalFrames, state.cutRegions),
    [cutsBypassed, totalFrames, state.cutRegions],
  );

  // カット確認モード中のプレビュー座標系。モデルはカット/場面転換/速度なしで組まれるため、
  // プレイヤーとの変換はすべて「カット無し・速度 1」で対称にする。
  const playbackRegions = useMemo(
    () => (cutsBypassed ? [] : state.cutRegions),
    [cutsBypassed, state.cutRegions],
  );
  // カット確認モード中は並び替えも効かせない（モデルがカット無しで組まれるため）。
  const playbackOrdering = cutsBypassed ? undefined : ordering;
  const playbackMainSpeed = cutsBypassed ? 1 : state.mainSpeed;

  // overlaps: sceneTransitions（at=原本）からタイムライン定規とプレイヤーの橋渡しを構築。
  // overlaps 空（カット無し or 重なる系なし）なら finalToPlayback/playbackToFinal は恒等。
  const overlaps = useMemo(
    () => (cutsBypassed ? [] : timelineOverlaps(state.sceneTransitions, totalFrames, state.cutRegions, ordering)),
    [cutsBypassed, state.sceneTransitions, totalFrames, state.cutRegions, ordering],
  );

  // followRef に最新の overlaps / mainSpeed / speedSegments / displayMap を毎レンダーで更新する（onFrame は購読を貼り直さないため ref 経由）。
  followRef.current = { pxPerFrame, cutRegions: playbackRegions, ordering: playbackOrdering, overlaps, mainSpeed: playbackMainSpeed, speedSegments, displayMap };

  function seekToOriginal(originalFrame: number): void {
    // 原本フレーム → 再生フレーム。カット区間内なら直近の非カットフレームへ丸める。
    let playback = originalToPlayback(originalFrame, playbackRegions, playbackOrdering);
    for (let probe = originalFrame - 1; playback === null && probe > 0; probe--) {
      playback = originalToPlayback(probe, playbackRegions, playbackOrdering);
    }
    // 全フレームがカット区間内の場合も probe > 0 で止まるためフォールバックは seekTo(0)（再生タイムライン先頭）。
    // 再生フレーム → プレイヤー（速度後）フレームへ変換してプレイヤーへ渡す。
    // onFrame の playerToPlayback と対称（overlaps 空・mainSpeed=1 なら恒等）。
    const speedView = { speedSegments, playbackOverlaps: overlaps, mainSpeed: playbackMainSpeed };
    playerRef.current?.seekTo(playbackToPlayer(playback ?? 0, speedView));
  }

  /** ズーム倍率を factor 倍する。固定点は再生ヘッド（今の秒数）。 */
  function zoomBy(factor: number): void {
    zoomAnchoredRef.current(factor);
  }

  // 再生フレーム → 原本フレーム。原本座標トラック上のヘッド位置に使う。
  const playheadOriginal = playbackToOriginal(playbackFrame, playbackRegions, playbackOrdering);

  // アンカー固定ズームが参照する最新値（ホイールハンドラは購読を貼り直さないため ref 経由）。
  zoomStateRef.current = { pxPerFrame, playheadOriginal, displayMap };

  // ヘッド分割時のテキスト分配用の単語チップ。transcript が動画と非整合なら空（時間比分割になる）。
  // 手動（装飾）テロップは本文が transcript と無関係なので、splitTelopWithText 側が
  // チップを無視して本文を両断片へ複製する（判定はあちらに一本化・ここで分岐しない）。
  function splitChipsFor(t: EditorTelop): WordChip[] {
    if (!isTranscriptAlignedWithVideo(baseProject.transcript, baseProject.videoConfig)) return [];
    return buildWordChips(
      { originalStart: t.originalStart, originalEnd: t.originalEnd },
      baseProject.transcript.words,
      fps,
    );
  }

  // 再生ヘッドが乗っているテロップ。
  const telopUnderHead = telopAtFrame(state.telops, playheadOriginal);
  // 「ヘッドで分割」の対象は、ヘッドが区間の内部（開始ぴったりでない）にある場合のみ。
  // 開始フレームちょうどは splitSegment が弾く（no-op）ため、ボタン/キーを無効化して
  // 空の Undo 履歴を積まないようにする。
  const splittableTelop =
    telopUnderHead !== undefined && playheadOriginal > telopUnderHead.originalStart
      ? telopUnderHead
      : undefined;

  // Task 2: じまく（字幕）とテロップ（手動）を分割する。
  const { subtitles: jimakuTelops, manuals: telopManuals } = useMemo(
    () => splitTelops(state.telops),
    [state.telops],
  );

  // tl-scroll コンテナの DOM 参照。ドラッグ時に「原本フレーム 0 の画面 X」を得るのに使う。
  const scrollRef = useRef<HTMLDivElement>(null);
  // ドラッグ開始時の原本フレーム（ツールチップの移動量の基準）。カット・テロップ・SE で独立管理する。
  const cutDragOriginRef = useRef<number>(0);
  const telopDragOriginRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  /**
   * 修飾キー＋pointerdown で「トグル候補」に入れたテロップ ID（純クリックが確定するまで保留）。
   * pointerup で純クリックだったときだけ telopDrag の onClick がこれを消費してトグルする。
   * ドラッグとして確定した場合（onCommit）は捨てる＝修飾キー＋ドラッグではトグルしない。
   */
  const telopMultiPendingRef = useRef<number | null>(null);
  const seDragOriginRef = useRef<{ start: number; end: number; fadeInFrames: number; fadeOutFrames: number }>({
    start: 0, end: 0, fadeInFrames: 0, fadeOutFrames: 0,
  });
  const bgmDragOriginRef = useRef<{ start: number; end: number; fadeInFrames: number; fadeOutFrames: number }>({
    start: 0, end: 0, fadeInFrames: 0, fadeOutFrames: 0,
  });
  function trackOriginX(): number {
    const el = scrollRef.current;
    return el ? el.getBoundingClientRect().left : 0;
  }

  // 端ドラッグ自動スクロール（edge-autoscroll）が、このドラッグ中に自分で足した scrollLeft の
  // 累積（右＝正）。useTimelineDrag のクリック/ドラッグ判定へ渡す。**自分が足した分だけ**を
  // 数える（ズーム補正・再生追従・パネル開閉による原点移動は含めない）。
  const autoScrollDxRef = useRef(0);
  function getAutoScrollDx(): number {
    return autoScrollDxRef.current;
  }

  // 素材ライブラリからのドラッグドロップ受け口。可視領域(bodyRef)内で離されたら、
  // そのX位置を原本フレーム化して対応トラックへ挿入する（既存のスクラブ幾何を流用）。
  useImperativeHandle(
    dropApiRef,
    () => ({
      dropMaterial(kind, file, clientX, clientY) {
        const el = bodyRef.current;
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
          return false;
        }
        const frame = xToFrameMapped(clientX - trackOriginX(), pxPerFrame, displayMap);
        const orig = playbackToOriginal(frame, state.cutRegions);
        session.apply(applyInsertMaterial(kind, state, file, orig));
        return true;
      },
    }),
    [session, state, pxPerFrame, displayMap],
  );

  // ルーラードラッグ＝スクラブ。drop で履歴は積まない（再生ヘッド移動のみ）。
  const scrubDrag = useTimelineDrag<'scrub'>({
    getTrackOriginX: trackOriginX,
    pxPerFrame,
    map: displayMap,
    onDrag: (_h, raw) => {
      const frame = Math.max(0, Math.min(totalFrames, raw));
      seekToOriginal(frame);
      return frame;
    },
    onCommit: () => {
      // スクラブはプレビュー移動のみ。状態コミット不要。
    },
    // onClick は意図的に未指定。コミットが空なので純クリックで呼ばれても副作用がない。
  });

  // 吸着しきい値（px ではなくフレーム）。ズームに依存させ、画面上 8px 相当にする。
  const snapThresholdFrames = Math.max(1, Math.round(8 / (pxPerFrame > 0 ? pxPerFrame : 1)));

  // 吸着＋ガイド線表示のみ（seek しない）。範囲選択ドラッグが使う。
  function snapFrameWithGuide(rawFrame: number): number {
    let frame = rawFrame;
    let target: SnapTarget | null = null;
    if (snapEnabled && !altHeldRef.current) {
      const targets = collectSnapTargets(
        baseProject.transcript,
        state.telops,
        playheadOriginal,
        fps,
      );
      const result = snapFrameMapped(rawFrame, targets, snapThresholdFrames, displayMap);
      frame = result.frame;
      target = result.snapped;
    }
    setSnapHit(target);
    return frame;
  }

  // 吸着＋ガイド線＋seek（つまみドラッグ用・従来挙動）。
  function applySnap(rawFrame: number): number {
    const frame = snapFrameWithGuide(rawFrame);
    seekToOriginal(frame);
    return frame;
  }

  // カット境界ドラッグ。ドラッグ中の見た目だけ liveCutRegions で差し替える。
  // 未使用パラメータ（_handle）は `_` 始まりにして noUnusedParameters を満たす。
  const cutDrag = useTimelineDrag<CutHandleId>({
    getTrackOriginX: trackOriginX,
    getAutoScrollDx,
    pxPerFrame,
    map: displayMap,
    onDrag: (_handle, rawFrame) => applySnap(rawFrame),
    onCommit: (handle, finalFrame) => {
      // drop で 1 回だけ履歴へ積む（1 ドラッグ = 1 Undo ステップ）。
      const nextState = resizeCutRegion(state, handle.region, handle.edge, finalFrame);
      session.apply(nextState);
      // ドラッグ後に selectedHandle を実在区間へ再同期（I-1 修正）。
      const resolved = resolveCutHandle(nextState.cutRegions, handle.edge, finalFrame);
      setSelectedHandle(resolved === null ? null : { kind: 'cut', handle: resolved });
      setSnapHit(null);
    },
    // 純クリックは選択のみ（selectedHandle は onHandleDown で設定済み・区間は動かさない）。
    onClick: () => setSnapHit(null),
  });

  // ドラッグ中のカット区間をライブ表示用に組み立てる。
  // normalizeCutRegions に通すことで、隣接区間と重なった場合のプレビューを
  // commit 結果（マージ済み）と一致させる（M-1 修正）。
  function liveCutRegions(): CutRegion[] | null {
    if (cutDrag.drag === null) return null;
    const { handle, frame } = cutDrag.drag;
    const replaced = state.cutRegions.map((r) => {
      if (r.start !== handle.region.start || r.end !== handle.region.end) return r;
      return handle.edge === 'start'
        ? { start: Math.min(frame, r.end), end: r.end }
        : { start: r.start, end: Math.max(frame, r.start) };
    });
    return normalizeCutRegions(replaced);
  }

  // テロップ端ドラッグ。ドラッグ中の見た目だけ liveTelopOverride で差し替える。
  const telopDrag = useTimelineDrag<TelopHandleId>({
    getTrackOriginX: trackOriginX,
    getAutoScrollDx,
    pxPerFrame,
    map: displayMap,
    onDrag: (_handle, rawFrame) => applySnap(rawFrame),
    // 関数形で最新状態を素材にする。pointerdown の setTransient（選択変更）が
    // まだ反映されていない古いクロージャを push して、選択を巻き戻さないため。
    onCommit: (handle, finalFrame) => {
      // ドラッグとして確定した＝トグルは行わない（修飾キー＋ドラッグ）。
      telopMultiPendingRef.current = null;
      session.apply((prev) => {
        const telop = prev.telops.find((t) => t.id === handle.telopId);
        if (telop === undefined) return prev;
        if (handle.edge === 'body') {
          return moveTelop(prev, telop.id, finalFrame);
        }
        if (handle.edge === 'start') {
          return setTelopTiming(prev, telop.id, Math.min(finalFrame, telop.originalEnd - 1), telop.originalEnd);
        }
        return setTelopTiming(prev, telop.id, telop.originalStart, Math.max(finalFrame, telop.originalStart + 1));
      });
      setSnapHit(null);
    },
    // 純クリックは選択のみ（telopHandleDown で選択済み）。履歴も積まず区間も動かさない。
    // 修飾キー＋純クリックのときだけ、ここで複数選択のトグルを確定する。
    onClick: () => {
      setSnapHit(null);
      const pending = telopMultiPendingRef.current;
      telopMultiPendingRef.current = null;
      if (pending === null) return;
      // 範囲選択カットとは相互排他（両方が同時に生きる状態を作らない）。
      setCutSelection(null);
      session.setTransient((prev) => toggleMultiTelopSelection(prev, pending));
    },
  });

  // ドラッグ中のテロップ区間をライブ表示用に組み立てる。
  function liveTelopOverride(): TelopOverride | null {
    if (telopDrag.drag === null) return null;
    const { handle, frame } = telopDrag.drag;
    const telop = state.telops.find((t) => t.id === handle.telopId);
    if (telop === undefined) return null;
    if (handle.edge === 'body') {
      const dur = telop.originalEnd - telop.originalStart;
      const clamped = Math.max(0, frame);
      return { telopId: telop.id, originalStart: clamped, originalEnd: clamped + dur };
    }
    if (handle.edge === 'start') {
      return { telopId: telop.id, originalStart: Math.min(frame, telop.originalEnd - 1), originalEnd: telop.originalEnd };
    }
    return { telopId: telop.id, originalStart: telop.originalStart, originalEnd: Math.max(frame, telop.originalStart + 1) };
  }

  // SE 区間ドラッグ。BGM と同等。
  // edge='body'    → 平行移動（moveSe）
  // edge='start'   → 左端伸縮（resizeSe）
  // edge='end'     → 右端伸縮（resizeSe）
  // edge='fadeIn'/'fadeOut' → フェード長変更（setSeFadeIn / setSeFadeOut）。
  const seDrag = useTimelineDrag<SeHandleId>({
    getTrackOriginX: trackOriginX,
    getAutoScrollDx,
    pxPerFrame,
    map: displayMap,
    onDrag: (handle, rawFrame) => {
      if (handle.edge === 'fadeIn' || handle.edge === 'fadeOut') {
        const origin = seDragOriginRef.current;
        const originFrame = handle.edge === 'fadeIn' ? origin.start : origin.end;
        const delta = rawFrame - originFrame;
        const baseFade = handle.edge === 'fadeIn' ? origin.fadeInFrames : origin.fadeOutFrames;
        const newFade = Math.max(0, Math.round(baseFade + (handle.edge === 'fadeIn' ? delta : -delta)));
        if (handle.edge === 'fadeIn') {
          session.setTransient((prev) => setSeFadeIn(prev, handle.seId, newFade));
        } else {
          session.setTransient((prev) => setSeFadeOut(prev, handle.seId, newFade));
        }
        return rawFrame;
      }
      return applySnap(rawFrame);
    },
    onCommit: (handle, finalFrame) => {
      const origin = seDragOriginRef.current;
      if (handle.edge === 'body') {
        session.apply((prev) => moveSe(prev, handle.seId, finalFrame));
      } else if (handle.edge === 'start') {
        const clampedStart = Math.min(Math.max(0, finalFrame), origin.end - 1);
        session.apply((prev) => resizeSe(prev, handle.seId, clampedStart, origin.end));
      } else if (handle.edge === 'end') {
        const clampedEnd = Math.max(origin.start + 1, finalFrame);
        session.apply((prev) => resizeSe(prev, handle.seId, origin.start, clampedEnd));
      } else if (handle.edge === 'fadeIn') {
        const startFade = origin.fadeInFrames;
        const delta = finalFrame - origin.start;
        const finalFade = Math.max(0, Math.round(startFade + delta));
        commitInPointDrag(startFade, finalFade, {
          onLive: (v) => session.setTransient((prev) => setSeFadeIn(prev, handle.seId, v)),
          onCommit: (v) => session.apply((prev) => setSeFadeIn(prev, handle.seId, v)),
        });
      } else if (handle.edge === 'fadeOut') {
        const startFade = origin.fadeOutFrames;
        const delta = finalFrame - origin.end;
        const finalFade = Math.max(0, Math.round(startFade + (-delta)));
        commitInPointDrag(startFade, finalFade, {
          onLive: (v) => session.setTransient((prev) => setSeFadeOut(prev, handle.seId, v)),
          onCommit: (v) => session.apply((prev) => setSeFadeOut(prev, handle.seId, v)),
        });
      }
      setSnapHit(null);
    },
    // 純クリックは選択のみ（onHandleDown で選択済み）。履歴も積まず区間も動かさない。
    onClick: () => setSnapHit(null),
  });

  // ドラッグ中の SE 区間をライブ表示用に組み立てる。
  // fadeIn / fadeOut はブロック座標（start/end）は変わらないので liveOverride は start/end のみ。
  function liveSe(): SeOverride | null {
    if (seDrag.drag === null) return null;
    const { handle, frame } = seDrag.drag;
    const origin = seDragOriginRef.current;
    const duration = origin.end - origin.start;
    if (handle.edge === 'body') {
      const clamped = Math.max(0, frame);
      return { seId: handle.seId, originalStart: clamped, originalEnd: clamped + duration };
    }
    if (handle.edge === 'start') {
      const start = Math.min(Math.max(0, frame), origin.end - 1);
      return { seId: handle.seId, originalStart: start, originalEnd: origin.end };
    }
    if (handle.edge === 'end') {
      const end = Math.max(origin.start + 1, frame);
      return { seId: handle.seId, originalStart: origin.start, originalEnd: end };
    }
    // fadeIn / fadeOut はブロック位置は変わらない（フェード長だけ変わる）。
    return null;
  }

  // 範囲選択カットの選択帯（原本フレーム・履歴に積まない一時状態）。
  const [cutSelection, setCutSelection] = useState<{ start: number; end: number } | null>(null);
  // 選択ドラッグの起点（pointerdown 時の吸着済みフレーム）。
  const cutSelAnchorRef = useRef<number>(0);
  // 選択ドラッグ起点の生フレーム（クリック時の頭出し先・useTimelineDrag のデルタ基準）。
  const cutSelRawAnchorRef = useRef<number>(0);
  // 選択ドラッグが .tl-kept-segment 上で開始したかどうか。
  // クリック（δ≤5px）時、バンド自身の onClick が onSelectSegment を呼ぶため、
  // cutSelDrag の onCommit で seekToOriginal/setCutSelection の副作用をスキップする。
  const cutSelStartedOnSegmentRef = useRef(false);

  // 動画トラック背景のドラッグ＝範囲選択。両端は吸着。drop で選択帯を確定（カットはまだしない）。
  const cutSelDrag = useTimelineDrag<'cutsel'>({
    getTrackOriginX: trackOriginX,
    getAutoScrollDx,
    pxPerFrame,
    map: displayMap,
    onDrag: (_h, raw) => Math.max(cutSelBounds.start, Math.min(cutSelBounds.end, snapFrameWithGuide(raw))),
    onCommit: (_h, finalFrame) => {
      const a = cutSelAnchorRef.current;
      const start = Math.min(a, finalFrame);
      const end = Math.max(a, finalFrame);
      setSnapHit(null);
      if (start >= end) {
        // 動かさなかった（クリック）= 選択解除＋クリック位置（RAW・吸着しない）へ頭出し。
        // ただし .tl-kept-segment 上で始まったクリックはバンド自身の onClick で区間選択済みのため
        // seekToOriginal / setCutSelection の副作用をスキップする（再生ヘッド移動防止）。
        if (!cutSelStartedOnSegmentRef.current) {
          setCutSelection(null);
          seekToOriginal(cutSelRawAnchorRef.current);
        }
        return;
      }
      setCutSelection({ start, end });
    },
    // onClick は意図的に未指定。範囲選択はクリック自体が「選択解除＋頭出し」という
    // 意味を持つ操作なので、純クリックでも onCommit を通す必要がある。
  });

  // 描画用の選択帯。ドラッグ中はライブ、離した後は確定済み cutSelection。
  const cutSelectionView =
    cutSelDrag.drag !== null
      ? {
          start: Math.min(cutSelAnchorRef.current, cutSelDrag.drag.frame),
          end: Math.max(cutSelAnchorRef.current, cutSelDrag.drag.frame),
        }
      : cutSelection;

  // カット統合ボタンの文脈（'cut' | 'open'）。選択なしは 'cut'（disabled 表示用）。
  const cutMode =
    cutSelection !== null
      ? cutButtonMode(state.cutRegions, cutSelection.start, cutSelection.end)
      : 'cut';

  // 選択帯がある間、Delete/Backspace でカット確定・Esc で解除。
  useEffect(() => {
    if (cutSelection === null) return;
    function onKey(e: KeyboardEvent): void {
      if (e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const inEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target?.isContentEditable ?? false);
      if (e.key === 'Escape') {
        setCutSelection(null);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !inEditable && cutSelection !== null) {
        e.preventDefault();
        const mode = cutButtonMode(state.cutRegions, cutSelection.start, cutSelection.end);
        session.apply(
          mode === 'open'
            ? openCutRange(state, cutSelection.start, cutSelection.end)
            : cutRange(state, cutSelection.start, cutSelection.end),
        );
        setCutSelection(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cutSelection, session, state]);

  // プロジェクトを開き直したら選択帯をクリアする（取り残し防止）。
  useEffect(() => {
    setCutSelection(null);
  }, [baseProject]);

  // テロップ複数選択がある間、Delete/Backspace で一括削除・Esc で選択解除。
  // 範囲選択カットとは相互排他（§1）なので優先順位規則は要らない ——「いま生きている方」に効く。
  // 削除できるのは飾りテロップ（manual）だけで、字幕は removeTelops がスキップする
  //（字幕の削除＝区間カットという既存契約を変えない）。
  const multiTelopIds = state.multiTelopIds;
  useEffect(() => {
    if (multiTelopIds.length < 2) return;
    function onKey(e: KeyboardEvent): void {
      if (e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const inEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target?.isContentEditable ?? false);
      if (inEditable) return;
      if (e.key === 'Escape') {
        session.setTransient(clearMultiSelection);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        session.apply((prev) => removeTelops(prev, prev.multiTelopIds));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [multiTelopIds, session]);

  // B キー = 再生ヘッド位置でヘッド下テロップを分割。
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.isComposing) return;
      if (e.key !== 'b' && e.key !== 'B') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target?.isContentEditable ?? false)
      ) {
        return;
      }
      const t = telopAtFrame(state.telops, playheadOriginal);
      if (t === undefined || playheadOriginal <= t.originalStart) return;
      e.preventDefault();
      session.apply(splitTelopWithText(state, t.id, playheadOriginal, splitChipsFor(t)));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, session, playheadOriginal]);

  // カット区間内に完全に飲まれた SE（警告表示用）。BGM の clampBgm と同方針。
  const flaggedSeIds = useMemo(
    () => new Set(clampSe(state.se, state.cutRegions).flaggedIds),
    [state.se, state.cutRegions],
  );

  // 画像ドラッグ。edge='body' は平行移動、'start'/'end' は片端移動。
  // Codex P2 指摘: start/end のクランプは liveImage 側の表示と retimeImage の
  // 強制仕様（end<=start のとき end を start+1 へ寄せる）を一致させるためのもの。
  // useTimelineEdgeDrag は onRetimeStart/onRetimeEnd に同じ clamp 済み値を渡す。
  const imageEdgeDrag = useTimelineEdgeDrag<number, ImageHandleId, ImageOverride>({
    getTrackOriginX: trackOriginX,
    getAutoScrollDx,
    pxPerFrame,
    map: displayMap,
    applySnap,
    findEntity: (id) => state.images.find((i) => i.id === id),
    getId: (handle) => handle.imageId,
    // telop と同型: pointerdown の選択（setTransient）と pointerup のコミット（apply）が
    // 同じ最新状態の系列に載るよう、どちらも関数形で書く。
    onMove: (id, frame) => session.apply((prev) => moveImage(prev, id, frame)),
    onRetimeStart: (id, start, end) => session.apply((prev) => retimeImage(prev, id, start, end)),
    onRetimeEnd: (id, start, end) => session.apply((prev) => retimeImage(prev, id, start, end)),
    onSelectEntity: (id) => session.setTransient((prev) => selectImage(prev, id)),
    onBeginSelectedHandle: (handle) => setSelectedHandle({ kind: 'image', handle }),
    afterCommit: () => setSnapHit(null),
    buildOverride: (id, start, end) => ({ imageId: id, originalStart: start, originalEnd: end }),
  });

  // サブ動画ドラッグ。edge='body' は平行移動、'start'/'end' は片端移動。
  const videoInsertEdgeDrag = useTimelineEdgeDrag<number, VideoInsertHandleId, VideoInsertOverride>({
    getTrackOriginX: trackOriginX,
    getAutoScrollDx,
    pxPerFrame,
    map: displayMap,
    applySnap,
    findEntity: (id) => state.videoInserts.find((v) => v.id === id),
    getId: (handle) => handle.videoInsertId,
    onMove: (id, frame) => session.apply((prev) => moveVideoInsert(prev, id, frame)),
    // 端ドラッグはどちらの端でも「確定する start」を基準に上限を出す
    // （左端を左へ伸ばすと尺が増え、消費するソース量も増えるため）。
    onRetimeStart: (id, start, end) =>
      session.apply((prev) => retimeVideoInsert(prev, id, start, end, videoInsertEndLimitById(id, start))),
    onRetimeEnd: (id, start, end) =>
      session.apply((prev) => retimeVideoInsert(prev, id, start, end, videoInsertEndLimitById(id, start))),
    onSelectEntity: (id) => session.setTransient((prev) => selectVideoInsert(prev, id)),
    onBeginSelectedHandle: (handle) => setSelectedHandle({ kind: 'videoInsert', handle }),
    afterCommit: () => setSnapHit(null),
    buildOverride: (id, start, end) => ({ videoInsertId: id, originalStart: start, originalEnd: end }),
  });

  // カット区間に完全に飲まれた画像（警告表示用）。最初から useMemo で記憶（Plan A M6 の教訓）。
  const flaggedImageIds = useMemo(
    () => new Set(clampImages(state.images, state.cutRegions).flaggedIds),
    [state.images, state.cutRegions],
  );

  const flaggedVideoInsertIds = useMemo(
    () => new Set(clampVideoInserts(state.videoInserts, state.cutRegions).flaggedIds),
    [state.videoInserts, state.cutRegions],
  );

  const flaggedBgmIds = useMemo(
    () => new Set(clampBgm(state.bgm, state.cutRegions).flaggedIds),
    [state.bgm, state.cutRegions],
  );

  const flaggedShapeIds = useMemo(
    () => new Set(clampShapes(state.shapes, state.cutRegions).flaggedIds),
    [state.shapes, state.cutRegions],
  );

  // BGM ドラッグ。
  // edge='body'  → 平行移動（moveBgm）
  // edge='start' → 左端伸縮（resizeBgm）
  // edge='end'   → 右端伸縮（resizeBgm）
  // edge='fadeIn'/'fadeOut' → フェード長変更（setBgmFadeIn / setBgmFadeOut）。
  //   フェードつまみは水平ドラッグ量をフレームへ変換し、commitInPointDrag と同じ
  //   「commit 前に pre-drag 値へ復元 → final を1件積む」方式で Undo 整合を保つ。
  const bgmDrag = useTimelineDrag<BgmHandleId>({
    getTrackOriginX: trackOriginX,
    getAutoScrollDx,
    pxPerFrame,
    map: displayMap,
    onDrag: (handle, rawFrame) => {
      if (handle.edge === 'fadeIn' || handle.edge === 'fadeOut') {
        // フェードつまみ: rawFrame はフレームとして扱うのではなく、
        // ドラッグ開始位置からの相対フレーム数でフェード長を増減する。
        // useTimelineDrag は「絶対フレーム」を返すので、origin フレームとの差を使う。
        const origin = bgmDragOriginRef.current;
        const originFrame = handle.edge === 'fadeIn' ? origin.start : origin.end;
        const delta = rawFrame - originFrame;
        const baseFade = handle.edge === 'fadeIn' ? origin.fadeInFrames : origin.fadeOutFrames;
        const newFade = Math.max(0, Math.round(baseFade + (handle.edge === 'fadeIn' ? delta : -delta)));
        // live プレビュー: setTransient で現在エントリを上書き。
        if (handle.edge === 'fadeIn') {
          session.setTransient((prev) => setBgmFadeIn(prev, handle.bgmId, newFade));
        } else {
          session.setTransient((prev) => setBgmFadeOut(prev, handle.bgmId, newFade));
        }
        return rawFrame; // useTimelineDrag が drag.frame として保持（ツールチップ用）。
      }
      return applySnap(rawFrame);
    },
    onCommit: (handle, finalFrame) => {
      const origin = bgmDragOriginRef.current;
      if (handle.edge === 'body') {
        session.apply((prev) => moveBgm(prev, handle.bgmId, finalFrame));
      } else if (handle.edge === 'start') {
        const clampedStart = Math.min(Math.max(0, finalFrame), origin.end - 1);
        session.apply((prev) => resizeBgm(prev, handle.bgmId, clampedStart, origin.end));
      } else if (handle.edge === 'end') {
        const clampedEnd = Math.max(origin.start + 1, finalFrame);
        session.apply((prev) => resizeBgm(prev, handle.bgmId, origin.start, clampedEnd));
      } else if (handle.edge === 'fadeIn') {
        // commitInPointDrag と同じ方式:
        // pre-drag 値で setTransient して潰れたエントリを復元 → final を apply。
        const startFade = origin.fadeInFrames;
        const delta = finalFrame - origin.start;
        const finalFade = Math.max(0, Math.round(startFade + delta));
        commitInPointDrag(startFade, finalFade, {
          onLive: (v) => session.setTransient((prev) => setBgmFadeIn(prev, handle.bgmId, v)),
          onCommit: (v) => session.apply((prev) => setBgmFadeIn(prev, handle.bgmId, v)),
        });
      } else if (handle.edge === 'fadeOut') {
        const startFade = origin.fadeOutFrames;
        const delta = finalFrame - origin.end;
        const finalFade = Math.max(0, Math.round(startFade + (-delta)));
        commitInPointDrag(startFade, finalFade, {
          onLive: (v) => session.setTransient((prev) => setBgmFadeOut(prev, handle.bgmId, v)),
          onCommit: (v) => session.apply((prev) => setBgmFadeOut(prev, handle.bgmId, v)),
        });
      }
      setSnapHit(null);
    },
    // 純クリックは選択のみ（onHandleDown で選択済み）。履歴も積まず区間も動かさない。
    onClick: () => setSnapHit(null),
  });

  // Task 2: じまく・テロップ両行で共有する onHandleDown コールバック。
  // TelopTrack の variant に関わらず同じ telopDrag を使う（1 本のドラッグ管理で足りる）。
  function telopHandleDown(handle: TelopHandleId, e: React.PointerEvent): void {
    const t = state.telops.find((x) => x.id === handle.telopId);
    const originStart = t?.originalStart ?? 0;
    const originEnd = t?.originalEnd ?? 0;
    telopDragOriginRef.current = { start: originStart, end: originEnd };
    // 修飾キー（Cmd/Ctrl/Shift）＋クリックは複数選択のトグル。ただし確定は pointerup 後の
    // 「純クリック判定」まで待つ（修飾キーを押したままドラッグしたときにトグルさせない）。
    // 待っている間は選択も動かさない＝ドラッグなら掴んだテロップの区間編集がそのまま通る。
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      telopMultiPendingRef.current = handle.telopId;
    } else {
      telopMultiPendingRef.current = null;
      // 通常クリックは従来どおり単一選択（複数選択は解除する）。
      // 関数形。この後の pointerup（onCommit）と同じ「最新状態」の系列に載せる。
      session.setTransient((prev) =>
        clearMultiSelection({ ...prev, selection: { kind: 'telop', id: handle.telopId } }),
      );
    }
    setSelectedHandle({ kind: 'telop', handle });
    const originFrame = handle.edge === 'end' ? originEnd : originStart;
    telopDrag.beginDrag(handle, e, originFrame);
  }

  // ドラッグ中の BGM 位置をライブ表示用に組み立てる。
  // fadeIn / fadeOut はブロック座標（start/end）は変わらないので liveOverride は start/end のみ。
  function liveBgm(): BgmOverride | null {
    if (bgmDrag.drag === null) return null;
    const { handle, frame } = bgmDrag.drag;
    const origin = bgmDragOriginRef.current;
    const duration = origin.end - origin.start;
    if (handle.edge === 'body') {
      const clamped = Math.max(0, frame);
      return { bgmId: handle.bgmId, originalStart: clamped, originalEnd: clamped + duration };
    }
    if (handle.edge === 'start') {
      const start = Math.min(Math.max(0, frame), origin.end - 1);
      return { bgmId: handle.bgmId, originalStart: start, originalEnd: origin.end };
    }
    if (handle.edge === 'end') {
      const end = Math.max(origin.start + 1, frame);
      return { bgmId: handle.bgmId, originalStart: origin.start, originalEnd: end };
    }
    // fadeIn / fadeOut はブロック位置は変わらない（フェード長だけ変わる）。
    return null;
  }

  // 図形ドラッグ。edge='body' は平行移動、'start'/'end' は片端移動。
  const shapeEdgeDrag = useTimelineEdgeDrag<number, ShapeHandleId, ShapeOverride>({
    getTrackOriginX: trackOriginX,
    getAutoScrollDx,
    pxPerFrame,
    map: displayMap,
    applySnap,
    findEntity: (id) => state.shapes.find((s) => s.id === id),
    getId: (handle) => handle.shapeId,
    onMove: (id, frame) => session.apply((prev) => moveShapeTime(prev, id, frame)),
    onRetimeStart: (id, start, end) => session.apply((prev) => retimeShape(prev, id, start, end)),
    onRetimeEnd: (id, start, end) => session.apply((prev) => retimeShape(prev, id, start, end)),
    onSelectEntity: (id) => session.setTransient((prev) => selectShape(prev, id)),
    onBeginSelectedHandle: (handle) => setSelectedHandle({ kind: 'shape', handle }),
    afterCommit: () => setSnapHit(null),
    buildOverride: (id, start, end) => ({ shapeId: id, originalStart: start, originalEnd: end }),
  });

  // ---- 端ドラッグ自動スクロール（edge-autoscroll・scrollLeft の第4経路） -------
  // ブロックを掴んだまま可視域の左右端へポインタを寄せると横スクロールする。
  // 対象は「時間を編集するドラッグ」だけ。スクラブ（ルーラー）は再生ヘッド追従と
  // 競合するので対象外（設計書 ①「対象外」）。
  //
  // **発動は「ドラッグ確定後のみ」**（drag.moved）。pointerdown 直後から動かすと、
  // 端ゾーン（40px）に居るブロックを選択のためにクリックしただけでスクロールが始まり、
  // 区間が動いて確定してしまう（2026-08-17 に潰した「クリックで黙って動く」の復活）。
  // Cmd＋クリックの複数選択トグルも純クリック判定が要るので同じ理由で壊れる。
  // 監視（ポインタ位置の記録と rAF ループ）は pointerdown から始める。最初の pointermove を
  // 取りこぼすと「ポインタ位置が分からないまま」になるため。
  const edgeScrollWatching =
    cutDrag.drag !== null ||
    telopDrag.drag !== null ||
    seDrag.drag !== null ||
    bgmDrag.drag !== null ||
    cutSelDrag.drag !== null ||
    imageEdgeDrag.drag !== null ||
    videoInsertEdgeDrag.drag !== null ||
    shapeEdgeDrag.drag !== null;

  // ホバー版（待機中の担当）を休止させる条件。上記 8 経路に加えてスクラブも含める。
  // スクラブは端スクロールの対象外（再生ヘッド追従と競合する）なので、ホバー版が
  // 代わりに走ってしまうと「対象外」が窓口を変えて破られる。armed ではなく watching
  // （pointerdown の時点）で立てるのが要点——確定前に scrollLeft を動かさないため。
  timelineDragActiveRef.current = edgeScrollWatching || scrubDrag.drag !== null;

  // 実際にスクロールを始めてよいのは、ドラッグとして確定してから（moved）。
  const edgeScrollArmed =
    (cutDrag.drag?.moved ?? false) ||
    (telopDrag.drag?.moved ?? false) ||
    (seDrag.drag?.moved ?? false) ||
    (bgmDrag.drag?.moved ?? false) ||
    (cutSelDrag.drag?.moved ?? false) ||
    (imageEdgeDrag.drag?.moved ?? false) ||
    (videoInsertEdgeDrag.drag?.moved ?? false) ||
    (shapeEdgeDrag.drag?.moved ?? false);
  // rAF ループから最新値を読むため ref に写す（ループは貼り直さない）。
  const edgeScrollArmedRef = useRef(false);
  edgeScrollArmedRef.current = edgeScrollArmed;

  // 最後に観測したポインタイベントの要点。スクロール後の move 再送で、位置だけでなく
  // pointerId / pointerType / buttons まで引き継ぐ（受け手がこれらで分岐しても壊れない）。
  const lastPointerRef = useRef<
    { x: number; y: number; pointerId: number; pointerType: string; buttons: number } | null
  >(null);

  useEffect(() => {
    if (!edgeScrollWatching) return;
    let raf = 0;
    let stopped = false;
    let prevTs: number | null = null;
    // このドラッグで自分が足した量をゼロから数え直す。
    autoScrollDxRef.current = 0;
    // 可視域の矩形はドラッグ中に変わらない前提で開始時に 1 回だけ実測する。
    // 毎フレーム getBoundingClientRect を呼ぶと強制同期レイアウトが 60 回/秒走る。
    // 変わるのはウィンドウリサイズだけでなく、タイムライン高さ変更やパネル開閉でも
    // 起きるので、window の resize ではなく要素自身の ResizeObserver で取り直す。
    const el0 = bodyRef.current;
    let rect: DOMRect | null = el0 === null ? null : el0.getBoundingClientRect();

    function remeasure(): void {
      const el = bodyRef.current;
      rect = el === null ? null : el.getBoundingClientRect();
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(remeasure);
    if (observer !== null && el0 !== null) observer.observe(el0);

    function onPointerMove(e: PointerEvent): void {
      lastPointerRef.current = {
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        buttons: e.buttons,
      };
    }

    function step(ts: number): void {
      if (stopped) return;
      // 実フレーム間隔で速度を正規化する（120Hz で倍速・コマ落ちで鈍足にしない）。
      const dt = prevTs === null ? null : ts - prevTs;
      prevTs = ts;
      // 再生中は再生追従スクロール（followScrollLeft）が毎フレーム同じ scrollLeft を
      // 書いている。端スクロールを重ねると 2 つの書き手が奪い合って画面が痙攣するので、
      // 再生中は端スクロールを見送る（一時停止すれば次のフレームから再開する）。
      if (isPlayingRef.current) {
        raf = requestAnimationFrame(step);
        return;
      }
      // ドラッグ確定前（純クリックかもしれない間）はスクロールしない。
      if (!edgeScrollArmedRef.current) {
        raf = requestAnimationFrame(step);
        return;
      }
      const el = bodyRef.current;
      const p = lastPointerRef.current;
      if (el !== null && p !== null && rect !== null) {
        const v = edgeScrollVelocity(p.x, rect.left, rect.right) * edgeScrollFrameScale(dt);
        if (v !== 0) {
          const max = Math.max(0, el.scrollWidth - el.clientWidth);
          const next = Math.max(0, Math.min(max, el.scrollLeft + v));
          if (next !== el.scrollLeft) {
            // 自分が足した量として記録する（クリック/ドラッグ判定へ渡る）。
            autoScrollDxRef.current += next - el.scrollLeft;
            el.scrollLeft = next;
            // スクロールした分だけドラッグ値も進める。スクロールでトラック原点
            // （trackOriginX）がずれるため、同じポインタ位置で move をもう一度流せば
            // 各ドラッグの onDrag が新しい原点で再計算する。これが無いと画面だけ
            // 滑ってブロックが置き去りになる（設計書 ①「move 処理を再実行」）。
            window.dispatchEvent(
              new PointerEvent('pointermove', {
                clientX: p.x,
                clientY: p.y,
                pointerId: p.pointerId,
                pointerType: p.pointerType,
                buttons: p.buttons,
                bubbles: false,
              }),
            );
          }
        }
      }
      raf = requestAnimationFrame(step);
    }

    // 直前の pointerdown 位置は分からないので、最初の pointermove まで待つ
    // （lastPointerRef が null の間 step は何もしない）。
    window.addEventListener('pointermove', onPointerMove);
    raf = requestAnimationFrame(step);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onPointerMove);
      observer?.disconnect();
      lastPointerRef.current = null;
      autoScrollDxRef.current = 0;
    };
  }, [edgeScrollWatching]);

  return (
    <div className="tl">
      <TimelineResizer />
      <div className="tl-head">
        <h2>タイムライン</h2>
        <div className="tl-head-tools">
          <span className="tl-total">
            完成尺 <strong>{formatClock(fps > 0 ? (speedSegments ? speedTotalFrames(speedSegments) : speedScale(playbackFrames, state.mainSpeed)) / fps : 0)}</strong>
            {state.cutRegions.length > 0 && (
              <>
                {/* カット前尺は一律換算で代替（区間速度はカット後区間に対する定義のため「カット前」には適用しない）。 */}
                {' '}（カット前 {formatClock(fps > 0 ? speedScale(totalFrames, state.mainSpeed) / fps : 0)}）
              </>
            )}
          </span>
          <button
            type="button"
            className={'tl-snap-toggle' + (snapEnabled ? ' on' : '')}
            title={snapEnabled ? '吸着オン（ドラッグ中 Alt で一時解除）' : '吸着オフ'}
            aria-pressed={snapEnabled}
            onClick={() => setSnapEnabled((v) => !v)}
          >
            吸着
          </button>
          <button
            type="button"
            className={'tl-snap-toggle tl-cuts-bypass' + (cutsBypassed ? ' on' : '')}
            title={
              cutsBypassed
                ? 'カット確認モード中: カットを適用せず原本全体を再生しています（もう一度押すと通常再生へ）'
                : 'カット確認モード: カット予定の区間も飛ばさずに再生して中身を確認できます'
            }
            aria-pressed={cutsBypassed}
            onClick={onToggleCutsBypassed}
          >
            カットも再生
          </button>
          <span className="tl-sep" aria-hidden="true" />
          <button
            type="button"
            className={'tl-cut-confirm' + (cutMode === 'open' ? ' open-mode' : '')}
            aria-disabled={cutSelection === null}
            title={
              cutSelection === null
                ? 'タイムラインをドラッグして範囲を選ぶとカットできます（カット済みブロックをクリックすると開けられます）'
                : cutMode === 'open'
                  ? '選択範囲のカットを開ける（その部分を復活させる。Delete でも可）'
                  : '選択範囲をカット（Delete でも可）'
            }
            onClick={() => {
              if (cutSelection === null) {
                setToolHint('タイムラインを左右にドラッグして範囲を選ぶとカットできます');
                return;
              }
              session.apply(
                cutMode === 'open'
                  ? openCutRange(state, cutSelection.start, cutSelection.end)
                  : cutRange(state, cutSelection.start, cutSelection.end),
              );
              setCutSelection(null);
            }}
          >
            {cutMode === 'open' ? 'カットを開ける' : '✂ カット'}
          </button>
          <button
            type="button"
            className="tl-split"
            aria-disabled={splittableTelop === undefined}
            title={
              splittableTelop === undefined
                ? '再生ヘッドがテロップ上にありません'
                : '再生ヘッド位置でテロップを分割（B キーでも可）'
            }
            onClick={() => {
              if (splittableTelop === undefined) {
                setToolHint('再生ヘッドをテロップに重なる位置へ動かすと分割できます');
                return;
              }
              session.apply(
                splitTelopWithText(state, splittableTelop.id, playheadOriginal, splitChipsFor(splittableTelop)),
              );
            }}
          >
            ヘッドで分割
          </button>
          <span className="tl-sep" aria-hidden="true" />
          <div className="dd tl-add-menu" ref={addMenu.rootRef}>
            <button
              type="button"
              ref={addMenu.triggerRef}
              className="tl-add-menu-btn"
              aria-haspopup="menu"
              aria-expanded={addMenu.open}
              title="効果音・画像・サブ動画・BGM・字幕・テロップを再生ヘッド位置に追加"
              onClick={() => addMenu.setOpen(!addMenu.open)}
            >
              ＋ 追加
            </button>
            {addMenu.open && (
              <div className="dd-menu" role="menu">
                <button type="button" role="menuitem" className="dd-item tl-se-add"
                  disabled={seLibrary.length === 0}
                  title={seLibrary.length === 0 ? 'public/se/ に効果音がありません' : '再生ヘッド位置に効果音を追加'}
                  onClick={() => {
                    const file = seLibrary[0];
                    if (file) session.apply(addSe(state, file, playheadOriginal));
                    addMenu.setOpen(false);
                  }}
                >効果音</button>
                <button type="button" role="menuitem" className="dd-item tl-image-add"
                  disabled={imageLibrary.length === 0}
                  title={imageLibrary.length === 0 ? 'public/images/ に画像がありません' : '再生ヘッド位置に画像を追加'}
                  onClick={() => {
                    const file = imageLibrary[0];
                    if (file) session.apply(addImage(state, file, playheadOriginal));
                    addMenu.setOpen(false);
                  }}
                >画像</button>
                <button type="button" role="menuitem" className="dd-item tl-vi-add"
                  disabled={videoLibrary.length === 0}
                  title={videoLibrary.length === 0 ? 'public/ にサブ動画がありません' : '再生ヘッド位置にサブ動画を追加'}
                  onClick={() => {
                    const file = videoLibrary[0];
                    if (file) session.apply(addVideoInsert(state, file, playheadOriginal));
                    addMenu.setOpen(false);
                  }}
                >サブ動画</button>
                <button type="button" role="menuitem" className="dd-item tl-bgm-add"
                  disabled={bgmLibrary.length === 0}
                  title={bgmLibrary.length === 0 ? 'public/BGM/ に曲がありません' : '再生ヘッド位置に BGM を追加'}
                  onClick={() => {
                    const file = bgmLibrary[0];
                    if (file) session.apply(addBgm(state, file, playheadOriginal));
                    addMenu.setOpen(false);
                  }}
                >BGM</button>
                <button type="button" role="menuitem" className="dd-item tl-subtitle-add"
                  title="字幕（青）を再生ヘッド位置に追加"
                  onClick={() => {
                    const span = subtitleInsertSpan(state.telops, state.nextTelopId, playheadOriginal, fps);
                    // 隣接字幕と重なって区間を確保できない位置。ブラウザダイアログ
                    // （window.alert）はセッションを止めてしまうので、既存の一時ヒント
                    // （4 秒で自動消滅）で理由を出す。
                    if (span === null) {
                      setToolHint('ここには字幕を追加できません（既存の字幕と重なります）');
                    } else {
                      session.apply(addSubtitleAtFrame(state, playheadOriginal, fps));
                      // ヘッドが既存字幕の内側だと直後の空きへ寄る。押した所と違う場所に
                      // 出るので黙ってずらさない（設計書 v2・P2-3）。
                      if (span.shifted) setToolHint('直前の字幕の直後に追加しました');
                    }
                    addMenu.setOpen(false);
                  }}
                >字幕</button>
                <button type="button" role="menuitem" className="dd-item tl-telop-add"
                  title="再生ヘッド位置にテロップを追加"
                  onClick={() => {
                    session.apply(addTelopAtFrame(state, playheadOriginal, fps));
                    addMenu.setOpen(false);
                  }}
                >テロップ</button>
              </div>
            )}
          </div>
          <span className="tl-sep" aria-hidden="true" />
          <span
            className="tl-transport-hint"
            title="J＝巻き戻し / K＝一時停止 / L＝早送り（押すたび 1→2→4→8 倍）。←→＝1コマ送り（Shift＋←→ で 1 秒）"
          >
            J K L
          </span>
          {playbackRateLabel(playbackRate) !== '' && (
            <span className="tl-rate-badge" role="status">{playbackRateLabel(playbackRate)}</span>
          )}
          <span className="tl-sep" aria-hidden="true" />
          <div className="tl-zoom">
            <button type="button" title="ズームアウト（再生ヘッドの位置を中心に縮小）" onClick={() => zoomBy(0.5)}>
              −
            </button>
            <button type="button" title="ズームイン（再生ヘッドの位置を中心に拡大）" onClick={() => zoomBy(2)}>
              ＋
            </button>
          </div>
        </div>
        {toolHint !== null && (
          <div className="tl-tool-hint" role="status">{toolHint}</div>
        )}
      </div>
      <div
        ref={bodyRef}
        className="tl-body"
      >
        <div
          ref={scrollRef}
          className="tl-scroll"
          style={{ width: trackWidth }}
          onPointerLeave={() => onHighlightRange(null)}
          onPointerDown={(e) => {
            const target = e.target as HTMLElement;
            if (target.classList.contains('tl-handle') || target.closest('.tl-telop')) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            // ガターオフセットを反映するため xToFrameMapped に統一（生計算しない）。
            seekToOriginal(xToFrameMapped(x, pxPerFrame, displayMap));
          }}
        >
          <TimelineRuler
            totalFrames={totalFrames}
            pxPerFrame={pxPerFrame}
            fps={fps}
            map={displayMap}
            onScrubStart={(e) => {
              // useTimelineDrag と同じ原点（trackOriginX）でフレームを算出し、掴んだ瞬間のデルタを 0 にする
              // （ルーラーと .tl-scroll の左端ズレに依存しない）。beginDrag が propagation を止める。
              const raw = xToFrameMapped(e.clientX - trackOriginX(), pxPerFrame, displayMap);
              scrubDrag.beginDrag('scrub', e, Math.max(0, Math.min(totalFrames, raw)));
            }}
          />
          <CutTrack
            totalFrames={totalFrames}
            pxPerFrame={pxPerFrame}
            map={displayMap}
            cutRegions={state.cutRegions}
            liveRegions={liveCutRegions()}
            selectedHandle={
              selectedHandle?.kind === 'cut' ? selectedHandle.handle : cutDrag.drag?.handle ?? null
            }
            onHandleDown={(handle, e) => {
              const edgeFrame = handle.edge === 'start' ? handle.region.start : handle.region.end;
              cutDragOriginRef.current = edgeFrame;
              setSelectedHandle({ kind: 'cut', handle });
              cutDrag.beginDrag(handle, e, edgeFrame);
            }}
            pulseKeys={pulseKeys}
            samples={waveformSamples}
            videoUrl={videoUrl}
            waveformPref={waveformPref}
            onRegionHover={(region) =>
              onHighlightRange(region === null ? null : { start: region.start, end: region.end })
            }
            selectOnCut={cutsBypassed}
            onTrackPointerDown={(e) => {
              // kept-segment 上で始まったかどうかを記録する。
              // クリック（δ≤5px）の場合はバンドの onClick が onSelectSegment を呼ぶため、
              // cutSelDrag.onCommit の seekToOriginal/setCutSelection をスキップする。
              // ドラッグ（δ>5px）の場合は引き続き範囲選択として cutSelDrag が確定する。
              cutSelStartedOnSegmentRef.current =
                (e.target as HTMLElement).closest('.tl-kept-segment') !== null;
              const raw = xToFrameMapped(e.clientX - trackOriginX(), pxPerFrame, displayMap);
              // 帯の起点は吸着位置。ただし beginDrag には RAW を渡す（useTimelineDrag の
              // デルタ基準＝掴んだ生フレームと一致させ、ドラッグ端の吸着ぶんのズレを防ぐ）。
              // 範囲選択を開始したらテロップ複数選択は解除する（相互排他・設計書 §1）。
              // これで Delete は常に「いま生きている方」だけに作用する。
              // 動画トラックの pointerdown は頻発するので、消すものがある時だけ触る。
              if (state.multiTelopIds.length > 0) session.setTransient(clearMultiSelection);
              cutSelRawAnchorRef.current = raw;
              cutSelAnchorRef.current = Math.max(
                cutSelBounds.start,
                Math.min(cutSelBounds.end, snapFrameWithGuide(raw)),
              );
              cutSelDrag.beginDrag('cutsel', e, raw);
            }}
            onSelectMainVideo={() => session.apply({ ...state, selection: { kind: 'mainVideo' } })}
            mainVideoSelected={state.selection?.kind === 'mainVideo'}
            mainSpeed={state.mainSpeed}
            ordering={ordering}
            keptSegments={keptSegments}
            segmentSpeeds={state.segmentSpeeds}
            layoutKeyframes={state.layoutKeyframes}
            fps={fps}
            onSeekPlayback={(playbackFrame) => seekToOriginal(playbackToOriginal(playbackFrame, state.cutRegions, ordering))}
            selectedSegmentId={state.selection?.kind === 'cutSegment' ? state.selection.id : null}
            onSelectSegment={(id) => session.apply({ ...state, selection: { kind: 'cutSegment', id } })}
            onRegionClick={(region) => {
              // 通常モードでは範囲ドラッグが素材範囲へクランプされるため、
              // カット内側選択を得る唯一の導線。クランプを経由せず直接セットする（spec 実装制約）。
              setCutSelection({ start: region.start, end: region.end });
            }}
          />
          {/* つなぎ目マーク: CutTrack 直後・他トラックより手前。クリックで selectJoin。 */}
          <JoinMarkers
            joins={joins}
            sceneTransitions={state.sceneTransitions}
            pxPerFrame={pxPerFrame}
            map={displayMap}
            tailFrame={cutSelBounds.end}
            selectedAt={state.selection?.kind === 'join' ? state.selection.at : null}
            onSelect={(at) => session.apply(selectJoin(state, at))}
          />
          {/* 並び順: 動画→じまく→テロップ→画像→サブ動画→BGM→効果音（タイトルはテロップへ一本化） */}
          {/* じまく行（字幕テロップ・variant=subtitle）*/}
          <TelopTrack
            pxPerFrame={pxPerFrame}
            map={displayMap}
            telops={jimakuTelops}
            label="じまく"
            variant="subtitle"
            selectedTelopId={state.selection?.kind === 'telop' ? state.selection.id : null}
            multiSelectedIds={state.multiTelopIds}
            liveOverride={liveTelopOverride()}
            selectedHandle={
              selectedHandle?.kind === 'telop'
                ? selectedHandle.handle
                : telopDrag.drag?.handle ?? null
            }
            onHandleDown={telopHandleDown}
          />
          {/* テロップ行（手動テロップ・variant=manual）*/}
          <TelopTrack
            pxPerFrame={pxPerFrame}
            map={displayMap}
            telops={telopManuals}
            label="テロップ"
            variant="manual"
            selectedTelopId={state.selection?.kind === 'telop' ? state.selection.id : null}
            multiSelectedIds={state.multiTelopIds}
            liveOverride={liveTelopOverride()}
            selectedHandle={
              selectedHandle?.kind === 'telop'
                ? selectedHandle.handle
                : telopDrag.drag?.handle ?? null
            }
            onHandleDown={telopHandleDown}
          />
          <ImageTrack
            pxPerFrame={pxPerFrame}
            map={displayMap}
            images={state.images}
            flaggedImageIds={flaggedImageIds}
            selectedImageId={state.selection?.kind === 'image' ? state.selection.id : null}
            liveOverride={imageEdgeDrag.live()}
            onHandleDown={imageEdgeDrag.onHandleDown}
          />
          <VideoInsertTrack
            pxPerFrame={pxPerFrame}
            map={displayMap}
            videoInserts={state.videoInserts}
            flaggedVideoInsertIds={flaggedVideoInsertIds}
            selectedVideoInsertId={state.selection?.kind === 'videoInsert' ? state.selection.id : null}
            liveOverride={videoInsertEdgeDrag.live()}
            onHandleDown={videoInsertEdgeDrag.onHandleDown}
          />
          <BgmTrack
            pxPerFrame={pxPerFrame}
            map={displayMap}
            bgm={state.bgm}
            projectId={projectId}
            assetVersions={assetVersions}
            flaggedBgmIds={flaggedBgmIds}
            selectedBgmId={state.selection?.kind === 'bgm' ? state.selection.id : null}
            liveOverride={liveBgm()}
            onNormalizeVolume={(bgmId, volume) => session.apply(normalizeBgmVolume(state, bgmId, volume))}
            onHandleDown={(handle, e) => {
              const clip = state.bgm.find((b) => b.id === handle.bgmId);
              const originStart = clip?.originalStart ?? 0;
              const originEnd = clip?.originalEnd ?? 0;
              bgmDragOriginRef.current = {
                start: originStart,
                end: originEnd,
                fadeInFrames: clip?.fadeInFrames ?? 0,
                fadeOutFrames: clip?.fadeOutFrames ?? 0,
              };
              // 関数形。この直後の beginDrag→onDrag（fade ライブ更新）と同じ最新状態の系列に載せる。
              session.setTransient((prev) => selectBgm(prev, handle.bgmId));
              setSelectedHandle({ kind: 'bgm', handle });
              // フェードつまみはブロックの左端（fadeIn）または右端（fadeOut）を基準にする。
              const originFrame =
                handle.edge === 'end' || handle.edge === 'fadeOut' ? originEnd : originStart;
              bgmDrag.beginDrag(handle, e, originFrame);
            }}
          />
          <SeTrack
            pxPerFrame={pxPerFrame}
            map={displayMap}
            se={state.se}
            projectId={projectId}
            assetVersions={assetVersions}
            fps={fps}
            flaggedSeIds={flaggedSeIds}
            selectedSeId={state.selection?.kind === 'se' ? state.selection.id : null}
            liveOverride={liveSe()}
            onHandleDown={(handle, e) => {
              const clip = state.se.find((x) => x.id === handle.seId);
              const originStart = clip?.originalStart ?? 0;
              const originEnd = clip?.originalEnd ?? 0;
              seDragOriginRef.current = {
                start: originStart,
                end: originEnd,
                fadeInFrames: clip?.fadeInFrames ?? 0,
                fadeOutFrames: clip?.fadeOutFrames ?? 0,
              };
              // 関数形。この直後の beginDrag→onDrag（fade ライブ更新）と同じ最新状態の系列に載せる。
              session.setTransient((prev) => selectSe(prev, handle.seId));
              setSelectedHandle({ kind: 'se', handle });
              const originFrame = handle.edge === 'end' || handle.edge === 'fadeOut' ? originEnd : originStart;
              seDrag.beginDrag(handle, e, originFrame);
            }}
            onFinalize={(seId, durationFrames, volume) => session.apply(finalizeAddedSe(state, seId, durationFrames, volume))}
          />
          <ShapeTrack
            pxPerFrame={pxPerFrame}
            map={displayMap}
            shapes={state.shapes}
            flaggedShapeIds={flaggedShapeIds}
            selectedShapeId={state.selection?.kind === 'shape' ? state.selection.id : null}
            liveOverride={shapeEdgeDrag.live()}
            onHandleDown={shapeEdgeDrag.onHandleDown}
          />
          <div
            className="tl-playhead"
            style={{ left: frameToXMapped(playheadOriginal, pxPerFrame, displayMap) }}
          >
            <span className="tl-playhead-chip">{formatClock(fps > 0 ? playheadOriginal / fps : 0)}</span>
          </div>
          {cutSelectionView !== null && cutSelectionView.end > cutSelectionView.start && (
            <div
              className="tl-cut-selection"
              style={{
                left: frameToXMapped(cutSelectionView.start, pxPerFrame, displayMap),
                width: Math.max(2, widthMapped(cutSelectionView.start, cutSelectionView.end, pxPerFrame, displayMap)),
              }}
            />
          )}
          {cutSelection !== null && cutSelDrag.drag === null && (
            <div
              className="tl-cut-fab"
              style={{ left: frameToXMapped((cutSelection.start + cutSelection.end) / 2, pxPerFrame, displayMap) }}
            >
              <button
                type="button"
                className="tl-cut-fab-btn"
                title={cutMode === 'open' ? '選択範囲のカットを開ける' : '選択範囲をカット'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  if (cutSelection === null) return;
                  session.apply(
                    cutMode === 'open'
                      ? openCutRange(state, cutSelection.start, cutSelection.end)
                      : cutRange(state, cutSelection.start, cutSelection.end),
                  );
                  setCutSelection(null);
                }}
              >
                {cutMode === 'open' ? 'カットを開ける' : '✂ カット'}
              </button>
              <div className="tl-cut-fab-hint">
                {cutMode === 'open' ? 'Delete で開ける ・ Esc で解除' : 'Delete でカット ・ Esc で解除'}
              </div>
            </div>
          )}
          {highlightRange !== null && (
            <div
              className="tl-hl-marker"
              style={{
                left: frameToXMapped(highlightRange.start, pxPerFrame, displayMap),
                width: Math.max(2, widthMapped(highlightRange.start, highlightRange.end, pxPerFrame, displayMap)),
              }}
            />
          )}
          {cutDrag.drag !== null && (
            <DragTooltip
              frame={cutDrag.drag.frame}
              originFrame={cutDragOriginRef.current}
              pxPerFrame={pxPerFrame}
              map={displayMap}
              fps={fps}
            />
          )}
          {telopDrag.drag !== null && (
            <DragTooltip
              frame={telopDrag.drag.frame}
              originFrame={telopDrag.drag.handle.edge === 'end' ? telopDragOriginRef.current.end : telopDragOriginRef.current.start}
              pxPerFrame={pxPerFrame}
              map={displayMap}
              fps={fps}
            />
          )}
          {seDrag.drag !== null && seDrag.drag.handle.edge !== 'fadeIn' && seDrag.drag.handle.edge !== 'fadeOut' && (
            <DragTooltip
              frame={seDrag.drag.frame}
              originFrame={
                seDrag.drag.handle.edge === 'end'
                  ? seDragOriginRef.current.end
                  : seDragOriginRef.current.start
              }
              pxPerFrame={pxPerFrame}
              map={displayMap}
              fps={fps}
            />
          )}
          {imageEdgeDrag.drag !== null && (
            <DragTooltip
              frame={imageEdgeDrag.drag.frame}
              originFrame={
                imageEdgeDrag.drag.handle.edge === 'end'
                  ? imageEdgeDrag.originRef.current.end
                  : imageEdgeDrag.originRef.current.start
              }
              pxPerFrame={pxPerFrame}
              map={displayMap}
              fps={fps}
            />
          )}
          {videoInsertEdgeDrag.drag !== null && (
            <DragTooltip
              frame={videoInsertEdgeDrag.drag.frame}
              originFrame={
                videoInsertEdgeDrag.drag.handle.edge === 'end'
                  ? videoInsertEdgeDrag.originRef.current.end
                  : videoInsertEdgeDrag.originRef.current.start
              }
              pxPerFrame={pxPerFrame}
              map={displayMap}
              fps={fps}
            />
          )}
          {bgmDrag.drag !== null && bgmDrag.drag.handle.edge !== 'fadeIn' && bgmDrag.drag.handle.edge !== 'fadeOut' && (
            <DragTooltip
              frame={bgmDrag.drag.frame}
              originFrame={
                bgmDrag.drag.handle.edge === 'end'
                  ? bgmDragOriginRef.current.end
                  : bgmDragOriginRef.current.start
              }
              pxPerFrame={pxPerFrame}
              map={displayMap}
              fps={fps}
            />
          )}
          {shapeEdgeDrag.drag !== null && (
            <DragTooltip
              frame={shapeEdgeDrag.drag.frame}
              originFrame={
                shapeEdgeDrag.drag.handle.edge === 'end'
                  ? shapeEdgeDrag.originRef.current.end
                  : shapeEdgeDrag.originRef.current.start
              }
              pxPerFrame={pxPerFrame}
              map={displayMap}
              fps={fps}
            />
          )}
          {snapHit !== null &&
            (cutDrag.drag !== null ||
              telopDrag.drag !== null ||
              seDrag.drag !== null ||
              imageEdgeDrag.drag !== null ||
              videoInsertEdgeDrag.drag !== null ||
              bgmDrag.drag !== null ||
              shapeEdgeDrag.drag !== null ||
              cutSelDrag.drag !== null) && (
            <div className="tl-snapline" style={{ left: frameToXMapped(snapHit.frame, pxPerFrame, displayMap) }}>
              <span className="tl-snapline-label">{snapHit.label}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 画面下部のタイムライン。原本フレーム座標系で動画トラック（カットブロック）と
 * テロップトラックを描く（Plan 2B-2 設計判断 1）。
 *
 * フック無しラッパー: session/baseProject が null ならプレースホルダを返し、
 * そうでなければ全フックを持つ TimelineBody をマウントする。
 * これにより Rules of Hooks 違反（早期 return 後にフック呼び出し）を構造的に解消する。
 */
export function Timeline({
  session,
  baseProject,
  playerRef,
  seLibrary,
  imageLibrary,
  videoLibrary,
  videoDurations,
  bgmLibrary,
  videoUrl,
  projectId,
  assetVersions,
  highlightRange,
  onHighlightRange,
  dropApiRef,
  speedSegments,
  cutsBypassed,
  onToggleCutsBypassed,
  waveformPref,
  playbackRate,
  onPlaybackRateChange,
}: TimelineProps) {
  if (!session || !baseProject) {
    return (
      <div className="tl">
        <TimelineResizer />
        <div className="tl-head">
          <h2>タイムライン</h2>
        </div>
        <div className="tl-body">
          <div className="tl-empty">プロジェクトを開くとタイムラインが表示されます</div>
        </div>
      </div>
    );
  }

  return (
    <TimelineBody
      session={session}
      baseProject={baseProject}
      playerRef={playerRef}
      seLibrary={seLibrary}
      imageLibrary={imageLibrary}
      videoLibrary={videoLibrary}
      videoDurations={videoDurations}
      bgmLibrary={bgmLibrary}
      videoUrl={videoUrl}
      projectId={projectId}
      assetVersions={assetVersions}
      highlightRange={highlightRange}
      onHighlightRange={onHighlightRange}
      dropApiRef={dropApiRef}
      speedSegments={speedSegments}
      cutsBypassed={cutsBypassed}
      onToggleCutsBypassed={onToggleCutsBypassed}
      waveformPref={waveformPref}
      playbackRate={playbackRate}
      onPlaybackRateChange={onPlaybackRateChange}
    />
  );
}
