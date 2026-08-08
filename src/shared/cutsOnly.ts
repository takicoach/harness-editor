/**
 * 「カットしただけ」の編集かを判定する（クライアント/サーバ共用）。
 *
 * テロップもエフェクトも無いなら、Remotion で 1 フレームずつ描き直す必要はなく、
 * ffmpeg で原本を切って繋ぐだけで済む（4K・9分の中間素材で 10 時間超 → 9 分の実測差）。
 * 何か 1 つでも載っていれば通常の書き出しへ戻す。
 *
 * サーバ側が最終判断を持ち、クライアントは同じ判定で「高速で書き出します」の案内を出す。
 */

/** レイアウトのうち「描き直しが要るか」を左右する部分だけ。 */
export interface MainLayoutLike {
  position?: { x: number; y: number };
  scale?: number;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
}

/**
 * メイン動画のレイアウトが「素のまま」か（PiP 風の移動・拡縮・回転・反転が無い）。
 * mainLayout は未指定でも既定値が入るため、有無ではなく中身で判定する。
 * 素のままなら背景色は画面に出ないので見ない。
 */
export function isIdentityLayout(layout: MainLayoutLike | undefined | null): boolean {
  if (layout === undefined || layout === null) return true;
  return (
    (layout.position?.x ?? 0) === 0 &&
    (layout.position?.y ?? 0) === 0 &&
    (layout.scale ?? 1) === 1 &&
    (layout.rotation ?? 0) === 0 &&
    (layout.flipH ?? false) === false &&
    (layout.flipV ?? false) === false
  );
}

/** 判定に必要な最小の形（EditState と EditorProject の共通部分）。 */
export interface CutsOnlyInput {
  telops: readonly unknown[];
  se: readonly unknown[];
  images: readonly unknown[];
  videoInserts?: readonly unknown[];
  bgm?: readonly unknown[];
  titles: readonly unknown[];
  shapes?: readonly unknown[];
  sceneTransitions?: readonly unknown[];
  mainSpeed: number;
  segmentSpeeds: Record<number, number>;
  mainLayout?: MainLayoutLike;
  segmentLayouts?: Record<number, unknown>;
  layoutKeyframes?: readonly unknown[];
}

/** カット以外の要素が一つも無ければ true。 */
export function isCutsOnly(p: CutsOnlyInput): boolean {
  const empty = (a: readonly unknown[] | undefined): boolean => (a ?? []).length === 0;
  return (
    empty(p.telops) &&
    empty(p.se) &&
    empty(p.images) &&
    empty(p.videoInserts) &&
    empty(p.bgm) &&
    empty(p.titles) &&
    empty(p.shapes) &&
    empty(p.sceneTransitions) &&
    empty(p.layoutKeyframes) &&
    p.mainSpeed === 1 &&
    Object.keys(p.segmentSpeeds).length === 0 &&
    Object.keys(p.segmentLayouts ?? {}).length === 0 &&
    // メイン動画のレイアウト（PiP 風の位置・大きさ・回転）が付いていたら描画が要る。
    isIdentityLayout(p.mainLayout)
  );
}
