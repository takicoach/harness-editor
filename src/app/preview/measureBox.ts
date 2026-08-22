import type { Rect } from './overlayGeometry';

/**
 * 選択枠の「実測」純関数群（設計書 §1）。
 *
 * プレビューの選択枠・当たり判定を、計算式の近似ではなく **実際に描かれた DOM の矩形**
 * から求める。ここは副作用も React も持たない純関数だけを置き、再測タイミング・状態保持は
 * {@link useMeasuredBox} が担う。
 *
 * **依存境界**: Remotion の内部 DOM 階層・class 名には依存しない。依存するのは
 * 「Player と overlay が同一 document・同一 client 座標系にある」ことだけ。
 * 目印は `EditorComposition` が描く `data-sme-root` / `data-sme-kind` / `data-sme-id` のみ。
 */

/** getBoundingClientRect 互換の最小矩形（テストで注入できるよう構造だけを要求する）。 */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 要素 → client 矩形の読み取り。既定は実 DOM の getBoundingClientRect。 */
export type RectReader = (el: Element) => RectLike;

/** 実 DOM の矩形リーダ（既定）。 */
export const domRectReader: RectReader = (el) => el.getBoundingClientRect();

/** 測定の文脈（全画面基準・座標原点・矩形リーダ）。 */
export interface MeasureContext {
  /** 全画面同寸の判定基準（= `data-sme-root` 要素の client 矩形）。 */
  frame: RectLike;
  /** stage ローカル座標へ変換する原点（= overlay root の client 矩形）。 */
  origin: RectLike;
  /** 矩形リーダ（省略時は実 DOM）。 */
  read?: RectReader;
}

/** 量子化の単位（px）。測定値の微振動で枠が発振するのを防ぐ。 */
export const QUANTUM = 0.5;

/** 全画面同寸とみなす寸法差の許容（px）。 */
const FULL_FRAME_EPS = 0.5;

/** 置換要素（中身が 1 枚の描画物であり、全画面でも実描画とみなす）。 */
const REPLACED_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'SVG']);

/** 値を 0.5px 単位へ丸める。 */
export function quantize(v: number): number {
  return Math.round(v / QUANTUM) * QUANTUM;
}

/** 置換要素（IMG/VIDEO/CANVAS/SVG）か。中身そのものが描画物なので常に合併へ含める。 */
export function isReplacedElement(el: Element): boolean {
  return REPLACED_TAGS.has(el.tagName.toUpperCase());
}

/** 子要素を持たず、表示されるテキストを持つか（＝文字が描かれている leaf）。 */
export function hasOwnText(el: Element): boolean {
  if (el.children.length > 0) return false;
  return (el.textContent ?? '').trim() !== '';
}

/** CSS 色文字列の alpha。空・transparent は 0、rgba(...) は第 4 成分、それ以外は 1。 */
function colorAlpha(color: string | null | undefined): number {
  if (color === null || color === undefined) return 0;
  const c = color.trim();
  if (c === '' || c === 'transparent' || c === 'none') return 0;
  const m = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/.exec(c);
  if (m !== null) return Number(m[1]);
  return 1;
}

