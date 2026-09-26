import type { TelopPosition } from '../../core/types';
import { telopBottomFrac, telopScaleOriginY, telopVCoeff, clampTelopX } from '../../preview/telopLayout';

/** 画面座標（左上原点）の矩形。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 数値を [min,max] へクランプする。 */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * composition (compW×compH) を stage (stageW×stageH) へ contain フィットさせたときの
 * 実表示矩形を返す（stage 左上原点）。@remotion/player のレターボックスと同じ
 * 「短辺合わせ・中央寄せ」。いずれかの寸法が 0 以下なら原点サイズ 0 の矩形。
 */
export function fitContentRect(
  stageW: number,
  stageH: number,
  compW: number,
  compH: number,
): Rect {
  if (stageW <= 0 || stageH <= 0 || compW <= 0 || compH <= 0) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  const scale = Math.min(stageW / compW, stageH / compH);
  const w = compW * scale;
  const h = compH * scale;
  return { x: (stageW - w) / 2, y: (stageH - h) / 2, w, h };
}

/** 操作ボックスの既定サイズ（content に対する割合）。1〜2行テロップに寄せた高さ。 */
export const BOX_FRAC_W = 0.76;
export const BOX_FRAC_H = 0.16;

/**
 * 枠アンカー（テロップ下端）の位置比を返す。
 *
 * プロジェクトの実描画位置は `TELOP_CONFIG.bottomOffset` で決まり、プリセットごとに違う
 * （ハーネス形式標準 short=200 / golf-short-gold=540）。**選択枠と当たり判定だけ**はこの
 * 実値へ合わせないと、枠が実描画テキストから離れて掴めなくなる。
 *
 * 読めない場合（null / undefined / 非有限・compH が 0 以下）は標準値へフォールバックする。
 * 戻り値は [0,1] へクランプする（壊れた設定値で枠が画面外へ暴走しない）。
 *
 * 注意: これは**表示アンカー専用**。移動量係数 `telopVCoeff` と書き出し側と同式の
 * `telopTransform` は標準固定のまま（2026-08-17 の「エディタ⇄書き出し一致」契約）。
 */
export function telopAnchorFrac(
  compW: number,
  compH: number,
  bottomOffset?: number | null,
): number {
  if (bottomOffset != null && Number.isFinite(bottomOffset) && compH > 0) {
    return clamp(bottomOffset / compH, 0, 1);
  }
  return telopBottomFrac(compW, compH);
}

/**
 * テロップの操作ボックス（バウンディングボックス）を画面座標で返す。
 * テロップは下端固定で描かれ、箱の下端をテロップ下端へ合わせる。
 * x は中心 50%・y は縦係数で上へ。
 *
 * **拡縮の下端**: 実描画（`EditorComposition` の TelopLayer / プロジェクト側 `TelopPlayer.tsx`）は
 * 全画面ラッパーへ scale を当て、`transformOrigin` Y は**標準固定**の `1 - telopBottomFrac`
 * （＝ origin）を使う。よってテキスト下端は origin から見て `(anchor - origin)` の距離にあり、
 * scale 倍される: `origin + (anchor - origin) * scale`。
 * 標準プロジェクトは anchor === origin なので第 2 項が消え、従来どおり
 * 「拡縮しても下端不変」へ**恒等に縮退**する。golf-short-gold（bottomOffset=540）だけ
 * origin ≠ anchor となり、拡大でテキスト下端が上がるのに枠が追従しない問題が出る。
 *
 * @param bottomOffset TELOP_CONFIG.bottomOffset（px）。枠の**アンカー**に効く
 *   （{@link telopAnchorFrac}）。省略・null なら標準値。
 */
export function telopBoxRect(
  content: Rect,
  position: TelopPosition,
  scale: number,
  compW: number,
  compH: number,
  bottomOffset?: number | null,
): Rect {
  const w = content.w * BOX_FRAC_W * scale;
  const h = content.h * BOX_FRAC_H * scale;
  // 上端からの比。origin＝実描画の transformOrigin（標準固定）、anchor＝テキスト下端（実値）。
  // origin は telopLayout.telopScaleOriginY（実描画が使う正本）から取り、定数を写経しない。
  const originFrac = telopScaleOriginY(compW, compH) / 100;
  const anchorFrac = 1 - telopAnchorFrac(compW, compH, bottomOffset);
  // 移動量係数は標準固定（書き出し一致契約）。アンカーだけがプリセット実値に追従する。
  const vCoeff = telopVCoeff(compW, compH);
  // テロップ下端の画面 Y（position.y は上方向=負で縦係数ぶん上へ）。
  const bottomY =
    content.y +
    content.h * (originFrac + (anchorFrac - originFrac) * scale + position.y * vCoeff);
  const cx = content.x + content.w / 2 + (position.x * content.w) / 2;
  return { x: cx - w / 2, y: bottomY - h, w, h };
}

