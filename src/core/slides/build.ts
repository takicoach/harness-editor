import { DEFAULT_TEXT_APPEARANCE } from '../sequence/model';
import { stripEmphasis } from '../sequence/renderExtras';
import type { ThumbnailLayer, ThumbnailVisual } from '../thumbnail/model';
import { fitText } from './fit';
import { bulletItems, layoutSlots, type SlideFieldsInput, type SlotRect } from './layouts';
import { SLIDES_CANVAS, type SlideLayerBinding, type SlideLayoutId, type SlidePage, type SlidePair } from './model';
import type { ResolvedSlideTheme } from './themes';

export interface BuiltSlide { layers: ThumbnailLayer[]; bindings: Record<string, SlideLayerBinding> }
type PageParts = Pick<SlidePage, 'layers' | 'bindings'>;
const round = (value: number) => Math.round(value * 10000) / 10000;
/** 枠の中心を、キャンバス中心原点の正規化位置（±1 で端）にする。 */
export function rectPosition(rect: SlotRect): { x: number; y: number } {
  return { x: round((rect.x + rect.width / 2) / (SLIDES_CANVAS.width / 2) - 1), y: round((rect.y + rect.height / 2) / (SLIDES_CANVAS.height / 2) - 1) };
}
/** 画像は大きさ 1 でキャンバスに収まる（contain）。枠の幅・高さの比の小さい方を掛ければ枠に収まる。 */
export function imageScaleFor(rect: SlotRect): number {
  return round(Math.min(rect.width / SLIDES_CANVAS.width, rect.height / SLIDES_CANVAS.height));
}
/** 上揃えの枠は、層の位置が枠の上端の中央（文字は位置から下へ向かって並ぶ）。 */
const topPosition = (rect: SlotRect) => ({ x: rectPosition(rect).x, y: round(rect.y / (SLIDES_CANVAS.height / 2) - 1) });
const visualOf = (rect: SlotRect): ThumbnailVisual => ({ position: rectPosition(rect), scale: 1, rotation: 0, opacity: 1 });

/** 入力からレイヤーを組む。文字は最小文字サイズまで自動で縮める（それでも収まらない判定は fit.ts の pageFit が出す）。 */
export function buildSlideLayers(layout: SlideLayoutId, fields: SlideFieldsInput, theme: ResolvedSlideTheme, idFor: (slotId: string) => string,
  images: Readonly<Record<string, string>> = {}): BuiltSlide {
  const layers: ThumbnailLayer[] = [], bindings: Record<string, SlideLayerBinding> = {};
  for (const slot of layoutSlots(layout, fields)) {
    const id = idFor(slot.id);
    if (slot.kind === 'text') {
      const fit = fitText({ text: stripEmphasis(slot.text), width: slot.rect.width, height: slot.rect.height, fontSize: slot.fontSize, minFontSize: slot.minFontSize, lineHeight: slot.lineHeight, letterSpacing: 0 });
      layers.push({ id, name: slot.name, hidden: false, locked: false, visual: { ...visualOf(slot.rect), ...(slot.anchor === 'top' ? { position: topPosition(slot.rect) } : {}) }, content: { kind: 'text', text: slot.text, appearance: {
        ...DEFAULT_TEXT_APPEARANCE, fontFamily: theme.fontStacks[slot.font], fontSize: fit.fontSize, fontWeight: theme.weights[slot.font], color: theme.colors[slot.color],
        strokeColor: '#000000', strokeWidth: 0, background: 'transparent', align: slot.align, lineHeight: slot.lineHeight, letterSpacing: 0,
        box: { width: round(slot.rect.width / SLIDES_CANVAS.width), anchor: slot.anchor }, emphasis: { color: theme.colors.accent } } } });
      bindings[id] = { slot: slot.id, color: slot.color, font: slot.font };
    } else if (slot.kind === 'shape') {
      const color = theme.colors[slot.fill];
      layers.push({ id, name: slot.name, hidden: false, locked: slot.id === 'background', visual: visualOf(slot.rect),
        content: { kind: 'shape', shape: { kind: slot.shape, width: slot.rect.width, height: slot.rect.height, color, strokeWidth: 0, cornerRadius: slot.cornerRadius, fill: { kind: 'solid', color } } } });
      bindings[id] = { slot: slot.id, stroke: slot.fill, fill: slot.fill };
    } else {
      const assetId = images[slot.id];
      if (assetId) {
        layers.push({ id, name: '画像', hidden: false, locked: false, visual: { ...visualOf(slot.rect), scale: imageScaleFor(slot.rect) }, content: { kind: 'image', assetId, role: 'element' } });
        bindings[id] = { slot: slot.id };
      } else {
        const color = theme.colors.surface;
        layers.push({ id, name: slot.name, hidden: false, locked: false, visual: visualOf(slot.rect),
          content: { kind: 'shape', shape: { kind: 'rect', width: slot.rect.width, height: slot.rect.height, color, strokeWidth: 0, cornerRadius: 16, fill: { kind: 'solid', color } } } });
        bindings[id] = { slot: slot.id, stroke: 'surface', fill: 'surface' };
      }
    }
  }
  return { layers, bindings };
}

