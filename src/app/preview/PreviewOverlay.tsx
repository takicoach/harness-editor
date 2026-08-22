import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { EditorTelop, EditorVideoInsert, EditorImage, EditorShape, ShapeKind } from '../../core/types';
import { clearMultiSelection, type EditState } from '../edit/editState';
import {
  setTelopPosition,
  setTelopScale,
  setTelopsPosition,
  setTelopsScale,
} from '../edit/telopSettingsOps';
import { setVideoInsertPosition, setVideoInsertScale } from '../edit/videoInsertOps';
import { setMainVideoPosition, setMainVideoScale } from '../edit/mainVideoOps';
import { setSegmentPosition, setSegmentScale } from '../edit/segmentLayoutOps';
import { resolveSegmentLayout } from '../../core/segmentLayout';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import { setImagePosition, setImageScale } from '../edit/imageOps';
import { addShape, moveShape, selectShape, setShapePoints } from '../edit/shapeOps';
import { thicknessToPx } from '../../core/shapeStyle';
import {
  fitContentRect,
  telopBoxRect,
  pointerToPosition,
  pointerToScale,
  videoInsertBoxRect,
  pointerToVideoInsertPosition,
  pointerToVideoInsertScale,
  type Rect,
} from './overlayGeometry';
import { snapPosition, SNAP_LINES } from './previewSnap';
import { visibleTelopBoxes } from './visibleTelopBoxes';
import { findMeasureRoot, measureTelopHits } from './measureBox';
import { useMeasuredBox, type MeasuredKind } from './useMeasuredBox';
import { playbackToOriginal } from '../../core/cutEngine';
import { cutOrderingOf } from '../../core/cutOrder';
import type { SpeedSegment } from '../../core/speedEngine';
import type { PlaybackOverlap } from '../../core/transitionEngine';
import { playerToPlayback } from '../../preview/speedBridge';
import { pointerToVideoPoint } from '../../core/shapeStyle';
import { telopScaleOriginY, telopVCoeff } from '../../preview/telopLayout';

/** Toolbar から受け取る描画ツール種別。null なら選択・ドラッグモード。 */
export type DrawingKind = ShapeKind | null;

interface PreviewOverlayProps {
  /** composition（動画）解像度。content 矩形の算出に使う。 */
  compWidth: number;
  compHeight: number;
  /** 編集状態。選択テロップの取得元。 */
  state: EditState;
  /** ライブ更新（履歴を積まない・ドラッグ追従用）。 */
  onLive: (next: EditState) => void;
  /** 確定更新（履歴を 1 件積む・ドラッグ終了用）。 */
  onEdit: (next: EditState) => void;
  /** 現在フレーム購読用。クリック選択の可視判定に使う。 */
  playerRef: RefObject<PlayerRef | null>;
  /** 描画ツール種別（null なら通常の選択・移動モード）。 */
  drawingKind?: DrawingKind;
  /**
   * TELOP_CONFIG.bottomOffset（px）。選択枠と当たり判定の**アンカー**をプロジェクトの
   * 実描画位置へ合わせる（golf-short-gold は 540・標準 short は 200）。
   * 省略・null なら標準値。移動量係数は標準固定のまま（書き出し一致契約）。
   */
  telopBottomOffset?: number | null;
  /** メイン動画速度（倍率・未指定＝1）。Player の現在フレーム（速度後）を再生座標へ戻すのに使う。 */
  mainSpeed?: number;
  /** 区間ごと速度の区間（null なら一律 mainSpeed）。playerToPlayback で使う。 */
  speedSegments?: SpeedSegment[] | null;
  /** 速度前（speedScale 前）の境界重なり。playerToPlayback で使う。 */
  playbackOverlaps?: PlaybackOverlap[];
}

type Corner = 'nw' | 'ne' | 'sw' | 'se';
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];

/** @remotion/player のコントロールバー想定高さ（px）。移動ドラッグ面はこの下端帯を避ける。 */
const CONTROLS_RESERVED = 48;

/**
 * 移動ドラッグ面の最低高さ（px）。実測枠は文字の高さそのもので薄く、下端が
 * コントロールバー帯にかかると掴み面が消えるため、この高さまでは枠の上へ伸ばして確保する。
 */
const MIN_GRAB_HEIGHT = 24;

/** テロップのヒット領域をオンデマンド測定する最短間隔（ms）。pointermove の連射を間引く。 */
const HIT_SCAN_INTERVAL_MS = 100;

/** 測定済みヒット領域の同値判定（同値なら state を更新せず再描画を起こさない）。 */
function sameHits(a: { id: number; rect: Rect }[], b: { id: number; rect: Rect }[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    return x.id === y.id && x.rect.x === y.rect.x && x.rect.y === y.rect.y && x.rect.w === y.rect.w && x.rect.h === y.rect.h;
  });
}

