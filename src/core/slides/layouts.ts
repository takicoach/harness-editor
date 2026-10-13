import { SLIDE_LAYOUT_IDS, type SlideColorRole, type SlideFontRole, type SlideLayoutId, type SlidePair } from './model';

export interface SlotRect { x: number; y: number; width: number; height: number }
export interface TextSlot { kind: 'text'; id: string; name: string; rect: SlotRect; font: SlideFontRole; color: SlideColorRole; fontSize: number; minFontSize: number; align: 'left' | 'center' | 'right'; lineHeight: number; text: string;
  /** top: 枠の上端から始める（本文・説明）。center: 枠の中央（見出し・題）。 */ anchor: 'center' | 'top' }
export interface ShapeSlot { kind: 'shape'; id: string; name: string; rect: SlotRect; shape: 'rect' | 'ellipse'; fill: SlideColorRole; cornerRadius: number }
export interface ImageSlot { kind: 'image'; id: string; name: string; rect: SlotRect }
export type LayoutSlot = TextSlot | ShapeSlot | ImageSlot;
export type FieldSpec =
  | { kind: 'text'; name: string; label: string; required: boolean; maxChars: number }
  | { kind: 'list'; name: string; label: string; min: number; max: number; maxChars: number }
  | { kind: 'pair'; name: string; label: string; titleChars: number; bodyChars: number };
export interface SlideLayoutSpec { id: SlideLayoutId; name: string; summary: string; fields: readonly FieldSpec[]; imageSlots: readonly string[] }
/** 入力（AI の本文・手で直した文字から取り出した値）。足りない項目は枠ごと作らない。 */
export type SlideFieldsInput = { [name: string]: string | readonly string[] | SlidePair | undefined };

const HEADING: FieldSpec = { kind: 'text', name: 'heading', label: '見出し', required: true, maxChars: 24 };
/** レイアウト 6 種（自前設計）。最大文字数はここが正本（検証器と依頼文が読む）。 */
export const SLIDE_LAYOUTS: Readonly<Record<SlideLayoutId, SlideLayoutSpec>> = {
  cover: { id: 'cover', name: '表紙', summary: '題と副題', imageSlots: [], fields: [
    { kind: 'text', name: 'title', label: '題', required: true, maxChars: 26 }, { kind: 'text', name: 'subtitle', label: '副題', required: false, maxChars: 40 }] },
  chapter: { id: 'chapter', name: '章見出し', summary: '章番号と章名', imageSlots: [], fields: [
    { kind: 'text', name: 'number', label: '章番号', required: true, maxChars: 6 }, { kind: 'text', name: 'title', label: '章名', required: true, maxChars: 24 }] },
  points: { id: 'points', name: '要点', summary: '見出しと箇条書き 3〜5', imageSlots: [], fields: [
    HEADING, { kind: 'list', name: 'bullets', label: '箇条書き', min: 3, max: 5, maxChars: 30 }] },
  'image-text': { id: 'image-text', name: '画像＋説明', summary: '見出し・箇条書き 2〜3・画像枠', imageSlots: ['image'], fields: [
    HEADING, { kind: 'list', name: 'bullets', label: '箇条書き', min: 2, max: 3, maxChars: 30 }] },
  compare: { id: 'compare', name: '左右比較', summary: '見出しと左右の題・本文', imageSlots: [], fields: [
    HEADING, { kind: 'pair', name: 'left', label: '左', titleChars: 14, bodyChars: 80 }, { kind: 'pair', name: 'right', label: '右', titleChars: 14, bodyChars: 80 }] },
  steps: { id: 'steps', name: '手順', summary: '見出しと手順 3〜4（番号は自動）', imageSlots: [], fields: [
    HEADING, { kind: 'list', name: 'steps', label: '手順', min: 3, max: 4, maxChars: 30 }] },
};
export interface LayoutCatalogEntry { id: SlideLayoutId; name: string; summary: string; fields: FieldSpec[]; imageSlots: string[] }
/** AI と依頼文に渡す一覧（入力の型と文字数の上限）。 */
export function slideLayoutCatalog(): LayoutCatalogEntry[] {
  return SLIDE_LAYOUT_IDS.map(id => { const spec = SLIDE_LAYOUTS[id]; return { id, name: spec.name, summary: spec.summary, fields: spec.fields.map(field => ({ ...field })), imageSlots: [...spec.imageSlots] }; });
}

