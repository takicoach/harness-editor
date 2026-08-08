/**
 * タイムラインの横スクロール挙動（再生追従・ホイール判定）を担う純粋関数群。
 * DOM に触れず数値だけで完結させ、ユニットテストで挙動を固定する。
 */

/**
 * 再生追従スクロール。再生ヘッドの X（コンテンツ座標・ガター込み）を、可視域の左から
 * `anchorRatio` の位置へ寄せる scrollLeft を返す。
 *
 * - ヘッドが anchor 線より左にいる間は desired が負 → 0 にクランプ（先頭は素直に左から流れる）。
 * - anchor 線を越えたら scrollLeft がヘッドに追従し、ヘッドは画面内 anchorRatio の位置に張り付く。
 *   毎フレーム呼ぶことで滑らかな（ヌルヌルした）追従になる。
 * - 末尾では scrollWidth - clientWidth でクランプし、ヘッドは右端へ自然に寄る。
 */
export function followScrollLeft(
  playheadX: number,
  clientWidth: number,
  scrollWidth: number,
  anchorRatio = 0.45,
): number {
  const max = Math.max(0, scrollWidth - clientWidth);
  const desired = playheadX - clientWidth * anchorRatio;
  return Math.max(0, Math.min(max, desired));
}

/** zoomAnchoredScrollLeft の入力。 */
export interface ZoomAnchor {
  /** ズーム前の、アンカー（再生ヘッド or マウス位置）のコンテンツ座標 X（ガター込み）。 */
  anchorContentX: number;
  /** 可視域の左端から見たアンカーの位置（px）。ズーム後もここへ戻す。 */
  viewportOffset: number;
  /** ズーム倍率（クランプ後 pxPerFrame ÷ クランプ前 pxPerFrame）。 */
  ratio: number;
  /** トラック見出しの固定幅。ズームしても伸縮しないので拡大対象から除く。 */
  gutter: number;
  /** 可視域の幅。 */
  clientWidth: number;
  /** ズーム後のコンテンツ全幅。 */
  scrollWidth: number;
}

/**
 * アンカー固定ズームの scrollLeft を返す。
 *
 * アンカー（ボタンズーム＝再生ヘッド／Ctrl+ホイール＝マウス位置）が、ズーム前後で
 * 画面上の同じ位置に留まるようにスクロール位置を補正する。これが無いと拡大のたびに
 * 「今いる場所」が画面外へ飛んでいく。
 *
 * ガター（見出し幅）はズームで伸縮しないため、拡大するのはガターより右の距離だけ。
 */
export function zoomAnchoredScrollLeft({
  anchorContentX,
  viewportOffset,
  ratio,
  gutter,
  clientWidth,
  scrollWidth,
}: ZoomAnchor): number {
  const anchorAfter = gutter + (anchorContentX - gutter) * ratio;
  const max = Math.max(0, scrollWidth - clientWidth);
  return Math.max(0, Math.min(max, anchorAfter - viewportOffset));
}

/** ホイール操作の意図。zoom=拡縮 / pan=横スクロール / native=ブラウザ標準（縦スクロール等）。 */
export type WheelAction =
  | { kind: 'zoom'; factor: number }
  | { kind: 'pan'; dx: number }
  | { kind: 'native' };

/** wheelAction が見るホイールイベントの最小形。 */
export interface WheelLike {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  deltaX: number;
  deltaY: number;
}

/**
 * ホイールイベントの意図を判定する。
 * - Ctrl/Cmd＋ホイール → ズーム（上で拡大・下で縮小）。
 * - Shift＋縦ホイール → 横スクロール（縦量を横へ変換）。
 * - それ以外 → ブラウザ標準（縦ホイール＝縦スクロールで素材トラックを上下に閲覧、
 *   横スワイプ＝横スクロール）。縦ホイールを横パンへ奪わないことで「下＝下」を直感的にする。
 */
export function wheelAction(e: WheelLike): WheelAction {
  if (e.ctrlKey || e.metaKey) {
    return { kind: 'zoom', factor: e.deltaY < 0 ? 1.2 : 1 / 1.2 };
  }
  if (e.shiftKey && e.deltaY !== 0 && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
    return { kind: 'pan', dx: e.deltaY };
  }
  return { kind: 'native' };
}
