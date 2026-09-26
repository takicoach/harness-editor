/** F1 / F6: 縦の予算。タイムライン行を固定 280px ではなく窓の高さの比率で決め、舞台の最低の高さを守る。数値は 2026-09-21 の画面の検討で決めた値。 */
export const NARROW_BELOW = 1200;   // 幅がこれ未満: 左カラムを自動でレールに畳み、右カラムを狭める
export const RIGHT_NARROW = 272;
export const BOTTOM_MIN = 180, BOTTOM_MAX = 320, BOTTOM_RATIO = 0.34;
export const STAGE_MIN = 240;       // 舞台の最低の高さ。下回るならタイムラインを先に縮める
export const LOW_STAGE_BELOW = 320; // 舞台の内容域がこれ未満: 縦工具列を横 1 列にして舞台の下段へ
export const RAIL_ROW = 38;         // 横 1 列の工具列（30）＋上余白（8）
/** ヘッダー 52 ＋ main の上下余白 16 ＋ 行間 10 ＋ 見出し 32 ＋ 箱の余白 16 ＋ トランスポート 44 ＋ シーク 20 */
export const PREVIEW_CHROME = 52 + 16 + 10 + 32 + 16 + 44 + 20;

export interface BudgetInput { windowHeight: number; /** ドラッグで決めた高さ。null なら自動 */ bottom: number | null }

export function timelineBottom({ windowHeight, bottom }: BudgetInput): number {
  // 手動の値も、舞台の最低高が取れる範囲に収める（窓を縮めたとき舞台が消えないため）。取れない窓では 180 で止める。
  if (bottom !== null) return Math.max(BOTTOM_MIN, Math.min(bottom, windowHeight - PREVIEW_CHROME - STAGE_MIN));
  let value = Math.min(BOTTOM_MAX, Math.max(BOTTOM_MIN, Math.round(windowHeight * BOTTOM_RATIO)));
  let stage = windowHeight - PREVIEW_CHROME - value;
  if (stage < LOW_STAGE_BELOW) stage -= RAIL_ROW;
  if (stage < STAGE_MIN) value = Math.max(BOTTOM_MIN, value - (STAGE_MIN - stage));
  return value;
}
export function isNarrow(width: number): boolean { return width > 0 && width < NARROW_BELOW; }
export function rightColumnWidth(width: number, right: number): number { return isNarrow(width) ? Math.min(right, RIGHT_NARROW) : right; }
export function lowStage(contentHeight: number): boolean { return contentHeight > 0 && contentHeight < LOW_STAGE_BELOW; }

/**
 * I-7: 表示群（トラック追加・波形・高さ・ズーム）をポップオーバーへ退避するかは、幅の固定閾値では
 * なく実測で決める。仕上げモードのツールバーには編集モードに無いボタンが並ぶため、同じ 1100px でも
 * 収まるモードと溢れるモードがある（固定閾値 1100 では仕上げ 1280×800 が溢れたまま退避しなかった）。
 *
 * 退避すると中身が減って溢れが消えるので、戻す判定には記憶した値を使う。
 *
 * I'-1: 記憶するのは「退避を決めた瞬間の必要幅」（`requiredWidth` = そのときの scrollWidth）。
 * 足りなかった側の容器幅を覚えると、必要幅 S・退避時の容器幅 W（S > W）に対して「W + 余裕」で
 * 戻すので、S > W + 余裕 のときは戻した直後に再び溢れて退避し、窓を広げる操作で往復する
 * （戻した直後に手を止めると「非退避かつ溢れている」状態で固まり、右端の表示群が overflow:hidden
 * に切られて到達不能になる）。必要幅そのものを覚えれば、戻すのは本当に入る幅になってからの 1 回だけ。
 */
export const TOOLBAR_OVERFLOW_SLACK = 1;    // 小数幅の丸めぶん
export const TOOLBAR_RESTORE_MARGIN = 8;    // 必要幅よりこれだけ広くなったら戻す（境界で揺れないための数 px）
export interface ToolbarFit { compact: boolean; /** 退避を決めた瞬間の必要幅（scrollWidth） */ requiredWidth: number | null }
export const TOOLBAR_FIT_INITIAL: ToolbarFit = { compact: false, requiredWidth: null };
export function toolbarFit(current: ToolbarFit, measure: { scrollWidth: number; clientWidth: number }): ToolbarFit {
  if (measure.clientWidth <= 0) return current;   // 未マウント・非表示では判定しない
  if (!current.compact)
    return measure.scrollWidth > measure.clientWidth + TOOLBAR_OVERFLOW_SLACK ? { compact: true, requiredWidth: measure.scrollWidth } : current;
  if (current.requiredWidth !== null && measure.clientWidth >= current.requiredWidth + TOOLBAR_RESTORE_MARGIN) return { compact: false, requiredWidth: null };
  // M-2: 退避中でも中身がさらに増えて溢れが続くなら、覚えている必要幅を max 更新する。
  // 古い（小さい）requiredWidth のまま戻す判定を続けると、実際にはまだ溢れる幅で戻してしまい、
  // 「戻す→溢れる→退避」を繰り返しうる（1 往復で収束する現状を「発散しない」で済ませない）。
  if (current.requiredWidth !== null && measure.scrollWidth > measure.clientWidth + TOOLBAR_OVERFLOW_SLACK && measure.scrollWidth > current.requiredWidth)
    return { compact: true, requiredWidth: measure.scrollWidth };
  return current;
}

export const PANEL_LEFT_MAX = 420, PANEL_RIGHT_MAX = 460;
export interface FitPanelInput {
  /** 舞台の左右に余っている幅（レターボックス分）。 */
  space: number;
  /** 幅が 1200px 未満か（`isNarrow`）。 */
  narrow: boolean;
  leftCollapsed: boolean; rightHidden: boolean; leftSize: number; rightSize: number;
}
/**
 * 「パネルを収める」で左右のカラムへ配る増分。横のレターボックスぶんだけを配り、画像を切ったり
 * 高さを超えて拡大したりはしない。
 *
 * T7: 狭幅では右の取り分を 0 にする。狭幅の右カラムは `rightColumnWidth` が 272px へ丸めるので、
 * ここで太らせても見た目は 1px も変わらないのに保存値だけ 460 近くまで育つ。その状態で窓を 1200px 以上へ
 * 広げると、丸めが外れた瞬間に右カラムが跳ねる（押した覚えのない幅になる）。狭幅では諦めて、
 * 余りは左カラム（開いているとき）へ回す。
 */
export function fitPanelGains({space, narrow, leftCollapsed, rightHidden, leftSize, rightSize}: FitPanelInput): {left: number; right: number} {
  let remaining = Math.max(0, space);
  const giveRight = !rightHidden && !narrow;
  const rightGain = giveRight ? Math.min(Math.max(0, PANEL_RIGHT_MAX - rightSize), remaining * .65) : 0;
  remaining -= rightGain;
  const leftGain = leftCollapsed ? 0 : Math.min(Math.max(0, PANEL_LEFT_MAX - leftSize), remaining);
  remaining -= leftGain;
  const extraRight = giveRight ? Math.min(Math.max(0, PANEL_RIGHT_MAX - rightSize - rightGain), remaining) : 0;
  return {left: leftGain, right: rightGain + extraRight};
}