export const BULLET = '・';
export function bulletText(items: readonly string[]): string { return items.map(item => `${BULLET}${item}`).join('\n'); }
export function bulletItems(text: string): string[] { return text.split('\n').map(line => line.replace(/^\s*[・•\-*]\s*/, '').trim()).filter(Boolean); }
const stringOf = (fields: SlideFieldsInput, name: string) => { const value = fields[name]; return typeof value === 'string' ? value : ''; };
const listOf = (fields: SlideFieldsInput, name: string) => { const value = fields[name]; return Array.isArray(value) ? (value as readonly unknown[]).filter((item): item is string => typeof item === 'string' && item !== '') : []; };
const pairOf = (fields: SlideFieldsInput, name: string): SlidePair | null => {
  const value = fields[name];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as SlidePair : null;
};
function text(id: string, name: string, rect: SlotRect, font: SlideFontRole, color: SlideColorRole, fontSize: number, minFontSize: number,
  align: TextSlot['align'], lineHeight: number, value: string, anchor: TextSlot['anchor'] = 'center'): TextSlot {
  return { kind: 'text', id, name, rect, font, color, fontSize, minFontSize, align, lineHeight, text: value, anchor };
}
const BACKGROUND: ShapeSlot = { kind: 'shape', id: 'background', name: '背景', rect: { x: 0, y: 0, width: 1920, height: 1080 }, shape: 'rect', fill: 'background', cornerRadius: 0 };
const RULE: ShapeSlot = { kind: 'shape', id: 'rule', name: '見出しの線', rect: { x: 120, y: 222, width: 200, height: 10 }, shape: 'rect', fill: 'accent', cornerRadius: 5 };
const heading = (value: string) => text('heading', '見出し', { x: 120, y: 60, width: 1680, height: 150 }, 'heading', 'text', 80, 60, 'left', 1.25, value);

/** レイアウトの枠（重なり順＝配列の順）。文字が空の枠は作らない。最小文字サイズ: 見出し 60・要点 40・画像＋説明 40・比較の本文 36・手順 36。本文は枠の上端から始める。 */
export function layoutSlots(layout: SlideLayoutId, fields: SlideFieldsInput): LayoutSlot[] {
  const slots: LayoutSlot[] = [BACKGROUND];
  const add = (slot: TextSlot) => { if (slot.text) slots.push(slot); };
  switch (layout) {
    case 'cover':
      slots.push({ kind: 'shape', id: 'accent', name: '飾りの線', rect: { x: 860, y: 600, width: 200, height: 10 }, shape: 'rect', fill: 'accent', cornerRadius: 5 });
      add(text('title', '題', { x: 160, y: 290, width: 1600, height: 290 }, 'heading', 'text', 112, 72, 'center', 1.2, stringOf(fields, 'title')));
      add(text('subtitle', '副題', { x: 160, y: 640, width: 1600, height: 180 }, 'body', 'muted', 52, 36, 'center', 1.4, stringOf(fields, 'subtitle')));
      return slots;
    case 'chapter':
      add(text('number', '章番号', { x: 160, y: 200, width: 1600, height: 250 }, 'heading', 'accent', 200, 120, 'center', 1.1, stringOf(fields, 'number')));
      add(text('title', '章名', { x: 160, y: 500, width: 1600, height: 300 }, 'heading', 'text', 104, 72, 'center', 1.25, stringOf(fields, 'title')));
      return slots;
    case 'points':
      add(heading(stringOf(fields, 'heading'))); slots.push(RULE);
      add(text('bullets', '箇条書き', { x: 160, y: 264, width: 1600, height: 780 }, 'body', 'text', 60, 40, 'left', 1.5, bulletText(listOf(fields, 'bullets')), 'top'));
      return slots;
    case 'image-text':
      add(heading(stringOf(fields, 'heading'))); slots.push(RULE);
      add(text('bullets', '箇条書き', { x: 120, y: 264, width: 800, height: 780 }, 'body', 'text', 54, 40, 'left', 1.5, bulletText(listOf(fields, 'bullets')), 'top'));
      slots.push({ kind: 'image', id: 'image', name: '画像の枠', rect: { x: 960, y: 280, width: 840, height: 720 } });
      return slots;
    case 'compare':
      add(heading(stringOf(fields, 'heading'))); slots.push(RULE);
      for (const [side, x, label] of [['left', 120, '左'], ['right', 980, '右']] as const) {
        const value = pairOf(fields, side);
        slots.push({ kind: 'shape', id: `${side}-panel`, name: `${label}の面`, rect: { x, y: 280, width: 820, height: 720 }, shape: 'rect', fill: 'surface', cornerRadius: 24 });
        add(text(`${side}-title`, `${label}の題`, { x: x + 40, y: 310, width: 740, height: 110 }, 'heading', 'accent', 64, 44, 'center', 1.2, value?.title ?? ''));
        add(text(`${side}-body`, `${label}の本文`, { x: x + 40, y: 420, width: 740, height: 560 }, 'body', 'text', 50, 36, 'left', 1.6, value?.body ?? '', 'top'));
      }
      return slots;
    case 'steps': {
      add(heading(stringOf(fields, 'heading'))); slots.push(RULE);
      const steps = listOf(fields, 'steps'), count = Math.max(1, steps.length), width = (1680 - (count - 1) * 40) / count;
      steps.forEach((step, index) => {
        const x = 120 + index * (width + 40), center = x + width / 2, circle = { x: center - 70, y: 300, width: 140, height: 140 };
        slots.push({ kind: 'shape', id: `circle-${index + 1}`, name: `番号の丸 ${index + 1}`, rect: circle, shape: 'ellipse', fill: 'accent', cornerRadius: 0 });
        slots.push(text(`number-${index + 1}`, `番号 ${index + 1}`, circle, 'heading', 'background', 72, 72, 'center', 1, String(index + 1)));
        add(text(`step-${index + 1}`, `手順 ${index + 1}`, { x: x - 20, y: 480, width: width + 40, height: 520 }, 'body', 'text', 52, 36, 'center', 1.5, step, 'top'));
      });
      return slots;
    }
  }
}