/** 枠に結び付いた文字から入力を取り出す（手で直した文字も含む）。 */
export function extractFields(page: PageParts): SlideFieldsInput {
  const texts = new Map<string, string>();
  for (const layer of page.layers) {
    const slot = page.bindings[layer.id]?.slot;
    if (slot && layer.content.kind === 'text') texts.set(slot, layer.content.text);
  }
  const fields: SlideFieldsInput = {};
  for (const name of ['title', 'subtitle', 'number', 'heading'] as const) { const value = texts.get(name); if (value !== undefined) fields[name] = value; }
  const bullets = texts.get('bullets');
  if (bullets !== undefined) fields.bullets = bulletItems(bullets);
  for (const side of ['left', 'right'] as const) {
    const title = texts.get(`${side}-title`), body = texts.get(`${side}-body`);
    if (title !== undefined || body !== undefined) fields[side] = { title: title ?? '', body: body ?? '' };
  }
  const steps = [...texts.entries()].filter(([slot]) => /^step-\d+$/.test(slot)).sort(([a], [b]) => Number(a.slice(5)) - Number(b.slice(5))).map(([, value]) => value);
  if (steps.length) fields.steps = steps;
  return fields;
}
/** 画像枠に入っている画像（枠 → 素材 ID）。 */
export function slotImages(page: PageParts): Record<string, string> {
  const images: Record<string, string> = {};
  for (const layer of page.layers) { const slot = page.bindings[layer.id]?.slot; if (slot && layer.content.kind === 'image') images[slot] = layer.content.assetId; }
  return images;
}
/** ページの見出し（一覧・依頼文・MCP の読み取りに使う）。 */
export function slidePageTitle(page: PageParts): string {
  const fields = extractFields(page);
  for (const name of ['heading', 'title']) { const value = fields[name]; if (typeof value === 'string' && value) return value; }
  return '';
}
/** 別のレイアウトへ移すときの入力。文字は捨てず、近い枠へ寄せる。 */
export function convertFields(fields: SlideFieldsInput, to: SlideLayoutId): SlideFieldsInput {
  const text = (name: string) => { const value = fields[name]; return typeof value === 'string' && value ? value : undefined; };
  const list = (name: string) => { const value = fields[name]; return Array.isArray(value) ? [...value as readonly string[]] : undefined; };
  const pair = (name: string) => { const value = fields[name]; return value && typeof value === 'object' && !Array.isArray(value) ? value as SlidePair : undefined; };
  const left = pair('left'), right = pair('right'), head = text('heading') ?? text('title') ?? '';
  const sides = [left, right].filter((value): value is SlidePair => !!value).map(value => value.body ? `${value.title}：${value.body}` : value.title);
  const items = list('bullets') ?? list('steps') ?? (sides.length ? sides : undefined) ?? (text('subtitle') ? [text('subtitle')!] : []);
  switch (to) {
    case 'cover': return { title: text('title') ?? head, subtitle: text('subtitle') ?? items[0] ?? '' };
    case 'chapter': return { number: text('number') ?? '', title: text('title') ?? head };
    case 'points': case 'image-text': return { heading: head, bullets: items };
    case 'steps': return { heading: head, steps: items };
    case 'compare': return { heading: head, left: left ?? { title: items[0] ?? '', body: items[1] ?? '' }, right: right ?? { title: items[2] ?? '', body: items[3] ?? '' } };
  }
}
/** 「分ける」: 箇条書き・手順の後半を次のページへ。見出しには（続き）を付ける。 */
export function splitFields(layout: SlideLayoutId, fields: SlideFieldsInput): [SlideFieldsInput, SlideFieldsInput] | null {
  const name = layout === 'steps' ? 'steps' : layout === 'points' || layout === 'image-text' ? 'bullets' : null;
  if (!name) return null;
  const value = fields[name], items = Array.isArray(value) ? [...value as readonly string[]] : [];
  if (items.length < 2) return null;
  const half = Math.ceil(items.length / 2), heading = typeof fields.heading === 'string' ? fields.heading : '';
  return [{ ...fields, [name]: items.slice(0, half) }, { ...fields, heading: heading ? `${heading}（続き）` : '', [name]: items.slice(half) }];
}
/** 白紙のページ（人が足す）の仮の文字。 */
export function placeholderFields(layout: SlideLayoutId): SlideFieldsInput {
  switch (layout) {
    case 'cover': return { title: 'タイトル', subtitle: 'サブタイトル' };
    case 'chapter': return { number: '01', title: '章の名前' };
    case 'points': return { heading: '見出し', bullets: ['ポイント 1', 'ポイント 2', 'ポイント 3'] };
    case 'image-text': return { heading: '見出し', bullets: ['説明 1', '説明 2'] };
    case 'compare': return { heading: '見出し', left: { title: '左', body: '説明' }, right: { title: '右', body: '説明' } };
    case 'steps': return { heading: '手順', steps: ['手順 1', '手順 2', '手順 3'] };
  }
}
/** 構成案を確定した直後（本文待ち）のページ: 題だけを置く。 */
export function titleFields(layout: SlideLayoutId, title: string): SlideFieldsInput {
  return layout === 'cover' || layout === 'chapter' ? { title } : { heading: title };
}
