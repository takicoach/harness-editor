import { fontById, fontStack } from '../fonts';
import { DEFAULT_TEXT_APPEARANCE, type TextAppearance } from '../sequence/model';

export const THUMBNAIL_FONT_ID = 'noto-sans-jp-black';
export function thumbnailFontFamily(): string {
  const font = fontById(THUMBNAIL_FONT_ID);
  if (!font) throw new Error('サムネの既定書体（Noto Sans JP 900）がありません');
  return fontStack(font);
}
/** サムネの文字の既定。文字枠はキャンバス幅の 90%・中央基準（位置は visual で動かす）。 */
export function thumbnailTextAppearance(fontSize = 140): TextAppearance {
  return { ...DEFAULT_TEXT_APPEARANCE, fontFamily: thumbnailFontFamily(), fontSize, fontWeight: 900, color: '#ffffff', strokeColor: '#000000', strokeWidth: 0,
    background: 'transparent', align: 'center', lineHeight: 1.15, letterSpacing: 0, box: { width: .9, anchor: 'center' } };
}
export interface ThumbnailTextStyle { id: 'double-outline' | 'white-red' | 'band' | 'shadow' | 'black-white' | 'neon'; name: string; apply(appearance: TextAppearance): TextAppearance }
/** 前のスタイルの縁・帯・影を外してから当てる。大きさ・字間・行間・文字枠は残す。 */
function restyle(appearance: TextAppearance, extra: Partial<TextAppearance>): TextAppearance {
  const { outlines: _outlines, shadow: _shadow, band: _band, ...rest } = appearance;
  return { ...rest, fontFamily: thumbnailFontFamily(), fontWeight: 900, strokeWidth: 0, background: 'transparent', ...extra };
}
export const THUMBNAIL_TEXT_STYLES: readonly ThumbnailTextStyle[] = [
  { id: 'double-outline', name: '袋文字 2 重（黄×黒×白）', apply: a => restyle(a, { color: '#ffe600', outlines: [{ width: 10, color: '#000000' }, { width: 8, color: '#ffffff' }] }) },
  { id: 'white-red', name: '白×赤縁', apply: a => restyle(a, { color: '#ffffff', outlines: [{ width: 12, color: '#e60012' }] }) },
  { id: 'band', name: '帯つき', apply: a => restyle(a, { color: '#ffffff', band: { color: '#e60012', padX: 28, padY: 10, radius: 6 } }) },
  { id: 'shadow', name: '影だけ', apply: a => restyle(a, { color: '#ffffff', shadow: { x: 6, y: 8, blur: 12, color: '#000000cc' } }) },
  { id: 'black-white', name: '黒×白縁', apply: a => restyle(a, { color: '#111111', outlines: [{ width: 12, color: '#ffffff' }] }) },
  { id: 'neon', name: 'ネオン', apply: a => restyle(a, { color: '#e8fffb', outlines: [{ width: 3, color: '#00e5ff' }], shadow: { x: 0, y: 0, blur: 24, color: '#00e5ffcc' } }) },
];