/** ドラッグ基準値。座標はすべて client 座標で保持する。 */
interface DragBase {
  mode: 'move' | 'scale';
  /** ドラッグ開始時の不変スナップショット（履歴汚染防止）。 */
  before: EditState;
  kind: 'telop' | 'videoInsert' | 'image' | 'mainVideo' | 'cutSegment';
  targetId: number;
  /**
   * ドラッグ開始時点のテロップ複数選択集合（kind !== 'telop' なら空）。
   * ドラッグ中に選択が変わっても対象を動かさないよう、開始時の ids をここで固定する。
   * サイズ 2 以上なら選択全員へ同値適用（Inspector パネルと同じ「揃える」意味論）。
   */
  telopIds: number[];
  /** pointerdown 時の client 座標。 */
  pointerX: number;
  pointerY: number;
  /** content 矩形（stage ローカル座標）。 */
  content: Rect;
  /** composition（動画）解像度。縦係数（telopVCoeff）算出に使う。 */
  compW: number;
  compH: number;
  /** move: 開始 position。 */
  startX: number;
  startY: number;
  /** scale: 開始スケール・ボックス中心・掴んだ角（client 座標）。 */
  startScale: number;
  centerX: number;
  centerY: number;
  cornerX: number;
  cornerY: number;
}

/** 描画モードのドラッグ状態（shape 描画中）。 */
interface ShapeDragBase {
  kind: ShapeKind;
  /** pointerdown 時の client 座標。 */
  startClientX: number;
  startClientY: number;
  /** pointerdown 時の video 正規化座標 (0..1)。 */
  startX: number;
  startY: number;
  /** 現在 client 座標（ライブプレビュー用）。 */
  currentClientX: number;
  currentClientY: number;
  /** ドラッグ開始時の原本フレーム。 */
  originalFrame: number;
  /** ドラッグ開始時の state スナップショット（確定に使う）。 */
  before: EditState;
  /** ドラッグ開始時の content 矩形（video 正規化座標の変換に使う）。 */
  contentRect: { left: number; top: number; width: number; height: number };
}

/** 図形ハンドルが掴む論理端点の組合せ（x 成分キー・y 成分キー）。 */
type ShapeHandleKey = 'x1y1' | 'x2y2' | 'x1y2' | 'x2y1';
const RECT_HANDLES: ShapeHandleKey[] = ['x1y1', 'x2y1', 'x1y2', 'x2y2'];
const LINE_HANDLES: ShapeHandleKey[] = ['x1y1', 'x2y2'];

/** 図形のヒット帯に足す余白（px・細い線でも掴めるようにする）。 */
const SHAPE_HIT_MARGIN_PX = 10;

/** 図形の編集ドラッグ基準値（本体移動 / ハンドルでリサイズ）。 */
interface ShapeEditBase {
  mode: 'move' | 'handle';
  id: number;
  /** ドラッグ開始時のスナップショット（選択のみ反映済み・履歴汚染防止）。 */
  before: EditState;
  /** pointerdown 時の client 座標。 */
  pointerX: number;
  pointerY: number;
  /** content 矩形（stage ローカル座標）。 */
  content: Rect;
  /** ドラッグ開始時の 4 点（ハンドルは掴んだ成分へ移動量を足す）。 */
  points: { x1: number; y1: number; x2: number; y2: number };
  /** ハンドルが動かす成分（mode='handle' のときのみ意味を持つ）。 */
  xKey: 'x1' | 'x2';
  yKey: 'y1' | 'y2';
}

