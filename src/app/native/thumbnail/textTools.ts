import { fontById, fontStack } from '../../../core/fonts';
import type { TextAppearance } from '../../../core/sequence/model';
import type { ThumbnailShape } from '../../../core/thumbnail/model';

/** 「袋文字」ボタンの 2 重の縁（定番スタイルの「袋文字 2 重」と同じ）。 */
export const DOUBLE_OUTLINE = [{ width: 10, color: '#000000' }, { width: 8, color: '#ffffff' }] as const;
export const TEXT_SHADOW = { x: 6, y: 8, blur: 12, color: '#000000cc' } as const;
export const STROKE_WIDTHS = [2, 4, 8, 12, 16, 24, 32] as const;

export function hasDoubleOutline(appearance: TextAppearance): boolean { return (appearance.outlines?.length ?? 0) >= 2; }
export function withDoubleOutline(appearance: TextAppearance, on: boolean): TextAppearance {
  const { outlines: _outlines, ...rest } = appearance;
  return on ? { ...rest, outlines: DOUBLE_OUTLINE.map(item => ({ ...item })) } : rest;
}
export function withShadow(appearance: TextAppearance, on: boolean): TextAppearance {
  const { shadow: _shadow, ...rest } = appearance;
  return on ? { ...rest, shadow: { ...TEXT_SHADOW } } : rest;
}
export function resizedFont(appearance: TextAppearance, step: 1 | -1): TextAppearance {
  return { ...appearance, fontSize: Math.min(400, Math.max(8, appearance.fontSize + step * 10)) };
}
/** 同梱の書体だけ（検証も同梱以外を拒む）。知らない ID は変えない。 */
export function withFontId(appearance: TextAppearance, fontId: string): TextAppearance {
  const font = fontById(fontId);
  return font && font.group === 'bundled' ? { ...appearance, fontFamily: fontStack(font) } : appearance;
}
export function withFill(shape: ThumbnailShape, color: string | null): ThumbnailShape {
  return { ...shape, fill: color === null ? null : { kind: 'solid', color } };
}
export function fillColor(shape: ThumbnailShape): string | null {
  if (!shape.fill) return null;
  return shape.fill.kind === 'solid' ? shape.fill.color : shape.fill.stops[0]?.color ?? null;
}
