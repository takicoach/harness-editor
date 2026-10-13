import { fontById, fontStack } from '../fonts';
import { SequenceError } from '../sequence/errors';
import type { SlideColorRole, SlideFontRole, SlideThemeChoice, SlideThemeId } from './model';

export interface SlideThemeSpec { id: SlideThemeId; name: string; tone: 'dark' | 'light'; colors: Record<SlideColorRole, string>; fonts: Record<SlideFontRole, string> }
/** テーマ 2 種（自前設計）。fonts は同梱の書体の ID。 */
export const SLIDE_THEMES: Readonly<Record<SlideThemeId, SlideThemeSpec>> = {
  'forest-gold': { id: 'forest-gold', name: '深緑×金', tone: 'dark',
    colors: { background: '#0f2a1f', surface: '#183d2e', text: '#f5f1e3', accent: '#d6a93a', muted: '#a8b8ad' },
    fonts: { heading: 'noto-sans-jp-black', body: 'noto-sans-jp' } },
  'white-navy': { id: 'white-navy', name: '白×紺', tone: 'light',
    colors: { background: '#ffffff', surface: '#eef2f8', text: '#14213d', accent: '#1f3f8f', muted: '#5b6782' },
    fonts: { heading: 'noto-sans-jp-black', body: 'biz-udpgothic' } },
};
export const SLIDE_COLOR_LABELS: Readonly<Record<SlideColorRole, string>> = { background: '地', surface: '面', text: '文字', accent: '強調', muted: '補助' };
export interface ResolvedSlideTheme {
  id: SlideThemeId; colors: Record<SlideColorRole, string>; fontIds: Record<SlideFontRole, string>;
  fontStacks: Record<SlideFontRole, string>; weights: Record<SlideFontRole, number>;
}
/** 見出しは極太（Noto Sans JP 900）なら 900、ほかの書体は 700。本文は 400。 */
export function slideFontWeight(role: SlideFontRole, fontId: string): number {
  return role === 'heading' ? (fontId === 'noto-sans-jp-black' ? 900 : 700) : 400;
}
function bundledStack(fontId: string): string {
  const font = fontById(fontId);
  if (!font || font.group !== 'bundled') throw new SequenceError('INVALID_DOCUMENT', 'スライドで使える書体は同梱の書体だけです', [fontId]);
  return fontStack(font);
}
/** テーマ ID と上書きから、実際に使う色・書体を決める。 */
export function resolveSlideTheme(choice: SlideThemeChoice): ResolvedSlideTheme {
  const spec = SLIDE_THEMES[choice.id];
  if (!spec) throw new SequenceError('INVALID_DOCUMENT', '知らないテーマです', [String(choice.id)]);
  const colors: Record<SlideColorRole, string> = { ...spec.colors, ...choice.overrides?.colors };
  const fontIds: Record<SlideFontRole, string> = { ...spec.fonts, ...choice.overrides?.fonts };
  return { id: spec.id, colors, fontIds, fontStacks: { heading: bundledStack(fontIds.heading), body: bundledStack(fontIds.body) },
    weights: { heading: slideFontWeight('heading', fontIds.heading), body: slideFontWeight('body', fontIds.body) } };
}