/**
 * 本体ドラッグの画面移動量（dxScreen,dyScreen ピクセル）を正規化 position の変化へ変換し、
 * 開始 position へ加算してクランプして返す。x は中心 50%、y は縦係数（telopVCoeff）で
 * カーソルにテロップが 1:1 で追従するようにする。
 *
 * `elemWidthPx`（`content` と同じ座標系＝ stage ローカル px）を渡すと、telopTransform の
 * 実式（x*50% は画面全幅基準・帯は中央寄せ）で実際に画面外へ出ない範囲まで x を追加で
 * クランプする（{@link clampTelopX}・2026-09-05 の不具合の恒久対策）。省略時は従来どおり
 * [-1,1] のみ（呼び出し側が実測幅を持たない場合の後方互換）。
 */
export function pointerToPosition(
  content: Rect,
  startPos: TelopPosition,
  dxScreen: number,
  dyScreen: number,
  compW: number,
  compH: number,
  elemWidthPx?: number,
): TelopPosition {
  if (content.w <= 0 || content.h <= 0) return startPos;
  const vCoeff = telopVCoeff(compW, compH);
  const rawX = clamp(startPos.x + (2 * dxScreen) / content.w, -1, 1);
  return {
    x: elemWidthPx != null ? clampTelopX(rawX, content.w, elemWidthPx) : rawX,
    // テロップは下端固定。y>0（下方向）は画面外へ出るため上方向のみ許す（[-1,0]）。
    y: clamp(startPos.y + dyScreen / (vCoeff * content.h), -1, 0),
  };
}

/** 2 点間のユークリッド距離。 */
function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * 四隅ハンドルのドラッグからスケールを求める。
 * ボックス中心から「掴んだ角」までの距離と「現在ポインタ」までの距離の比を
 * 開始スケールへ掛け、[0.3,3.0]（schema 契約の推奨範囲）へクランプする。
 * 全座標は同一座標系（client 座標等）であること。
 */
export function pointerToScale(
  boxCenterX: number,
  boxCenterY: number,
  grabCornerX: number,
  grabCornerY: number,
  pointerX: number,
  pointerY: number,
  startScale: number,
): number {
  const d0 = dist(boxCenterX, boxCenterY, grabCornerX, grabCornerY);
  if (d0 <= 0) return startScale;
  const d1 = dist(boxCenterX, boxCenterY, pointerX, pointerY);
  return clamp((startScale * d1) / d0, 0.3, 3.0);
}

/**
 * サブ動画の操作ボックスを画面座標で返す。サブ動画は全画面中央基準
 * （InsertVideo の transform `translate(pos*50%) scale(s)`・originは中心50%50%）。
 * box 中心 = content 中心 + position×(content 半分)、サイズ = content×scale。
 * telop の下端基準（telopBoxRect）とは異なる中心基準版。
 */
export function videoInsertBoxRect(content: Rect, position: TelopPosition, scale: number): Rect {
  const w = content.w * scale;
  const h = content.h * scale;
  const cx = content.x + content.w / 2 + (position.x * content.w) / 2;
  const cy = content.y + content.h / 2 + (position.y * content.h) / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * サブ動画の本体ドラッグの画面移動量を中心原点の正規化 position 変化へ変換する。
 * x/y とも中心 50% 基準で 1:1 追従（telop の縦下端係数を使わない）。両軸 [-1,1]。
 */
export function pointerToVideoInsertPosition(
  content: Rect,
  startPos: TelopPosition,
  dxScreen: number,
  dyScreen: number,
): TelopPosition {
  if (content.w <= 0 || content.h <= 0) return startPos;
  return {
    x: clamp(startPos.x + (2 * dxScreen) / content.w, -1, 1),
    y: clamp(startPos.y + (2 * dyScreen) / content.h, -1, 1),
  };
}

/**
 * サブ動画の四隅ハンドルドラッグからスケールを求める（pointerToScale と同式・クランプ範囲を
 * setVideoInsertScale と一致させた [0.1, 5]）。全座標は同一座標系（client 座標）。
 */
export function pointerToVideoInsertScale(
  boxCenterX: number,
  boxCenterY: number,
  grabCornerX: number,
  grabCornerY: number,
  pointerX: number,
  pointerY: number,
  startScale: number,
): number {
  const d0 = dist(boxCenterX, boxCenterY, grabCornerX, grabCornerY);
  if (d0 <= 0) return startScale;
  const d1 = dist(boxCenterX, boxCenterY, pointerX, pointerY);
  return clamp((startScale * d1) / d0, 0.1, 5);
}
