import { formatClock } from '../../shared/format';
import { type DisplayMap, originalToDisplay, displayToOriginal } from '../../core/timelineDisplayMap';

/**
 * ズーム（1 フレームあたりのピクセル数）の下限。
 *
 * 以前は 0.05 だったが、それだと 14 分（26,000 フレーム）の案件は 1,300px 必要で
 * 1440 幅の画面でも「全体を表示」が最後まで届かない（`fitPxPerFrame` が下限に張り付く）。
 * 目盛りが潰れる心配は `rulerTicks` が間隔を粗い候補へ後退させることで吸収する。
 */
export const MIN_PX_PER_FRAME = 0.01;
/** ズーム（1 フレームあたりのピクセル数）の上限。これより拡げてもフレーム単位以上は不要。 */
export const MAX_PX_PER_FRAME = 12;

/**
 * トラック見出し（左カラム）の固定幅（px）。CSS の `--track-label-w` と必ず一致させること。
 * frameToX はこの分だけ右へオフセットし、素材・目盛り・再生ヘッドが見出しの右端から始まる
 * （見出しの裏に隠れない）。xToFrame は逆に差し引く。
 */
export const TRACK_LABEL_GUTTER_PX = 88;

/**
 * ドラッグとクリックを分けるポインタ移動量のしきい値（px・画面座標）。
 * これ以下しか動いていなければ「クリック」とみなす。
 *
 * **フレーム値ではなく生の px で測ること。** 吸着後のフレーム値で比較すると、
 * 掴んだ端が吸着点の近くにあるとき実際に動かしても値が変わらず「動いていない」と
 * 誤判定する（吸着 ON の小ドラッグが無反応になる）。逆にズームアウト時
 * （pxPerFrame < 1）は 1px の揺れが数フレームの差になり、クリックがドラッグに化ける。
 */
export const CLICK_MOVE_THRESHOLD_PX = 5;

export function frameToX(frame: number, pxPerFrame: number): number {
  return TRACK_LABEL_GUTTER_PX + frame * pxPerFrame;
}

/**
 * トラック左端からのピクセル X 座標を、原本フレーム（整数）へ変換する。
 * ガター（見出し幅）を差し引いてから換算する。負・ガター内の X は 0 へクランプ。
 * pxPerFrame が 0 以下ならゼロ除算を避け 0 を返す。
 */
export function xToFrame(x: number, pxPerFrame: number): number {
  if (pxPerFrame <= 0) return 0;
  return Math.max(0, Math.round((x - TRACK_LABEL_GUTTER_PX) / pxPerFrame));
}

/**
 * フレーム数（区間の長さ）をピクセル幅へ変換する。**位置ではなく距離**なのでガターは足さない
 * （`frameToX` は始点・目盛り等の「位置」用でガターを足すが、ブロック幅やフェード幅のような
 * 「長さ」に `frameToX` を使うとガター分だけ余計に広がり要素が重なる）。
 * 不変条件: `framesToWidth(b - a, ppf) === frameToX(b, ppf) - frameToX(a, ppf)`（差ではガターが相殺）。
 */
export function framesToWidth(frames: number, pxPerFrame: number): number {
  return frames * pxPerFrame;
}

/** 原本フレーム → X（表示マップ経由・map 省略/identity なら frameToX と同一）。 */
export function frameToXMapped(originalFrame: number, pxPerFrame: number, map?: DisplayMap): number {
  return frameToX(map ? originalToDisplay(originalFrame, map) : originalFrame, pxPerFrame);
}

/** 原本 [start,end) の表示幅（map 省略/identity なら framesToWidth(end-start) と同一）。 */
export function widthMapped(
  originalStart: number,
  originalEnd: number,
  pxPerFrame: number,
  map?: DisplayMap,
): number {
  const a = map ? originalToDisplay(originalStart, map) : originalStart;
  const b = map ? originalToDisplay(originalEnd, map) : originalEnd;
  return framesToWidth(b - a, pxPerFrame);
}

/** X → 原本フレーム（表示マップ経由・map 省略/identity なら xToFrame と同一）。 */
export function xToFrameMapped(x: number, pxPerFrame: number, map?: DisplayMap): number {
  const displayFrame = xToFrame(x, pxPerFrame);
  return map ? displayToOriginal(displayFrame, map) : displayFrame;
}

/** ズーム値を [MIN_PX_PER_FRAME, MAX_PX_PER_FRAME] へクランプする。NaN は下限へ。 */
export function clampZoom(pxPerFrame: number): number {
  if (!Number.isFinite(pxPerFrame)) return MIN_PX_PER_FRAME;
  return Math.min(MAX_PX_PER_FRAME, Math.max(MIN_PX_PER_FRAME, pxPerFrame));
}

