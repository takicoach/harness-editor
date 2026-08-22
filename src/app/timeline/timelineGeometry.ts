import { formatClock } from '../../shared/format';
import { type DisplayMap, originalToDisplay, displayToOriginal } from '../../core/timelineDisplayMap';

/** ズーム（1 フレームあたりのピクセル数）の下限。これより縮めると目盛りが潰れる。 */
export const MIN_PX_PER_FRAME = 0.05;
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
const MIN_MAJOR_GAP_PX = 64;

/**
 * 原本総フレーム・ズーム・fps から、ルーラーの目盛り配列を算出する。
 * major は時刻ラベル付き、その間に minor を 1 本ずつ（major 間隔の半分の位置）入れる。
 * 総フレーム 0 でも先頭 major（frame=0）だけは返す。
 */
export function rulerTicks(
  totalFrames: number,
  pxPerFrame: number,
  fps: number,
): RulerTick[] {
  const safeFps = fps > 0 ? fps : 30;
  // major 間隔（秒）を、ピクセル間隔が MIN_MAJOR_GAP_PX 以上になる最初の候補から選ぶ。
  let majorSeconds = MAJOR_SECONDS_CANDIDATES[MAJOR_SECONDS_CANDIDATES.length - 1] ?? 600;
  for (const sec of MAJOR_SECONDS_CANDIDATES) {
    const gapPx = sec * safeFps * pxPerFrame;
    if (gapPx >= MIN_MAJOR_GAP_PX) {
      majorSeconds = sec;
      break;
    }
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
