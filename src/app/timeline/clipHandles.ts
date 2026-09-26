/**
 * クリップ端つまみの幅を決める共通ヘルパ（監査 interaction-4）。
 *
 * 各トラックはクリップ幅に下限（2〜4px）を掛けて必ず描くのに、端つまみは
 * 固定幅（動画・テロップ 10px / 画像・SE・BGM・図形・サブ動画 6px）を左右に
 * 1 つずつ、しかも半分はみ出して置いていた。ズームアウトすると本体が 2 つの
 * つまみに完全に覆われ、
 *   - 掴んで動かす（body）ができない
 *   - 重なりは DOM 順で後ろの end が勝つ＝左端を押しても終端が動く
 * という 2 つの事故が起きる。
 *
 * ここで「つまみを描くかどうか」と「描くなら何 px か」を 1 か所に集約する。
 */

/** これ未満の幅のクリップにはつまみを描かない（本体の掴み面を優先する）。 */
export const MIN_HANDLE_CLIP_WIDTH_PX = 24;

/**
 * クリップ幅に応じたつまみ幅（px）。null なら**つまみを描かない**。
 *
 * - 幅 < MIN_HANDLE_CLIP_WIDTH_PX: null（本体だけ＝掴んで動かせる）
 * - それ以上: 自然幅と「クリップ幅の 1/3」の小さい方
 *   （左右 2 つ合わせても 2/3 まで。本体の掴み面が必ず 1/3 残る）
 *
 * @param clipWidthPx 画面上のクリップ幅（px・トラック側が算出済みの値）。
 * @param naturalWidthPx そのトラックの通常時のつまみ幅（CSS と一致させる）。
 */
export function clipHandleWidth(clipWidthPx: number, naturalWidthPx: number): number | null {
  if (!Number.isFinite(clipWidthPx) || clipWidthPx < MIN_HANDLE_CLIP_WIDTH_PX) return null;
  return Math.min(naturalWidthPx, Math.floor(clipWidthPx / 3));
}

/**
 * つまみ 1 個ぶんのインラインスタイル。幅と、はみ出し量（幅の半分）を同時に決める。
 * CSS の `left:-5px` / `right:-3px` は自然幅前提の決め打ちなので、縮めたときは
 * ここで上書きしないとクリップの外へ大きくはみ出したままになる。
 *
 * `width` が null（＝描かない）のときは `display:'none'` を返す。DOM から外さず
 * 非表示にするのは、各トラックの JSX 構造（本体 → つまみ 2 個）を変えずに済ませ、
 * 既存の DOM 順・セレクタを壊さないため。`display:none` の要素はヒットテストの
 * 対象にならないので「本体が覆われる」問題は消える。
 */
export function clipHandleStyle(
  width: number | null,
  edge: 'start' | 'end',
): React.CSSProperties {
  if (width === null) return { display: 'none' };
  const offset = -width / 2;
  return edge === 'start' ? { width, left: offset } : { width, right: offset };
}
