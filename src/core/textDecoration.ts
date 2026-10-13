import type { TextAppearance } from './sequence/model';

export interface TextInsets { top: number; right: number; bottom: number; left: number }
export interface TextStrokeLayer { stroke: number; color: string }
/** 帯が無いときの従来の余白（8px 16px）。 */
export const LEGACY_TEXT_PADDING = Object.freeze({ x: 16, y: 8 });

export function textBoxPadding(appearance: TextAppearance): { x: number; y: number } {
  return appearance.band ? { x: appearance.band.padX, y: appearance.band.padY } : { x: LEGACY_TEXT_PADDING.x, y: LEGACY_TEXT_PADDING.y };
}
export function textBoxBackground(appearance: TextAppearance): string {
  return appearance.band ? appearance.band.color : appearance.background;
}
/** 縁取りの重ね（外側から順）。線は文字の輪郭の両側に半分ずつ出るので、見える太さの 2 倍で描く。 */
export function textOutlineLayers(appearance: TextAppearance): TextStrokeLayer[] {
  const outlines = appearance.outlines ?? [], layers: TextStrokeLayer[] = [];
  let reach = 0;
  const reaches = outlines.map(outline => (reach += outline.width));
  for (let index = outlines.length - 1; index >= 0; index--) {
    const width = reaches[index]!;
    if (width > 0) layers.push({ stroke: width * 2, color: outlines[index]!.color });
  }
  return layers;
}
export function textOutlineReach(appearance: TextAppearance): number {
  return (appearance.outlines ?? []).reduce((sum, outline) => sum + outline.width, 0);
}
export function textShadowFilter(appearance: TextAppearance): string | undefined {
  const shadow = appearance.shadow;
  return shadow ? `drop-shadow(${shadow.x}px ${shadow.y}px ${shadow.blur}px ${shadow.color})` : undefined;
}
export function textSkewTransform(appearance: TextAppearance): string | undefined {
  return appearance.skewDeg ? `skewX(${-appearance.skewDeg}deg)` : undefined;
}
/** 文字枠（帯の外枠）からはみ出す量。選択枠の計測で使う。size は傾ける前の文字枠の寸法。 */
export function textInkInsets(appearance: TextAppearance, size: { width: number; height: number }): TextInsets {
  const pad = textBoxPadding(appearance), reach = textOutlineReach(appearance);
  const side = Math.max(0, reach - pad.x), vertical = Math.max(0, reach - pad.y);
  let left = side, right = side, top = vertical, bottom = vertical;
  const shadow = appearance.shadow;
  if (shadow) {
    const spread = reach + shadow.blur;
    left = Math.max(left, spread - shadow.x - pad.x); right = Math.max(right, spread + shadow.x - pad.x);
    top = Math.max(top, spread - shadow.y - pad.y); bottom = Math.max(bottom, spread + shadow.y - pad.y);
  }
  const skew = appearance.skewDeg ? Math.abs(Math.tan(appearance.skewDeg * Math.PI / 180)) * size.height / 2 : 0;
  return { top, bottom, left: left + skew, right: right + skew };
}
export function expandBounds<T extends { x: number; y: number; width: number; height: number }>(bounds: T, insets: TextInsets): T {
  return { ...bounds, x: bounds.x - insets.left, y: bounds.y - insets.top, width: bounds.width + insets.left + insets.right, height: bounds.height + insets.top + insets.bottom };
}
