import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { EditorTelop, EditorVideoInsert, EditorImage, ShapeKind } from '../../core/types';
import type { EditState } from '../edit/editState';
import { setTelopPosition, setTelopScale } from '../edit/telopSettingsOps';
import { setVideoInsertPosition, setVideoInsertScale } from '../edit/videoInsertOps';
import { setMainVideoPosition, setMainVideoScale } from '../edit/mainVideoOps';
import { setSegmentPosition, setSegmentScale } from '../edit/segmentLayoutOps';
import { resolveSegmentLayout } from '../../core/segmentLayout';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import { setImagePosition, setImageScale } from '../edit/imageOps';
import { addShape } from '../edit/shapeOps';
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
import { playbackToOriginal } from '../../core/cutEngine';
import type { SpeedSegment } from '../../core/speedEngine';
import type { PlaybackOverlap } from '../../core/transitionEngine';
import { playerToPlayback } from '../../preview/speedBridge';
import { pointerToVideoPoint } from '../../core/shapeStyle';

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

/** ドラッグ基準値。座標はすべて client 座標で保持する。 */
interface DragBase {
  mode: 'move' | 'scale';
  /** ドラッグ開始時の不変スナップショット（履歴汚染防止）。 */
  before: EditState;
  kind: 'telop' | 'videoInsert' | 'image' | 'mainVideo' | 'cutSegment';
  targetId: number;
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

/** プレビュー上でテロップの位置・大きさを直接ドラッグ調整するオーバーレイ（spec §9）。 */
export function PreviewOverlay({
  compWidth,
  compHeight,
  state,
  onLive,
  onEdit,
  playerRef,
  drawingKind = null,
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
  const box =
    targetKind === 'videoInsert' || targetKind === 'image' || targetKind === 'mainVideo' || targetKind === 'cutSegment'
      ? videoInsertBoxRect(content, position, scale)
      : telopBoxRect(content, position, scale, compWidth, compHeight);
  // 移動ドラッグ面の高さ。stage 下端のコントロールバー帯にかからない範囲へクランプする
  // （かかるとプレイヤーのシークバー操作を奪うため）。box 内ローカル座標の高さ。
  const grabHeight = Math.max(0, Math.min(box.h, size.h - CONTROLS_RESERVED - box.y));

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

  // 現在フレームで可視のテロップの box 一覧（クリック選択ヒット領域用）。
  const hitTelops = useMemo(
    () => {
      // playbackFrame は Player の速度後フレーム。playerToPlayback で再生座標へ戻してから原本へ。
      const orig = playbackToOriginal(playerToPlayback(playbackFrame, speedView), state.cutRegions);
      return visibleTelopBoxes(state.telops, orig, content, compWidth, compHeight);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playbackFrame, mainSpeed, speedSegments, playbackOverlaps, state.cutRegions, state.telops, content, compWidth, compHeight],
  );

  // --- ここから下でフックは呼ばない（早期 return 可）。 ---

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
    const frame = playbackToOriginal(playerToPlayback(playbackFrame, speedView), currentState.cutRegions);
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
        {hitTelops.map((h) => (
          <div
            key={h.id}
            className="pv-hit"
            style={{ left: h.rect.x, top: h.rect.y, width: h.rect.w, height: h.rect.h }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onLive({ ...state, selection: { kind: 'telop', id: h.id } });
            }}
          />
        ))}
      </div>
    );
  }
  // 早期 return 後: target と targetKind が narrow 済みであることをアサートする。
  const narrowKind: 'telop' | 'videoInsert' | 'image' | 'mainVideo' | 'cutSegment' = targetKind;
  const targetId = isCutSegment && selection?.kind === 'cutSegment' ? selection.id : (target?.id ?? 0); // mainVideo は id を持たない（reducer が id 非使用）

  /** root（= pv-stage）の client 座標左上を返す。pointerdown 時に呼ぶ。 */
  function rootOrigin(): { left: number; top: number } {
    const r = rootRef.current?.getBoundingClientRect();
    return { left: r?.left ?? 0, top: r?.top ?? 0 };
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
    const centerX = origin.left + box.x + box.w / 2;
    const centerY = origin.top + box.y + box.h / 2;
    const cornerX = origin.left + (corner === 'nw' || corner === 'sw' ? box.x : box.x + box.w);
    const cornerY = origin.top + (corner === 'nw' || corner === 'ne' ? box.y : box.y + box.h);
    dragRef.current = {
      mode: 'scale',
      before: state,
      kind: narrowKind,
      targetId,
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
      {/* 未選択テロップのヒット領域（選択中テロップ自身は除外・既存 grab/handle を優先）。 */}
      {hitTelops
        .filter((h) => h.id !== (selection?.kind === 'telop' ? selection.id : -1))
        .map((h) => (
          <div
            key={h.id}
            className="pv-hit"
            style={{ left: h.rect.x, top: h.rect.y, width: h.rect.w, height: h.rect.h }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onLive({ ...state, selection: { kind: 'telop', id: h.id } });
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
        style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      >
        {/* 移動ドラッグ面。コントロールバー帯にかかる下端は grabHeight で切り詰める。 */}
        {grabHeight > 0 && (
          <div className="pv-telop-grab" style={{ height: grabHeight }} onPointerDown={beginMove} />
        )}
        {CORNERS.map((c) => (
          <div key={c} className={`pv-handle ${c}`} onPointerDown={(e) => beginScale(c, e)} />
        ))}
      </div>
    </div>
  );
}
