import { SequenceError } from '../sequence/errors';
import type { ThumbnailContent } from '../thumbnail/model';
import { buildSlideLayers } from './build';
import type { SlideFieldsInput } from './layouts';
import { SLIDES_MAX_LAYERS, type SlideDocument, type SlideLayerBinding, type SlideLayoutId, type SlidePage, type SlideProposal } from './model';
import { resolveSlideTheme, type ResolvedSlideTheme } from './themes';

export const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export function invalid(message: string, targets: string[] = []): never { throw new SequenceError('INVALID_DOCUMENT', message, targets); }
export function outOfRange(message: string): never { throw new SequenceError('INVALID_RANGE', message); }
export function checkIndex(index: unknown, max: number): number {
  if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) > max) outOfRange('並べる位置が範囲外です');
  return index as number;
}
export function slideTheme(document: SlideDocument): ResolvedSlideTheme { return resolveSlideTheme(document.theme); }
/** `<ページ ID>-<枠>` の形でレイヤー ID を割り当てる。文書全体で重ならないようにする。release は組み直すページの古い枠の ID（使い直してよい）。 */
export function layerIdAllocator(document: SlideDocument, pageId: string, release: Iterable<string> = []): (slot: string) => string {
  const used = new Set(document.pages.flatMap(page => page.layers.map(layer => layer.id)));
  for (const id of release) used.delete(id);
  const prefix = pageId.slice(0, 60);
  return slot => { let id = `${prefix}-${slot}`, n = 1; while (used.has(id)) id = `${prefix}-${slot}-${++n}`; used.add(id); return id; };
}
/** テーマの役割に結び付いた色と書体だけを差し替える（位置・大きさ・文字は変えない）。 */
export function applyThemeToPage(page: SlidePage, theme: ResolvedSlideTheme): void {
  for (const layer of page.layers) {
    const binding = page.bindings[layer.id], content = layer.content;
    if (!binding) continue;
    if (content.kind === 'text') {
      if (binding.color) content.appearance.color = theme.colors[binding.color];
      if (content.appearance.emphasis) content.appearance.emphasis = { color: theme.colors.accent };
      if (binding.font) { content.appearance.fontFamily = theme.fontStacks[binding.font]; content.appearance.fontWeight = theme.weights[binding.font]; }
    } else if (content.kind === 'shape') {
      if (binding.stroke) content.shape.color = theme.colors[binding.stroke];
      if (binding.fill) content.shape.fill = { kind: 'solid', color: theme.colors[binding.fill] };
    }
  }
}
/** 手で色や書体を変えた項目の結び付きを外す（テーマを変えても戻さない）。何も残らなければ null。 */
export function detachBinding(binding: SlideLayerBinding, before: ThumbnailContent, after: ThumbnailContent): SlideLayerBinding | null {
  const next: SlideLayerBinding = { ...binding };
  if (before.kind === 'text' && after.kind === 'text') {
    if (before.appearance.color !== after.appearance.color) delete next.color;
    if (before.appearance.fontFamily !== after.appearance.fontFamily || before.appearance.fontWeight !== after.appearance.fontWeight) delete next.font;
  } else if (before.kind === 'shape' && after.kind === 'shape') {
    if (before.shape.color !== after.shape.color) delete next.stroke;
    if (JSON.stringify(before.shape.fill) !== JSON.stringify(after.shape.fill)) delete next.fill;
  }
  return Object.keys(next).length ? next : null;
}
/** 枠に結び付いたレイヤーを組み直す。手で足したレイヤー（枠なし）は前面に残す。 */
export function rebuildPage(document: SlideDocument, page: SlidePage, layout: SlideLayoutId, fields: SlideFieldsInput, images: Readonly<Record<string, string>>): void {
  const bound = (id: string) => page.bindings[id]?.slot !== undefined;
  const kept = page.layers.filter(layer => !bound(layer.id));
  const built = buildSlideLayers(layout, fields, slideTheme(document), layerIdAllocator(document, page.id, page.layers.filter(layer => bound(layer.id)).map(layer => layer.id)), images);
  if (built.layers.length + kept.length > SLIDES_MAX_LAYERS) outOfRange(`1 ページに置けるレイヤーは ${SLIDES_MAX_LAYERS} までです`);
  const keptBindings = Object.fromEntries(Object.entries(page.bindings).filter(([id]) => kept.some(layer => layer.id === id)));
  page.layout = layout; page.layers = [...built.layers, ...kept]; page.bindings = { ...built.bindings, ...keptBindings };
}
/** 受け取った本文でページを組み直す（AI のページとして・手直しの印を外す）。 */
export function fillPageFromBody(document: SlideDocument, page: SlidePage, proposal: SlideProposal, sourceParagraphIds: readonly string[]): void {
  rebuildPage(document, page, proposal.body.layout, proposal.body.fields as unknown as SlideFieldsInput, proposal.images);
  page.notes = proposal.body.notes; page.sourceParagraphIds = [...sourceParagraphIds]; page.origin = 'ai'; page.editedAfterGeneration = false;
}
/** 使われていないページ ID（base、無理なら base-2, base-3 …）。 */
export function freshPageId(document: SlideDocument, base: string): string {
  const used = new Set(document.pages.map(page => page.id)), head = base.slice(0, 90);
  let id = head, n = 1; while (used.has(id)) id = `${head}-${++n}`;
  return id;
}