/** 実際に線が引かれる border を持つか（幅 > 0・style あり・色が透明でない）。 */
function hasVisibleBorder(cs: CSSStyleDeclaration): boolean {
  const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
  return sides.some((side) => {
    const width = parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`) || '0');
    const style = cs.getPropertyValue(`border-${side.toLowerCase()}-style`) || 'none';
    if (!(width > 0) || style === 'none' || style === 'hidden') return false;
    return colorAlpha(cs.getPropertyValue(`border-${side.toLowerCase()}-color`)) > 0;
  });
}

/**
 * その要素自身が**視覚的に塗られている**か（背景色・背景画像・border・box-shadow のいずれか）。
 * 透明なレイアウト用コンテナ（AbsoluteFill・字幕の行ラッパー等）を合併から外すための判定。
 */
export function isPaintedBox(el: Element): boolean {
  const win = el.ownerDocument?.defaultView;
  if (!win) return false;
  const cs = win.getComputedStyle(el);
  const bgImage = cs.backgroundImage;
  if (bgImage !== undefined && bgImage !== null && bgImage !== '' && bgImage !== 'none') return true;
  const shadow = cs.boxShadow;
  if (shadow !== undefined && shadow !== null && shadow !== '' && shadow !== 'none') return true;
  if (hasVisibleBorder(cs)) return true;
  return colorAlpha(cs.backgroundColor) > 0;
}

/** r が frame と同寸（全画面）か。 */
function isFullFrame(r: RectLike, frame: RectLike): boolean {
  return (
    Math.abs(r.width - frame.width) <= FULL_FRAME_EPS &&
    Math.abs(r.height - frame.height) <= FULL_FRAME_EPS
  );
}

/** 合併中の境界（client 座標）。 */
interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * その要素の矩形を合併に含めるか（合併規則 v2・設計書 §1）。
 * 原則は「**実際に描かれて見えているものだけを測る**」。
 * - 置換要素（IMG/VIDEO/CANVAS/SVG）: 常に含める（全画面写真・全画面動画は正当な描画物）
 * - テキストを持つ leaf: 含める（文字そのもの）
 * - それ以外: **塗られている かつ 全画面同寸でない**ときだけ含める
 *   （透明なレイアウトコンテナ＝全幅の字幕行ラッパーを除外／塗られていても全画面同寸＝
 *   overlay の暗幕は除外）
 */
function shouldMerge(el: Element, r: RectLike, frame: RectLike): boolean {
  if (r.width <= 0 || r.height <= 0) return false; // display:none 等（opacity:0 は含める）
  if (isReplacedElement(el)) return true;
  if (hasOwnText(el)) return true;
  return isPaintedBox(el) && !isFullFrame(r, frame);
}

/**
 * wrapper の**子孫**矩形を合併する（wrapper 自身は含めない）。
 * 個々の採否は {@link shouldMerge}（合併規則 v2）。置換要素より下へは降りない。
 */
function mergeDescendants(wrapper: Element, frame: RectLike, read: RectReader): Bounds | null {
  let b: Bounds | null = null;
  const visit = (el: Element): void => {
    const r = read(el);
    if (shouldMerge(el, r, frame)) {
      const left = r.left;
      const top = r.top;
      const right = r.left + r.width;
      const bottom = r.top + r.height;
      b =
        b === null
          ? { left, top, right, bottom }
          : {
              left: Math.min(b.left, left),
              top: Math.min(b.top, top),
              right: Math.max(b.right, right),
              bottom: Math.max(b.bottom, bottom),
            };
    }
    // 置換要素の内部（SVG の子等）は独立した描画物として数えない。
    if (isReplacedElement(el)) return;
    for (const child of Array.from(el.children)) visit(child);
  };
  for (const child of Array.from(wrapper.children)) visit(child);
  return b;
}

/**
 * 対象ラッパー（`data-sme-kind` を持つ要素）の実描画矩形を stage ローカル座標で返す。
 * 実描画とみなせる子孫が 1 つも無ければ null（呼び出し側は従来式へフォールバックする）。
 */
export function measureItemRect(wrapper: Element, ctx: MeasureContext): Rect | null {
  const read = ctx.read ?? domRectReader;
  const b = mergeDescendants(wrapper, ctx.frame, read);
  if (b === null) return null;
  const x = quantize(b.left - ctx.origin.left);
  const y = quantize(b.top - ctx.origin.top);
  const right = quantize(b.right - ctx.origin.left);
  const bottom = quantize(b.bottom - ctx.origin.top);
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * 測定ルート配下の**テロップ全件**をオンデマンド測定する（pointer イベント時に呼ぶ）。
 * 常時測定はしない（毎フレーム全件実測は性能上の負債・裁定 P1-5）。
 * 測定できなかったテロップは結果に含めない（呼び出し側が従来式 `visibleTelopBoxes` で補う）。
 */
export function measureTelopHits(
  root: Element | null,
  ctx: MeasureContext,
): { id: number; rect: Rect }[] {
  if (root === null) return [];
  const out: { id: number; rect: Rect }[] = [];
  const nodes = root.querySelectorAll('[data-sme-kind="telop"][data-sme-id]');
  for (const el of Array.from(nodes)) {
    const id = Number(el.getAttribute('data-sme-id'));
    if (!Number.isFinite(id)) continue;
    const rect = measureItemRect(el, ctx);
    if (rect === null) continue;
    out.push({ id, rect });
  }
  return out;
}

/**
 * スコープ（= pv-stage 等）配下の測定ルートを引く。**document 全域は検索しない**
 * （複数 Player・再マウント過渡・テスト用プレビューの誤爆防止・裁定 P1-6）。
 */
export function findMeasureRoot(scope: Element | null): Element | null {
  if (scope === null) return null;
  return scope.querySelector('[data-sme-root]');
}

/** 測定ルート配下から kind/id の一致するラッパーを引く。 */
export function findMeasureItem(
  root: Element | null,
  kind: string,
  id: number,
): Element | null {
  if (root === null) return null;
  return root.querySelector(`[data-sme-kind="${kind}"][data-sme-id="${id}"]`);
}