/** プレビュー上でテロップの位置・大きさを直接ドラッグ調整するオーバーレイ（spec §9）。 */
export function PreviewOverlay({
  compWidth,
  compHeight,
  state,
  onLive,
  onEdit,
  playerRef,
  drawingKind = null,
  telopBottomOffset = null,
  mainSpeed = 1,
  speedSegments = null,
  playbackOverlaps = [],
}: PreviewOverlayProps) {
  const speedView = { speedSegments, playbackOverlaps, mainSpeed };
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const dragRef = useRef<DragBase | null>(null);
  const movedRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  // onLive/onEdit/state を ref に逃がし、drag-effect の依存配列を最小化する（I-1）。
  const cbRef = useRef({ onLive, onEdit });
  useEffect(() => { cbRef.current = { onLive, onEdit }; });

  // state を ref で最新を保持する（描画モードの onUp で使う）。
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; });

  // 描画ドラッグ状態（shape 描画モードのドラッグ追跡）。
  // Rules of Hooks: フック呼出はすべて最上位で行う（早期 return の前に全宣言）。
  const shapeDragRef = useRef<ShapeDragBase | null>(null);
  const [shapeDragging, setShapeDragging] = useState(false);
  // 描画中のプレビュー（始点・現在点）。
  const [shapeLive, setShapeLive] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  // ドラッグ中に吸着したガイド（表示用）。
  const [guide, setGuide] = useState<{ x: number | null; y: number | null }>({
    x: null,
    y: null,
  });

  // ルート要素（= pv-stage 全面）のサイズを ResizeObserver で追従する。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const selection = state.selection;
  const selectedTelop: EditorTelop | undefined =
    selection?.kind === 'telop' ? state.telops.find((t) => t.id === selection.id) : undefined;
  const selectedVideoInsert: EditorVideoInsert | undefined =
    selection?.kind === 'videoInsert' ? state.videoInserts.find((v) => v.id === selection.id) : undefined;
  const selectedImage: EditorImage | undefined =
    selection?.kind === 'image' ? state.images.find((i) => i.id === selection.id) : undefined;
  const target: EditorTelop | EditorVideoInsert | EditorImage | undefined =
    selectedTelop ?? selectedVideoInsert ?? selectedImage;
  const isMainVideo = selection?.kind === 'mainVideo';
  const isCutSegment = selection?.kind === 'cutSegment';
  const targetKind: 'telop' | 'videoInsert' | 'image' | 'mainVideo' | 'cutSegment' | null =
    selectedTelop ? 'telop' : selectedVideoInsert ? 'videoInsert' : selectedImage ? 'image' : isMainVideo ? 'mainVideo' : isCutSegment ? 'cutSegment' : null;

  // content 矩形（stage 左上原点のローカル座標）。
  const content = useMemo(
    () => fitContentRect(size.w, size.h, compWidth, compHeight),
    [size.w, size.h, compWidth, compHeight],
  );

  // content を ref で保持（shape 描画の pointerup 時に使う）。
  const contentRef = useRef(content);
  useEffect(() => { contentRef.current = content; });

  const mainLayout = state.mainLayout ?? DEFAULT_MAIN_LAYOUT;
  const segLayout = isCutSegment && selection?.kind === 'cutSegment'
    ? resolveSegmentLayout(mainLayout, state.segmentLayouts, selection.id)
    : null;
  const position = isMainVideo ? mainLayout.position : segLayout ? segLayout.position : (target?.position ?? { x: 0, y: 0 });
  const scale = isMainVideo ? mainLayout.scale : segLayout ? segLayout.scale : (target?.scale ?? 1);
  // 従来式（計算による近似）の枠。実測できないときのフォールバックとして常に持つ。
  const fallbackBox =
    targetKind === 'videoInsert' || targetKind === 'image' || targetKind === 'mainVideo' || targetKind === 'cutSegment'
      ? videoInsertBoxRect(content, position, scale)
      : telopBoxRect(content, position, scale, compWidth, compHeight, telopBottomOffset);
  // 実測枠（telop / image / videoInsert のみ。mainVideo / cutSegment は全画面＝実描画そのもの）。
  // **ドラッグ中も測定を続ける**（レビュー P1-1）。移動量の基準は DragBase の snapshot が
  // 凍結しているので、表示まで止めると枠だけが掴んだ位置に置き去りになる。
  const measuredKind: MeasuredKind | null =
    targetKind === 'telop' || targetKind === 'image' || targetKind === 'videoInsert'
      ? targetKind
      : null;
  const measured = useMeasuredBox({
    rootRef,
    kind: measuredKind,
    id: measuredKind === null ? null : (target?.id ?? null),
    playerRef,
  });
  const box = measured.rect ?? fallbackBox;
  const boxSource = measured.source;
  // 移動ドラッグ面（box 内ローカル座標）。上下とも stage 内へクランプする。
  //  - 下端: コントロールバー帯にかかるとプレイヤーのシークバー操作を奪うため避ける。
  //  - 上端: 枠が stage 上端より上へ出る（gold 等で y 上限まで動かした場合）と掴み面ごと
  //    画面外に出て掴めなくなるため、stage 内へ押し下げる。
  //  - 実測枠は従来の近似枠よりずっと薄い（文字の高さそのもの）ため、下端がコントロール帯に
  //    かかると掴み面が数 px まで痩せて掴めなくなる。その場合は**枠の上へ**帯を伸ばして
  //    最低限の掴み面を確保する（コントロール帯は侵さないまま stage 内で上へ逃がす）。
  const grabBottom = Math.min(box.h, size.h - CONTROLS_RESERVED - box.y);
  const grabTopBase = Math.max(0, -box.y);
  const grabTop =
    grabBottom - grabTopBase < MIN_GRAB_HEIGHT
      ? Math.max(-box.y, grabBottom - MIN_GRAB_HEIGHT)
      : grabTopBase;
  const grabHeight = Math.max(0, grabBottom - grabTop);

  // ドラッグ中の window リスナ（move / scale 共通）。
  useEffect(() => {
    if (!dragging) return;
    // d（DragBase）と pointer イベントから次状態とガイドを算出する（M-1）。
    function computeNext(
      d: DragBase,
      e: PointerEvent,
    ): { next: EditState; guideX: number | null; guideY: number | null } {
      // videoInsert と image は「全画面中央＋position＋scale」で幾何が共通（サブ動画の式を流用）。
      const fullFrame = d.kind === 'videoInsert' || d.kind === 'image' || d.kind === 'mainVideo' || d.kind === 'cutSegment';
      if (d.mode === 'move') {
        const raw = fullFrame
          ? pointerToVideoInsertPosition(d.content, { x: d.startX, y: d.startY }, e.clientX - d.pointerX, e.clientY - d.pointerY)
          : pointerToPosition(d.content, { x: d.startX, y: d.startY }, e.clientX - d.pointerX, e.clientY - d.pointerY, d.compW, d.compH);
        const snapped = snapPosition(raw);
        const next =
          d.kind === 'image'
            ? setImagePosition(d.before, d.targetId, snapped.position.x, snapped.position.y)
            : d.kind === 'videoInsert'
              ? setVideoInsertPosition(d.before, d.targetId, snapped.position.x, snapped.position.y)
              : d.kind === 'mainVideo'
                ? setMainVideoPosition(d.before, snapped.position.x, snapped.position.y)
                : d.kind === 'cutSegment'
                  ? setSegmentPosition(d.before, d.targetId, snapped.position.x, snapped.position.y)
                  : d.telopIds.length >= 2
                    ? setTelopsPosition(d.before, d.telopIds, snapped.position.x, snapped.position.y)
                    : setTelopPosition(d.before, d.targetId, snapped.position.x, snapped.position.y);
        return { next, guideX: snapped.guideX, guideY: snapped.guideY };
      } else {
        const s = fullFrame
          ? pointerToVideoInsertScale(d.centerX, d.centerY, d.cornerX, d.cornerY, e.clientX, e.clientY, d.startScale)
          : pointerToScale(d.centerX, d.centerY, d.cornerX, d.cornerY, e.clientX, e.clientY, d.startScale);
        const next =
          d.kind === 'image'
            ? setImageScale(d.before, d.targetId, s)
            : d.kind === 'videoInsert'
              ? setVideoInsertScale(d.before, d.targetId, s)
              : d.kind === 'mainVideo'
                ? setMainVideoScale(d.before, s)
                : d.kind === 'cutSegment'
                  ? setSegmentScale(d.before, d.targetId, s)
                  : d.telopIds.length >= 2
                    ? setTelopsScale(d.before, d.telopIds, s)
                    : setTelopScale(d.before, d.targetId, s);
        return { next, guideX: null, guideY: null };
      }
    }
    function onMove(e: PointerEvent): void {
      const d = dragRef.current;
      if (d === null) return;
      movedRef.current = true;
      const { next, guideX, guideY } = computeNext(d, e);
      setGuide({ x: guideX, y: guideY });
      cbRef.current.onLive(next);
    }
    function onUp(e: PointerEvent): void {
      const d = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      setGuide({ x: null, y: null });
      if (d === null) return;
      if (!movedRef.current) {
        // 実際の移動が無ければ no-op 履歴を積まない（current は触れていない）。
        return;
      }
      // current を before へ戻し、確定を 1 件だけ積む（履歴汚染防止）。
      cbRef.current.onLive(d.before);
      const { next } = computeNext(d, e);
      // 値が 1 件も変わらなかった（ops が同一参照を返した）なら空の Undo を積まない。
      if (next === d.before) return;
      cbRef.current.onEdit(next);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging]);

  // 描画モードのドラッグ window リスナ（shapeDragging が true のとき有効）。
  // stateRef / cbRef / contentRef 経由でクロージャー外の最新値を参照する。
  useEffect(() => {
    if (!shapeDragging) return;
    function onMove(e: PointerEvent): void {
      const d = shapeDragRef.current;
      if (d === null) return;
      // pointerdown で確定した「絶対座標の」content 矩形を使う。stage ローカル座標の
      // contentRef.current は rootRect オフセット（左パネル等）を欠くため、絶対 clientX/Y と
      // 混ぜると終点が画面左端ぶんズレてクランプする（縦動画＋左パネルで特に顕著）。
      const ptCurrent = pointerToVideoPoint(e.clientX, e.clientY, d.contentRect);
      setShapeLive({
        startX: d.startX,
        startY: d.startY,
        currentX: ptCurrent.x,
        currentY: ptCurrent.y,
      });
      // ライブ（履歴なし）更新: ドラッグ追従。
      cbRef.current.onLive(
        addShape(
          d.before,
          d.kind,
          d.startX,
          d.startY,
          ptCurrent.x,
          ptCurrent.y,
          d.originalFrame,
        ),
      );
    }
    function onUp(e: PointerEvent): void {
      const d = shapeDragRef.current;
      shapeDragRef.current = null;
      setShapeDragging(false);
      setShapeLive(null);
      if (d === null) return;
      // 極小移動（クリックに近い）は無視。
      const dist = Math.hypot(e.clientX - d.startClientX, e.clientY - d.startClientY);
      if (dist < 5) {
        // ライブ上書き分を戻す。
        cbRef.current.onLive(d.before);
        return;
      }
      // pointerdown で確定した絶対座標の content 矩形を使う（onMove と同じ理由）。
      const ptEnd = pointerToVideoPoint(e.clientX, e.clientY, d.contentRect);
      // ライブ（before への一時差し戻し）→ 確定 1 件を履歴に積む。
      cbRef.current.onLive(d.before);
      cbRef.current.onEdit(
        addShape(d.before, d.kind, d.startX, d.startY, ptEnd.x, ptEnd.y, d.originalFrame),
      );
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [shapeDragging]);

  // 現在の再生フレームを購読し、可視テロップのヒット領域算出に使う。
  const [playbackFrame, setPlaybackFrame] = useState(0);
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (e: { detail: { frame: number } }): void => setPlaybackFrame(e.detail.frame);
    player.addEventListener('frameupdate', onFrame);
    return () => player.removeEventListener('frameupdate', onFrame);
  }, [playerRef]);

  // テロップのヒット領域を pointer イベント時にオンデマンド測定する（裁定 P1-5）。
  // 可視テロップ全件を毎フレーム測るのは高くつくので、ポインタが stage に入って
  // 動いたときだけ測る。測れた分だけ従来式の矩形を置き換える。
  const [measuredHits, setMeasuredHits] = useState<{ id: number; rect: Rect }[]>([]);
  const lastHitScanRef = useRef(0);
  useEffect(() => {
    const overlay = rootRef.current;
    const stage = overlay?.parentElement ?? null;
    if (overlay === null || stage === null) return;
    function onPointerMove(): void {
      // ドラッグ中（移動・拡縮／図形描画／図形編集）は走査しない。
      if (dragRef.current !== null || shapeDragRef.current !== null || shapeEditRef.current !== null) {
        return;
      }
      const now = Date.now();
      if (now - lastHitScanRef.current < HIT_SCAN_INTERVAL_MS) return;
      lastHitScanRef.current = now;
      const el = rootRef.current;
      if (el === null) return;
      const root = findMeasureRoot(el.parentElement ?? el);
      if (root === null) return;
      const next = measureTelopHits(root, {
        frame: root.getBoundingClientRect(),
        origin: el.getBoundingClientRect(),
      });
      setMeasuredHits((prev) => (sameHits(prev, next) ? prev : next));
    }
    stage.addEventListener('pointermove', onPointerMove);
    return () => stage.removeEventListener('pointermove', onPointerMove);
  }, []);

  // テロップが編集されたら測定済みヒット領域を捨てる（古い矩形でクリック判定しない）。
  // 次の pointermove で測り直され、それまでは従来式の矩形が使われる。
  useEffect(() => {
    setMeasuredHits((prev) => (prev.length === 0 ? prev : []));
  }, [state.telops]);

  // stage のリサイズでも捨てる（レターボックスが変わると測定値は全部ずれる）。
  // size は root の ResizeObserver が更新する値なので、これを依存に置けば追従できる。
  useEffect(() => {
    setMeasuredHits((prev) => (prev.length === 0 ? prev : []));
  }, [size.w, size.h]);

  // 現在フレームで可視のテロップの box 一覧（クリック選択ヒット領域用）。
  const hitTelops = useMemo(
    () => {
      // playbackFrame は Player の速度後フレーム。playerToPlayback で再生座標へ戻してから原本へ。
      const orig = playbackToOriginal(playerToPlayback(playbackFrame, speedView), state.cutRegions, cutOrderingOf(state));
      return visibleTelopBoxes(state.telops, orig, content, compWidth, compHeight, telopBottomOffset);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playbackFrame, mainSpeed, speedSegments, playbackOverlaps, state.cutRegions, state.telops, content, compWidth, compHeight, telopBottomOffset],
  );

  // 実測できたテロップだけ矩形を差し替える（測れなかった分は従来式のまま＝補完）。
  const hitBoxes = useMemo(
    () =>
      hitTelops.map((h) => {
        const m = measuredHits.find((x) => x.id === h.id);
        return m === undefined ? h : { id: h.id, rect: m.rect };
      }),
    [hitTelops, measuredHits],
  );

  // 現在フレームで可視の図形（ヒット領域・選択枠は可視のものだけに出す）。
  // 再生→原本フレームの変換はテロップのヒット判定と同経路（裁定 P2-4）。
  const visibleShapes = useMemo(
    () => {
      const orig = playbackToOriginal(playerToPlayback(playbackFrame, speedView), state.cutRegions, cutOrderingOf(state));
      return state.shapes.filter((s) => s.originalStart <= orig && orig < s.originalEnd);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playbackFrame, mainSpeed, speedSegments, playbackOverlaps, state.cutRegions, state.shapes],
  );

  // 図形の編集ドラッグ（本体移動 / ハンドルでリサイズ）。
  const shapeEditRef = useRef<ShapeEditBase | null>(null);
  const [shapeEditing, setShapeEditing] = useState(false);
  useEffect(() => {
    if (!shapeEditing) return;
    /** ドラッグ中の次状態を算出する（live も commit も同じ式を通す）。 */
    function computeNext(d: ShapeEditBase, e: PointerEvent): EditState {
      if (d.mode === 'move') {
        const dx = (e.clientX - d.pointerX) / d.content.w;
        const dy = (e.clientY - d.pointerY) / d.content.h;
        return moveShape(d.before, d.id, dx, dy);
      }
      // **差分ベース**（レビュー P2-3）。掴んだ点を端点の絶対位置とみなすと、ハンドルの
      // 中心からずれて掴んだぶんだけ端点がポインタへ飛ぶ（動かしていないのに変形する）。
      const p = { ...d.points };
      p[d.xKey] = d.points[d.xKey] + (e.clientX - d.pointerX) / d.content.w;
      p[d.yKey] = d.points[d.yKey] + (e.clientY - d.pointerY) / d.content.h;
      return setShapePoints(d.before, d.id, p.x1, p.y1, p.x2, p.y2);
    }
    function onMove(e: PointerEvent): void {
      const d = shapeEditRef.current;
      if (d === null || d.content.w <= 0 || d.content.h <= 0) return;
      cbRef.current.onLive(computeNext(d, e));
    }
    function onUp(e: PointerEvent): void {
      const d = shapeEditRef.current;
      shapeEditRef.current = null;
      setShapeEditing(false);
      if (d === null || d.content.w <= 0 || d.content.h <= 0) return;
      // live を before（選択のみ反映した状態）へ戻し、確定を 1 件だけ積む。
      cbRef.current.onLive(d.before);
      const next = computeNext(d, e);
      // ops が同一参照を返した＝値が動いていない → 空の Undo を積まない。
      if (next === d.before) return;
      cbRef.current.onEdit(next);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [shapeEditing]);

  // --- ここから下でフックは呼ばない（早期 return 可）。 ---

  /** 図形の本体ドラッグ（移動）を開始する。pointerdown 時点で選択も動かす。 */
  function beginShapeMove(s: EditorShape, e: React.PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    // 選択は履歴を積まない（onLive）。移動が起きたときだけ確定 1 件を積む。
    const before = clearMultiSelection(selectShape(state, s.id));
    shapeEditRef.current = {
      mode: 'move',
      id: s.id,
      before,
      pointerX: e.clientX,
      pointerY: e.clientY,
      content,
      points: { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 },
      xKey: 'x1',
      yKey: 'y1',
    };
    onLive(before);
    setShapeEditing(true);
  }

  /** 図形のハンドルドラッグ（リサイズ）を開始する。掴んだ成分だけを更新する。 */
  function beginShapeHandle(
    s: EditorShape,
    xKey: 'x1' | 'x2',
    yKey: 'y1' | 'y2',
    e: React.PointerEvent,
  ): void {
    e.preventDefault();
    e.stopPropagation();
    const before = clearMultiSelection(selectShape(state, s.id));
    shapeEditRef.current = {
      mode: 'handle',
      id: s.id,
      before,
      pointerX: e.clientX,
      pointerY: e.clientY,
      content,
      points: { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 },
      xKey,
      yKey,
    };
    onLive(before);
    setShapeEditing(true);
  }

  /**
   * 図形のヒット領域（可視のみ・描画順の後勝ち）と、選択中図形の枠・ハンドルを描く。
   * ヒットは SVG の形状そのものに当てる: 線・矢印は stroke 帯（＝点と線分の距離判定）、
   * 矩形・楕円は内部（fill）。斜め線の bbox が背後のテロップ操作を奪わない（裁定 P1-9）。
   */
  function renderShapeLayer(): React.ReactElement | null {
    if (content.w <= 0 || content.h <= 0 || visibleShapes.length === 0) return null;
    const sx = (n: number): number => content.x + n * content.w;
    const sy = (n: number): number => content.y + n * content.h;
    const selected =
      selection?.kind === 'shape'
        ? visibleShapes.find((s) => s.id === selection.id)
        : undefined;
    return (
      <>
        <svg className="pv-shape-hits" width="100%" height="100%">
          {visibleShapes.map((s) => {
            const x1 = sx(s.x1);
            const y1 = sy(s.y1);
            const x2 = sx(s.x2);
            const y2 = sy(s.y2);
            const onDown = (e: React.PointerEvent): void => beginShapeMove(s, e);
            if (s.kind === 'rect') {
              return (
                <rect
                  key={s.id}
                  data-sme-shape-hit={s.id}
                  x={Math.min(x1, x2)}
                  y={Math.min(y1, y2)}
                  width={Math.abs(x2 - x1)}
                  height={Math.abs(y2 - y1)}
                  fill="transparent"
                  pointerEvents="fill"
                  onPointerDown={onDown}
                />
              );
            }
            if (s.kind === 'ellipse') {
              return (
                <ellipse
                  key={s.id}
                  data-sme-shape-hit={s.id}
                  cx={(x1 + x2) / 2}
                  cy={(y1 + y2) / 2}
                  rx={Math.abs(x2 - x1) / 2}
                  ry={Math.abs(y2 - y1) / 2}
                  fill="transparent"
                  pointerEvents="fill"
                  onPointerDown={onDown}
                />
              );
            }
            return (
              <line
                key={s.id}
                data-sme-shape-hit={s.id}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="transparent"
                strokeWidth={thicknessToPx(s.thickness, content.h) + SHAPE_HIT_MARGIN_PX * 2}
                strokeLinecap="round"
                pointerEvents="stroke"
                onPointerDown={onDown}
              />
            );
          })}
        </svg>
        {selected !== undefined && (
          <>
            <div
              className="pv-shape-box"
              style={{
                left: Math.min(sx(selected.x1), sx(selected.x2)),
                top: Math.min(sy(selected.y1), sy(selected.y2)),
                width: Math.abs(sx(selected.x2) - sx(selected.x1)),
                height: Math.abs(sy(selected.y2) - sy(selected.y1)),
              }}
            />
            {(selected.kind === 'line' || selected.kind === 'arrow'
              ? LINE_HANDLES
              : RECT_HANDLES
            ).map((k) => {
              // 論理端点の組合せ（交差は許容＝端点の役割が入れ替わっても破綻しない）。
              const xKey = k.slice(0, 2) as 'x1' | 'x2';
              const yKey = k.slice(2) as 'y1' | 'y2';
              return (
                <div
                  key={k}
                  className="pv-shape-handle"
                  data-sme-shape-handle={k}
                  style={{ left: sx(selected[xKey]), top: sy(selected[yKey]) }}
                  onPointerDown={(e) => beginShapeHandle(selected, xKey, yKey, e)}
                />
              );
            })}
          </>
        )}
      </>
    );
  }

  // 描画モードのキャンバス全面 pointerdown ハンドラ。
  function handleDrawPointerDown(e: React.PointerEvent): void {
    if (drawingKind === null) return;
    e.preventDefault();
    e.stopPropagation();
    const cx = contentRef.current;
    const rootEl = rootRef.current;
    if (!rootEl) return;
    const rootRect = rootEl.getBoundingClientRect();
    const pt = pointerToVideoPoint(e.clientX, e.clientY, {
      left: rootRect.left + cx.x,
      top: rootRect.top + cx.y,
      width: cx.w,
      height: cx.h,
    });
    const currentState = stateRef.current;
    // playbackFrame は Player の速度後フレーム。playerToPlayback で再生座標へ戻してから原本へ。
    const frame = playbackToOriginal(playerToPlayback(playbackFrame, speedView), currentState.cutRegions, cutOrderingOf(currentState));
    shapeDragRef.current = {
      kind: drawingKind,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: pt.x,
      startY: pt.y,
      currentClientX: e.clientX,
      currentClientY: e.clientY,
      originalFrame: frame,
      before: currentState,
      contentRect: {
        left: rootRect.left + cx.x,
        top: rootRect.top + cx.y,
        width: cx.w,
        height: cx.h,
      },
    };
    setShapeDragging(true);
  }

  // 描画モード: 描画中の SVG プレビュー（画面座標で表示）。
  const shapePreview = shapeLive && content.w > 0
    ? {
        x1: content.x + shapeLive.startX * content.w,
        y1: content.y + shapeLive.startY * content.h,
        x2: content.x + shapeLive.currentX * content.w,
        y2: content.y + shapeLive.currentY * content.h,
      }
    : null;

  // 描画モードのとき: root 全面を透明なキャンバスとして描画捕捉。
  if (drawingKind !== null) {
    return (
      <div
        ref={rootRef}
        className="pv-overlay pv-drawing"
        style={{ cursor: 'crosshair' }}
        onPointerDown={handleDrawPointerDown}
      >
        {/* 描画中のライブプレビュー SVG。 */}
        {shapePreview && (
          <svg
            className="pv-shape-preview"
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              overflow: 'visible',
            }}
            width="100%"
            height="100%"
          >
            {drawingKind === 'rect' ? (
              <rect
                x={Math.min(shapePreview.x1, shapePreview.x2)}
                y={Math.min(shapePreview.y1, shapePreview.y2)}
                width={Math.abs(shapePreview.x2 - shapePreview.x1)}
                height={Math.abs(shapePreview.y2 - shapePreview.y1)}
                fill="none"
                stroke="#FF3B30"
                strokeWidth={2}
                strokeDasharray="4 2"
              />
            ) : drawingKind === 'ellipse' ? (
              <ellipse
                cx={(shapePreview.x1 + shapePreview.x2) / 2}
                cy={(shapePreview.y1 + shapePreview.y2) / 2}
                rx={Math.abs(shapePreview.x2 - shapePreview.x1) / 2}
                ry={Math.abs(shapePreview.y2 - shapePreview.y1) / 2}
                fill="none"
                stroke="#FF3B30"
                strokeWidth={2}
                strokeDasharray="4 2"
              />
            ) : (
              <line
                x1={shapePreview.x1}
                y1={shapePreview.y1}
                x2={shapePreview.x2}
                y2={shapePreview.y2}
                stroke="#FF3B30"
                strokeWidth={2}
                strokeDasharray="4 2"
                markerEnd={drawingKind === 'arrow' ? 'url(#pv-arrow-head)' : undefined}
              />
            )}
            {drawingKind === 'arrow' && (
              <defs>
                <marker
                  id="pv-arrow-head"
                  markerWidth="8"
                  markerHeight="8"
                  refX="6"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L0,6 L8,3 z" fill="#FF3B30" />
                </marker>
              </defs>
            )}
          </svg>
        )}
      </div>
    );
  }

  if ((!target && !isMainVideo && !isCutSegment) || targetKind === null) {
    // 選択が無いときも root は描画し、ResizeObserver でサイズを測り続ける。
    // 未選択テロップのヒット領域は描画しておく（クリックで選択できるように）。
    return (
      <div ref={rootRef} className="pv-overlay">
        {renderShapeLayer()}
        {hitBoxes.map((h) => (
          <div
            key={h.id}
            className="pv-hit"
            style={{ left: h.rect.x, top: h.rect.y, width: h.rect.w, height: h.rect.h }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onLive(clearMultiSelection({ ...state, selection: { kind: 'telop', id: h.id } }));
            }}
          />
        ))}
      </div>
    );
  }
  // 早期 return 後: target と targetKind が narrow 済みであることをアサートする。
  const narrowKind: 'telop' | 'videoInsert' | 'image' | 'mainVideo' | 'cutSegment' = targetKind;
  const targetId = isCutSegment && selection?.kind === 'cutSegment' ? selection.id : (target?.id ?? 0); // mainVideo は id を持たない（reducer が id 非使用）

  /**
   * ドラッグ開始時点のテロップ複数選択集合を確定する（テロップ以外は空）。
   * 不変条件（editState.normalizeMultiSelection）により、集合は空かサイズ 2 以上で
   * プライマリを含むかのどちらかしか取らない。
   */
  function dragTelopIds(): number[] {
    return narrowKind === 'telop' ? state.multiTelopIds : [];
  }

  /** root（= pv-stage）の client 座標左上を返す。pointerdown 時に呼ぶ。 */
  function rootOrigin(): { left: number; top: number } {
    const r = rootRef.current?.getBoundingClientRect();
    return { left: r?.left ?? 0, top: r?.top ?? 0 };
  }

  /**
   * 拡縮の不動点（stage ローカル座標）。**枠（実測・近似のどちらでも）からは導出しない**。
   * - テロップ: 実描画の transformOrigin と同式（`telopScaleOriginY` / `telopVCoeff` / position）
   * - 画像・サブ動画・メイン動画・区間: フレーム中心＋position の平行移動（scale 非依存）
   */
  function scaleAnchorPoint(): { x: number; y: number } {
    if (narrowKind === 'telop') {
      return {
        x: content.x + content.w / 2 + (position.x * content.w) / 2,
        y:
          content.y +
          content.h *
            (telopScaleOriginY(compWidth, compHeight) / 100 +
              position.y * telopVCoeff(compWidth, compHeight)),
      };
    }
    const r = videoInsertBoxRect(content, position, 1);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  function beginMove(e: React.PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    movedRef.current = false;
    dragRef.current = {
      mode: 'move',
      before: state,
      kind: narrowKind,
      targetId,
      telopIds: dragTelopIds(),
      pointerX: e.clientX,
      pointerY: e.clientY,
      content,
      compW: compWidth,
      compH: compHeight,
      startX: position.x,
      startY: position.y,
      startScale: scale,
      centerX: 0,
      centerY: 0,
      cornerX: 0,
      cornerY: 0,
    };
    setDragging(true);
  }

  function beginScale(corner: Corner, e: React.PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    movedRef.current = false;
    const origin = rootOrigin();
    // 拡縮の不動点は**幾何の正本から導出**する（レビュー P2-2）。
    // 実測枠の下端は「テキスト下端（anchor）」であって実描画の transformOrigin ではなく、
    // bottomOffset が非標準のプリセット（gold=540）では両者が食い違う。枠は「描画とハンドルの
    // 置き場所」だけに使い、scale の算出根拠には使わない。
    const anchor = scaleAnchorPoint();
    const centerX = origin.left + anchor.x;
    const centerY = origin.top + anchor.y;
    const cornerX = origin.left + (corner === 'nw' || corner === 'sw' ? box.x : box.x + box.w);
    const cornerY = origin.top + (corner === 'nw' || corner === 'ne' ? box.y : box.y + box.h);
    dragRef.current = {
      mode: 'scale',
      before: state,
      kind: narrowKind,
      targetId,
      telopIds: dragTelopIds(),
      pointerX: e.clientX,
      pointerY: e.clientY,
      content,
      compW: compWidth,
      compH: compHeight,
      startX: position.x,
      startY: position.y,
      startScale: scale,
      centerX,
      centerY,
      cornerX,
      cornerY,
    };
    setDragging(true);
  }

  // ガイド線（正規化）を content 上の画面座標へ変換する。
  const guideLineX = (norm: number): number => content.x + content.w / 2 + (norm * content.w) / 2;
  const guideLineY = (norm: number): number => content.y + content.h / 2 + (norm * content.h) / 2;
  const isPortrait = compHeight > compWidth;

  return (
    <div ref={rootRef} className="pv-overlay">
      {renderShapeLayer()}
      {/* 未選択テロップのヒット領域（選択中テロップ自身は除外・既存 grab/handle を優先）。 */}
      {hitBoxes
        .filter((h) => h.id !== (selection?.kind === 'telop' ? selection.id : -1))
        .map((h) => (
          <div
            key={h.id}
            className="pv-hit"
            style={{ left: h.rect.x, top: h.rect.y, width: h.rect.w, height: h.rect.h }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onLive(clearMultiSelection({ ...state, selection: { kind: 'telop', id: h.id } }));
            }}
          />
        ))}
      {/* セーフエリア枠（content の 5% インセット）。 */}
      <div
        className="pv-safe"
        style={{
          left: content.x + content.w * 0.05,
          top: content.y + content.h * 0.05,
          width: content.w * 0.9,
          height: content.h * 0.9,
        }}
      />
      {/* 縦動画はプラットフォーム UI 被り領域（下部）を薄く表示する。 */}
      {isPortrait && (
        <div
          className="pv-platform"
          style={{
            left: content.x,
            width: content.w,
            top: content.y + content.h * 0.82,
            height: content.h * 0.18,
          }}
        />
      )}
      {/* ドラッグ中だけスマートガイド（中央線・三分割線）を表示する。 */}
      {dragging &&
        SNAP_LINES.map((n) => (
          <div
            key={`gx${n}`}
            className={`pv-guide v${guide.x === n ? ' hit' : ''}`}
            style={{ left: guideLineX(n), top: content.y, height: content.h }}
          />
        ))}
      {dragging &&
        SNAP_LINES.map((n) => (
          <div
            key={`gy${n}`}
            className={`pv-guide h${guide.y === n ? ' hit' : ''}`}
            style={{ top: guideLineY(n), left: content.x, width: content.w }}
          />
        ))}
      {/* テロップ操作ボックス（枠は表示専用。本体ドラッグ＝移動、四隅ハンドル＝拡縮）。 */}
      <div
        className="pv-telop-box"
        // 枠の出所を観測可能にする（フォールバックに実測失敗を隠させない・裁定 P1-2）。
        data-sme-box-source={boxSource}
        style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      >
        {/* 移動ドラッグ面。コントロールバー帯にかかる下端は grabHeight で切り詰める。 */}
        {grabHeight > 0 && (
          <div
            className="pv-telop-grab"
            style={{ top: grabTop, height: grabHeight }}
            onPointerDown={beginMove}
          />
        )}
        {CORNERS.map((c) => (
          <div key={c} className={`pv-handle ${c}`} onPointerDown={(e) => beginScale(c, e)} />
        ))}
      </div>
    </div>
  );
}
