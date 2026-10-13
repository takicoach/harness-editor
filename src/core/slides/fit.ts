import { stripEmphasis } from '../sequence/renderExtras';
import { LEGACY_TEXT_PADDING } from '../textDecoration';
import { extractFields, splitFields } from './build';
import { layoutSlots, type TextSlot } from './layouts';
import { SLIDES_CANVAS, type SlidePage } from './model';

/** 自動縮小の刻み（px）。 */
export const FIT_STEP = 2;
/** 1 文字の幅（em）。全角は 1、半角英数は約 0.58、半角の空白は 0.33、半角カナは 0.5。実際の描画より少し広めに見積もる。 */
export function charWidthEm(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (char === ' ') return .33;
  if (code < 0x80) return .58;
  if (code >= 0xff61 && code <= 0xff9f) return .5;
  return 1;
}
/** 文字枠の内側の幅に入る行数（改行ごとに折り返しを数える）。 */
export function measureLines(text: string, fontSize: number, letterSpacing: number, width: number): number {
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    let line = 0, count = 1;
    for (const char of Array.from(paragraph)) {
      const advance = charWidthEm(char) * fontSize + letterSpacing;
      if (line > 0 && line + advance > width) { count++; line = advance; } else line += advance;
    }
    lines += count;
  }
  return lines;
}
/** 文字の塊の高さ（px）。描画の既定の余白（上下 8px・左右 16px）を含める。 */
export function blockHeight(text: string, fontSize: number, lineHeight: number, letterSpacing: number, boxWidth: number): number {
  const inner = Math.max(1, boxWidth - 2 * LEGACY_TEXT_PADDING.x);
  return measureLines(text, fontSize, letterSpacing, inner) * fontSize * lineHeight + 2 * LEGACY_TEXT_PADDING.y;
}
export interface TextFitInput { text: string; width: number; height: number; fontSize: number; minFontSize: number; lineHeight: number; letterSpacing: number }
export interface TextFitResult { fontSize: number; fits: boolean; height: number }
/** 枠に収まる最大の大きさ。最小文字サイズまで縮めても収まらなければ fits=false（大きさは最小のまま。小さくして警告を消さない）。 */
export function fitText(input: TextFitInput): TextFitResult {
  let size = Math.max(input.fontSize, input.minFontSize);
  for (;;) {
    const height = blockHeight(input.text, size, input.lineHeight, input.letterSpacing, input.width);
    if (height <= input.height) return { fontSize: size, fits: true, height };
    if (size === input.minFontSize) return { fontSize: size, fits: false, height };
    size = Math.max(input.minFontSize, size - FIT_STEP);
  }
}

export interface SlotFit { layerId: string; slot: string; status: 'ok' | 'overflow' | 'small'; fontSize: number; minFontSize: number; height: number; limit: number }
export interface PageFit { status: 'ok' | 'overflow' | 'small'; slots: SlotFit[]; suggestions: Array<'split' | 'shorten' | 'layout'> }
/**
 * ページの収まり。枠に結び付いた文字だけを、今の大きさ（fontSize × 拡大）で測る。
 * 枠の高さを超えたら overflow、最小文字サイズより小さければ small。どちらかがあれば提案を出す。
 */
export function pageFit(page: SlidePage): PageFit {
  const slotsById = new Map(layoutSlots(page.layout, extractFields(page)).filter((slot): slot is TextSlot => slot.kind === 'text').map(slot => [slot.id, slot]));
  const slots: SlotFit[] = [];
  for (const layer of page.layers) {
    const slotId = page.bindings[layer.id]?.slot, slot = slotId ? slotsById.get(slotId) : undefined;
    if (!slot || layer.hidden || layer.content.kind !== 'text') continue;
    const appearance = layer.content.appearance, scale = layer.visual.scale, size = appearance.fontSize * scale;
    const height = scale * blockHeight(stripEmphasis(layer.content.text), appearance.fontSize, appearance.lineHeight, appearance.letterSpacing, (appearance.box?.width ?? .85) * SLIDES_CANVAS.width);
    const status = height > slot.rect.height ? 'overflow' : size < slot.minFontSize ? 'small' : 'ok';
    slots.push({ layerId: layer.id, slot: slot.id, status, fontSize: size, minFontSize: slot.minFontSize, height: Math.round(height), limit: slot.rect.height });
  }
  const status = slots.some(slot => slot.status === 'overflow') ? 'overflow' : slots.some(slot => slot.status === 'small') ? 'small' : 'ok';
  if (status === 'ok') return { status, slots, suggestions: [] };
  const canSplit = status === 'overflow' && splitFields(page.layout, extractFields(page)) !== null;
  return { status, slots, suggestions: [...(canSplit ? ['split' as const] : []), 'shorten', 'layout'] };
}
