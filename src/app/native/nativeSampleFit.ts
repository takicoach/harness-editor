/**
 * テロップの見本（スタイル一覧・アニメーション一覧）が共有する「文字を中心に切り出して拡大する」計算。
 * 舞台全体を縮小すると 64px の文字が数 px になり灰色の滲みにしか見えないため、実際に描画された
 * 文字の位置を測って、カードいっぱいに拡大する。fitTextBoxToStage は DOM を触らない純関数
 * （ユニットテストで固定できる）。measureTextBox だけが実 DOM を読む。
 */

import { isNewTelopAnimation, telopAnimationEffect, type TelopAnimationId } from '../../core/telopAnimation';

export interface TextBox { left: number; top: number; width: number; height: number; }
export interface StageSize { width: number; height: number; }
export interface SampleFit { scale: number; x: number; y: number; }

/**
 * 余白の下限（px、書き出し解像度と同じ座標系）。旧 9 種はどれも平行移動だけ（NativeText の
 * slideFromLeft 等で最大 60px）なので、この床がそのまま実効の余白になる。新 8 種（拡大・回転を
 * 伴う）は animationSampleMargin がこの床より大きい値を返す。
 */
export const ANIMATION_CROP_MARGIN_PX = 70;

/** 動きが到達する最大スケール・最大平行移動量（px）。 */
export interface AnimationMotionBounds { maxScale: number; maxTranslatePx: number; }

/** 旧 9 種の平行移動量（NativeText.tsx の x/y 計算と同じ定数）。scale は変えない。 */
const LEGACY_TRANSLATE_PX: Partial<Record<TelopAnimationId, number>> = {
  slideFromLeft: 60, slideLeftFadeBlur: 60, fadeFromLeft: 60, fadeFromRight: 60,
  slideIn: 50, fadeBlurFromBottom: 40,
};

/**
 * `telopAnimationEffect` を尺の全フレームで評価し、動きが到達する最大 scale と最大平行移動量
 * （px）を求める。新 8 種だけが対象（旧 9 種は transform を触らないので上の定数表で決まる）。
 * jumpPop の translateY は fontSizePx に比例するため、見本の文字サイズ（fontSizePx 引数）を渡す。
 */
export function animationMotionBounds(id: TelopAnimationId, fontSizePx: number): AnimationMotionBounds {
  const legacy = LEGACY_TRANSLATE_PX[id];
  if (legacy !== undefined) return { maxScale: 1, maxTranslatePx: legacy };
  if (!isNewTelopAnimation(id)) return { maxScale: 1, maxTranslatePx: 0 };

  const fps = 30, durationFrames = 90, charCount = 10;   // 動きの形（progress 比）は尺に依らないので代表値で十分
  let maxScale = 1, maxTranslatePx = 0;
  for (let frame = 0; frame <= durationFrames; frame++) {
    const effect = telopAnimationEffect({ id, localFrame: frame, durationFrames, fps, fontSizePx, charCount });
    const transform = effect?.transform; if (!transform) continue;
    const scaleMatch = transform.match(/scale\(([-\d.]+)\)/);
    if (scaleMatch) maxScale = Math.max(maxScale, Math.abs(Number(scaleMatch[1])));
    const translateMatch = transform.match(/translate[XY]?\(([-\d.]+)px\)/);
    if (translateMatch) maxTranslatePx = Math.max(maxTranslatePx, Math.abs(Number(translateMatch[1])));
  }
  return { maxScale, maxTranslatePx };
}

/**
 * 見本の切り出し余白（px）。平行移動量と旧来の床 ANIMATION_CROP_MARGIN_PX のうち大きい方を採る
 * （旧 9 種はこの床がそのまま効く）。拡大（scale）は余白に含めない — レビュアーの裁定どおり、
 * 静止時に他カードと同じ大きさで読めることを優先し、再生中のピークの拡大は舞台の
 * `overflow:hidden` で切れてよい（stampPress だけ 1/2.2 に縮んで見た目が不揃いになるのを避ける）。
 */
export function animationSampleMargin(id: TelopAnimationId, box: TextBox): number {
  const { maxTranslatePx } = animationMotionBounds(id, box.height);
  return Math.max(ANIMATION_CROP_MARGIN_PX, maxTranslatePx + 10);
}

/**
 * 測定した文字の箱をカードの舞台いっぱいに収める transform を計算する（NativeTextStylePicker の
 * StyleCell と同じ式）。marginPx は箱の四辺を先に広げてから収める（アニメーションの移動量を確保）。
 */
export function fitTextBoxToStage(box: TextBox, stage: StageSize, marginPx = 0): SampleFit {
  const left = box.left - marginPx, top = box.top - marginPx;
  const width = box.width + marginPx * 2, height = box.height + marginPx * 2;
  if (!stage.width || !stage.height || width <= 0 || height <= 0) return { scale: 0, x: 0, y: 0 };
  // 実際の文字を、縁取り・影の余地を残してカードへ収める（幅・高さ双方の制約の小さい方）。
  const scale = Math.min((stage.width - 28) / (width + height * .4), (stage.height - 28) / (height * 1.4));
  return { scale, x: stage.width / 2 - (left + width / 2) * scale, y: stage.height / 2 - (top + height / 2) * scale };
}

/**
 * container 内でレンダリングされたテキストノードの外接矩形を、resolutionWidth を基準とした
 * 書き出し解像度の座標系で返す（container 自身の現在のスケールから逆算する）。テキストが無ければ null。
 */
export function measureTextBox(container: HTMLElement, resolutionWidth: number): TextBox | null {
  const origin = container.getBoundingClientRect();
  const currentScale = origin.width / resolutionWidth;
  if (!currentScale) return null;
  const walker = window.document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const rects: DOMRect[] = [];
  while (walker.nextNode()) {
    if (walker.currentNode.textContent?.trim() && walker.currentNode.parentElement?.tagName.toLowerCase() !== 'style') {
      const range = window.document.createRange();
      range.selectNodeContents(walker.currentNode);
      rects.push(...Array.from(range.getClientRects()).filter(rect => rect.width && rect.height));
    }
  }
  if (!rects.length) return null;
  const left = (Math.min(...rects.map(rect => rect.left)) - origin.left) / currentScale;
  const top = (Math.min(...rects.map(rect => rect.top)) - origin.top) / currentScale;
  const width = (Math.max(...rects.map(rect => rect.right)) - origin.left) / currentScale - left;
  const height = (Math.max(...rects.map(rect => rect.bottom)) - origin.top) / currentScale - top;
  return { left, top, width, height };
}