/**
 * タイムライン全体が可視幅に収まるズーム（1 フレームあたりピクセル数）。
 *
 * 案件を開いた直後の既定ズーム（1px/frame）は 14 分の案件だと全体の 11% しか映らず、
 * 「どこを見ているのか」が分からないまま始まる（ベースライン §初期ズーム）。
 * ここでは見出しガターを除いた可視幅に表示総フレームがちょうど収まる倍率を返す。
 *
 * @param displayTotalFrames 表示座標の総フレーム（表示マップ適用後）。
 * @param clientWidthPx タイムライン可視領域の幅（`.tl-body` の clientWidth）。
 * @returns [MIN_PX_PER_FRAME, MAX_PX_PER_FRAME] にクランプした倍率。
 *   算出できない（幅 0・フレーム 0）ときは null（呼び出し側は今の倍率を維持する）。
 */
export function fitPxPerFrame(
  displayTotalFrames: number,
  clientWidthPx: number,
): number | null {
  if (!Number.isFinite(displayTotalFrames) || displayTotalFrames <= 0) return null;
  const usable = clientWidthPx - TRACK_LABEL_GUTTER_PX;
  if (!Number.isFinite(usable) || usable <= 0) return null;
  return clampZoom(usable / displayTotalFrames);
}

/** ルーラーの 1 目盛り。major には時刻ラベルが付き、minor はラベル無し。 */
export interface RulerTick {
  /** 原本フレーム。 */
  frame: number;
  kind: 'major' | 'minor';
  /** major のみ "m:ss" の時刻ラベル。minor は空文字。 */
  label: string;
}

/** major 目盛りの候補間隔（秒）。狭い方から、major が画面上で詰まらない最初の値を選ぶ。 */
const MAJOR_SECONDS_CANDIDATES = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
/** major 目盛りの最小ピクセル間隔（これ未満なら次の粗い候補へ）。 */
export const MIN_MAJOR_GAP_PX = 64;

/**
 * 候補間隔 majorFrames で目盛りを置いたときの、**実際の画面上の**最小隣接間隔（px）。
 *
 * 目盛りの配置は `frameToXMapped`（表示マップ経由）なのに、間隔の選択は等速前提の
 * `sec*fps*pxPerFrame` だけで行っていた（監査 interaction-5）。区間速度 rate>1 の区間は
 * 表示長が 1/rate に潰れるため、rate=4 なら実間隔は想定の 1/4 になり時刻ラベルが重なる。
 * ここで隣接 tick の実 X 差分の最小値を返し、呼び出し側が MIN_MAJOR_GAP_PX で検算する。
 *
 * 隣接ペアが 1 組も無い（tick が 1 本以下）ときは Infinity（＝制約なし）を返す。
 */
function minMappedMajorGapPx(
  totalFrames: number,
  majorFrames: number,
  pxPerFrame: number,
  map: DisplayMap,
): number {
  let min = Infinity;
  let prevX = frameToXMapped(0, pxPerFrame, map);
  for (let frame = majorFrames; frame <= totalFrames; frame += majorFrames) {
    const x = frameToXMapped(frame, pxPerFrame, map);
    const gap = x - prevX;
    if (gap < min) min = gap;
    prevX = x;
  }
  return min;
}

/**
 * 原本総フレーム・ズーム・fps から、ルーラーの目盛り配列を算出する。
 * major は時刻ラベル付き、その間に minor を 1 本ずつ（major 間隔の半分の位置）入れる。
 * 総フレーム 0 でも先頭 major（frame=0）だけは返す。
 *
 * `map` を渡すと、等速換算の間隔だけでなく **表示マップ適用後の実 px 間隔**でも
 * MIN_MAJOR_GAP_PX を検算する（速度を上げた区間でラベルが重ならない・監査 interaction-5）。
 * `map` 省略時・identity のときは従来と完全に同じ結果。
 */
export function rulerTicks(
  totalFrames: number,
  pxPerFrame: number,
  fps: number,
  map?: DisplayMap,
): RulerTick[] {
  const safeFps = fps > 0 ? fps : 30;
  // major 間隔（秒）を、ピクセル間隔が MIN_MAJOR_GAP_PX 以上になる最初の候補から選ぶ。
  let majorSeconds = MAJOR_SECONDS_CANDIDATES[MAJOR_SECONDS_CANDIDATES.length - 1] ?? 600;
  for (const sec of MAJOR_SECONDS_CANDIDATES) {
    const gapPx = sec * safeFps * pxPerFrame;
    if (gapPx < MIN_MAJOR_GAP_PX) continue;
    // 表示マップがあるときは実配置でも検算する（速度区間で潰れた間隔を弾く）。
    if (map !== undefined && !map.identity) {
      const frames = Math.max(1, Math.round(sec * safeFps));
      if (minMappedMajorGapPx(totalFrames, frames, pxPerFrame, map) < MIN_MAJOR_GAP_PX) continue;
    }
    majorSeconds = sec;
    break;
  }
  const majorFrames = Math.max(1, Math.round(majorSeconds * safeFps));
  const ticks: RulerTick[] = [];
  // frame=0 の先頭 major は必ず入れる。
  for (let frame = 0; frame <= totalFrames; frame += majorFrames) {
    ticks.push({
      frame,
      kind: 'major',
      label: formatClock(frame / safeFps),
    });
    const minorFrame = frame + Math.floor(majorFrames / 2);
    if (minorFrame < totalFrames && majorFrames >= 2) {
      ticks.push({ frame: minorFrame, kind: 'minor', label: '' });
    }
  }
  return ticks;
}
