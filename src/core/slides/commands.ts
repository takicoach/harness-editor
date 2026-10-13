import type { SequenceAsset } from '../sequence/model';
import { canonicalJson } from '../thumbnail/json';
import type { ThumbnailContent, ThumbnailLayer, ThumbnailVisual } from '../thumbnail/model';
import { buildSlideLayers, convertFields, extractFields, imageScaleFor, placeholderFields, rectPosition, slotImages, splitFields } from './build';
import { splitScript } from './contract';
import { layoutSlots, SLIDE_LAYOUTS } from './layouts';
import { findSlideLayer, findSlidePage, SLIDE_LAYOUT_IDS, SLIDES_MAX_COMMAND_LEAVES, SLIDES_MAX_LAYERS, SLIDES_MAX_NOTES_CHARS, SLIDES_MAX_PAGES, SLIDES_MAX_SCRIPT_CHARS,
  type SlideDocument, type SlideLayoutId, type SlidePage, type SlideThemeChoice } from './model';
import { applyThemeToPage, checkIndex, detachBinding, invalid, layerIdAllocator, outOfRange, rebuildPage, record, slideTheme } from './pageOps';
import { resolveSlideTheme } from './themes';
import { applyGenerationCommand, isGenerationCommand, SLIDE_GENERATION_COMMAND_TYPES, type SlideGenerationCommand } from './generation';
import { slideContentKey, validateSlideDocument } from './validate';

/** レイヤーの 5 コマンドはサムネと同じ形（画面の部品を共有する）。 */
export type SlideLayerCommand =
  | { type: 'add-layer'; pageId: string; layer: ThumbnailLayer; index?: number }
  | { type: 'update-layer'; pageId: string; layerId: string; patch: { name?: string; content?: ThumbnailContent; visual?: ThumbnailVisual } }
  | { type: 'delete-layers'; pageId: string; layerIds: string[] }
  | { type: 'reorder-layer'; pageId: string; layerId: string; index: number }
  | { type: 'set-layer-flags'; pageId: string; layerId: string; hidden?: boolean; locked?: boolean };
export type SlidePageCommand =
  | { type: 'add-page'; pageId: string; layout: SlideLayoutId; index?: number }
  | { type: 'duplicate-page'; pageId: string; newPageId: string }
  | { type: 'delete-pages'; pageIds: string[] }
  | { type: 'reorder-page'; pageId: string; index: number }
  | { type: 'set-notes'; pageId: string; notes: string }
  | { type: 'set-layout'; pageId: string; layout: SlideLayoutId }
  | { type: 'split-page'; pageId: string; newPageId: string }
  | { type: 'fill-image-slot'; pageId: string; slot: string; assetId: string };
export type SlideDocumentCommand =
  | { type: 'set-theme'; theme: SlideThemeChoice }
  | { type: 'set-script'; text: string }
  | { type: 'register-assets'; assets: SequenceAsset[] };
export type SlideCommand = SlideLayerCommand | SlidePageCommand | SlideDocumentCommand | SlideGenerationCommand | { type: 'batch'; commands: SlideCommand[] };
export type SlideHistoryCommand = { type: 'undo' } | { type: 'redo' };
const BASE_SLIDE_COMMAND_TYPES = ['add-layer', 'update-layer', 'delete-layers', 'reorder-layer', 'set-layer-flags', 'add-page', 'duplicate-page', 'delete-pages',
  'reorder-page', 'set-notes', 'set-layout', 'split-page', 'fill-image-slot', 'set-theme', 'set-script', 'register-assets', 'batch'] as const;
export const SLIDE_COMMAND_TYPES: readonly string[] = [...BASE_SLIDE_COMMAND_TYPES, ...SLIDE_GENERATION_COMMAND_TYPES];
/** 人がページの中身を直す操作。AI のページに当たったら「手で直した」印を付ける。 */
export const HUMAN_PAGE_EDIT_TYPES: readonly string[] = ['add-layer', 'update-layer', 'delete-layers', 'reorder-layer', 'set-layer-flags', 'set-notes', 'set-layout', 'split-page', 'fill-image-slot'];

/** まとめ（batch）の入れ物は数えない。 */
export function countSlideLeaves(command: SlideCommand, depth = 0): number {
  if (!record(command)) return invalid('操作の形が不正です');
  if (command.type !== 'batch') return 1;
  if (depth >= 4 || !Array.isArray(command.commands)) return invalid('まとめる操作の形が不正です');
  return command.commands.reduce((sum, child) => sum + countSlideLeaves(child, depth + 1), 0);
}
const pageKey = (page: SlidePage) => JSON.stringify(canonicalJson({ layout: page.layout, layers: page.layers, notes: page.notes }));
/** 1 つの操作を当て、人の編集の操作なら、当たったページの中身が変わった AI のページに「手で直した」印を付ける（何も変わらない操作では付けない）。
 * 印は操作ごとに付けるので、まとめ操作に別の種類の操作（set-theme 等）が混ざっても、人の編集が当たったページだけに付く。 */
function applyMarked(document: SlideDocument, command: SlideCommand): SlideDocument {
  if (!record(command) || !HUMAN_PAGE_EDIT_TYPES.includes(command.type)) return apply(document, command);
  const pageId = (command as { pageId?: unknown }).pageId, target = document.pages.find(page => page.id === pageId), before = target ? pageKey(target) : null;
  const next = apply(document, command), page = next.pages.find(item => item.id === pageId);
  if (page && before !== null && page.origin === 'ai' && !page.editedAfterGeneration && pageKey(page) !== before) page.editedAfterGeneration = true;
  return next;
}

/** 1 つの操作を複製済みの文書へ当てる。途中で失敗したら呼び出し元が複製ごと捨てる（原子的）。 */
function apply(document: SlideDocument, command: SlideCommand): SlideDocument {
  switch (command.type) {
    case 'add-layer': {
      const page = findSlidePage(document, command.pageId);
      if (page.layers.length >= SLIDES_MAX_LAYERS) outOfRange(`1 ページに置けるレイヤーは ${SLIDES_MAX_LAYERS} までです`);
      if (!record(command.layer)) invalid('追加するレイヤーが不正です');
      page.layers.splice(checkIndex(command.index ?? page.layers.length, page.layers.length), 0, structuredClone(command.layer));
      return document;
    }
    case 'update-layer': {
      const page = findSlidePage(document, command.pageId), layer = findSlideLayer(page, command.layerId), patch = command.patch;
      if (!record(patch)) invalid('変更内容が不正です');
      if (patch.content !== undefined && (!record(patch.content) || patch.content.kind !== layer.content.kind)) invalid('レイヤーの種類は変えられません', [layer.id]);
      const binding = page.bindings[layer.id];
      if (binding && patch.content !== undefined) {
        const next = detachBinding(binding, layer.content, patch.content);
        if (next) page.bindings[layer.id] = next; else delete page.bindings[layer.id];
      }
      if (patch.name !== undefined) layer.name = patch.name;
      if (patch.content !== undefined) layer.content = structuredClone(patch.content);
      if (patch.visual !== undefined) layer.visual = structuredClone(patch.visual);
      return document;
    }
    case 'delete-layers': {
      const page = findSlidePage(document, command.pageId);
      if (!Array.isArray(command.layerIds) || !command.layerIds.length) invalid('削除するレイヤーを指定してください');
      for (const id of command.layerIds) findSlideLayer(page, id);
      page.layers = page.layers.filter(layer => !command.layerIds.includes(layer.id));
      for (const id of command.layerIds) delete page.bindings[id];
      return document;
    }
    case 'reorder-layer': {
      const page = findSlidePage(document, command.pageId), layer = findSlideLayer(page, command.layerId), index = checkIndex(command.index, page.layers.length - 1);
      page.layers.splice(page.layers.indexOf(layer), 1); page.layers.splice(index, 0, layer);
      return document;
    }
    case 'set-layer-flags': {
      const layer = findSlideLayer(findSlidePage(document, command.pageId), command.layerId);
      if (command.hidden === undefined && command.locked === undefined) invalid('表示かロックを指定してください');
      if (command.hidden !== undefined) layer.hidden = command.hidden;
      if (command.locked !== undefined) layer.locked = command.locked;
      return document;
    }
    case 'add-page': {
      if (document.pages.length >= SLIDES_MAX_PAGES) outOfRange(`ページは ${SLIDES_MAX_PAGES} までです`);
      if (document.pages.some(page => page.id === command.pageId)) invalid('同じページ ID があります', [command.pageId]);
      if (!SLIDE_LAYOUT_IDS.includes(command.layout)) invalid('知らないレイアウトです', [String(command.layout)]);
      const built = buildSlideLayers(command.layout, placeholderFields(command.layout), slideTheme(document), layerIdAllocator(document, command.pageId));
      document.pages.splice(checkIndex(command.index ?? document.pages.length, document.pages.length), 0,
        { id: command.pageId, layout: command.layout, layers: built.layers, bindings: built.bindings, notes: '', sourceParagraphIds: [], origin: 'human', editedAfterGeneration: false });
      return document;
    }
    case 'duplicate-page': {
      const source = findSlidePage(document, command.pageId);
      if (document.pages.length >= SLIDES_MAX_PAGES) outOfRange(`ページは ${SLIDES_MAX_PAGES} までです`);
      if (document.pages.some(page => page.id === command.newPageId)) invalid('同じページ ID があります', [command.newPageId]);
      const allocate = layerIdAllocator(document, command.newPageId), ids = new Map(source.layers.map((layer, index) => [layer.id, allocate(`c${index + 1}`)]));
      const copy: SlidePage = { id: command.newPageId, layout: source.layout, layers: source.layers.map(layer => ({ ...structuredClone(layer), id: ids.get(layer.id)! })),
        bindings: Object.fromEntries(Object.entries(source.bindings).map(([id, binding]) => [ids.get(id)!, { ...binding }])),
        notes: source.notes, sourceParagraphIds: [...source.sourceParagraphIds], origin: 'human', editedAfterGeneration: false };
      document.pages.splice(document.pages.indexOf(source) + 1, 0, copy);
      return document;
    }
    case 'delete-pages': {
      if (!Array.isArray(command.pageIds) || !command.pageIds.length) invalid('削除するページを指定してください');
      for (const id of command.pageIds) findSlidePage(document, id);
      document.pages = document.pages.filter(page => !command.pageIds.includes(page.id));
      for (const state of document.generation?.pages ?? []) if (state.pageId && command.pageIds.includes(state.pageId)) state.pageId = null;
      return document;
    }
    case 'reorder-page': {
      const page = findSlidePage(document, command.pageId), index = checkIndex(command.index, document.pages.length - 1);
      document.pages.splice(document.pages.indexOf(page), 1); document.pages.splice(index, 0, page);
      return document;
    }
    case 'set-notes': {
      const page = findSlidePage(document, command.pageId);
      if (typeof command.notes !== 'string' || command.notes.length > SLIDES_MAX_NOTES_CHARS) outOfRange(`話すメモは ${SLIDES_MAX_NOTES_CHARS} 文字までです`);
      page.notes = command.notes;
      return document;
    }
    case 'set-layout': {
      const page = findSlidePage(document, command.pageId);
      if (!SLIDE_LAYOUT_IDS.includes(command.layout)) invalid('知らないレイアウトです', [String(command.layout)]);
      if (page.layout !== command.layout) rebuildPage(document, page, command.layout, convertFields(extractFields(page), command.layout), slotImages(page));
      return document;
    }
    case 'split-page': {
      const page = findSlidePage(document, command.pageId), parts = splitFields(page.layout, extractFields(page));
      if (!parts) outOfRange('このページは分けられません（箇条書きや手順が 2 つ以上あるページだけ分けられます）');
      if (document.pages.length >= SLIDES_MAX_PAGES) outOfRange(`ページは ${SLIDES_MAX_PAGES} までです`);
      if (document.pages.some(item => item.id === command.newPageId)) invalid('同じページ ID があります', [command.newPageId]);
      rebuildPage(document, page, page.layout, parts[0], slotImages(page));
      const built = buildSlideLayers(page.layout, parts[1], slideTheme(document), layerIdAllocator(document, command.newPageId));
      document.pages.splice(document.pages.indexOf(page) + 1, 0, { id: command.newPageId, layout: page.layout, layers: built.layers, bindings: built.bindings, notes: '',
        sourceParagraphIds: [...page.sourceParagraphIds], origin: 'human', editedAfterGeneration: false });
      return document;
    }
    case 'fill-image-slot': {
      const page = findSlidePage(document, command.pageId);
      if (!SLIDE_LAYOUTS[page.layout].imageSlots.includes(command.slot)) invalid(`このページに画像枠「${String(command.slot)}」はありません`, [page.id]);
      if (document.assets.find(asset => asset.id === command.assetId)?.kind !== 'image') invalid('画像の素材が見つかりません', [String(command.assetId)]);
      const slot = layoutSlots(page.layout, extractFields(page)).find(item => item.id === command.slot)!;
      const at = page.layers.findIndex(layer => page.bindings[layer.id]?.slot === command.slot);
      const id = at >= 0 ? page.layers[at]!.id : layerIdAllocator(document, page.id)(command.slot);
      const layer: ThumbnailLayer = { id, name: '画像', hidden: false, locked: false, content: { kind: 'image', assetId: command.assetId, role: 'element' },
        visual: { position: rectPosition(slot.rect), scale: imageScaleFor(slot.rect), rotation: 0, opacity: 1 } };
      if (at >= 0) page.layers[at] = layer; else page.layers.push(layer);
      page.bindings[id] = { slot: command.slot };
      return document;
    }
    case 'set-theme': {
      if (!record(command.theme)) invalid('テーマの指定が不正です');
      const theme = resolveSlideTheme(command.theme);
      document.theme = structuredClone(command.theme);
      for (const page of document.pages) applyThemeToPage(page, theme);
      return document;
    }
    case 'set-script': {
      const status = document.generation?.status;
      if (status === 'outline' || status === 'generating') outOfRange('生成の途中は台本を入れ替えられません。中止してから入れ替えてください');
      if (typeof command.text !== 'string' || command.text.length > SLIDES_MAX_SCRIPT_CHARS) outOfRange('台本が長すぎます（20 万文字まで）');
      document.script = { paragraphs: splitScript(command.text) };
      // 構成案の記録と元段落の対応は外れる（ページはそのまま正本として残す）。
      document.generation = null;
      for (const page of document.pages) { page.sourceParagraphIds = []; delete page.outlineKey; }
      return document;
    }
    case 'register-assets': {
      if (!Array.isArray(command.assets) || !command.assets.length || command.assets.length > 20) invalid('登録する素材の一覧が不正です');
      for (const asset of command.assets) {
        const existing = document.assets.find(item => item.id === asset.id);
        if (existing && (existing.fingerprint !== asset.fingerprint || existing.kind !== asset.kind)) invalid('同じ素材 ID に異なる素材があります', [asset.id]);
        if (!existing) document.assets.push(structuredClone(asset));
      }
      return document;
    }
    case 'batch': {
      let next = document;
      for (const child of command.commands) next = applyMarked(next, child);
      return next;
    }
    default: return isGenerationCommand(command) ? applyGenerationCommand(document, command) : invalid('未対応の操作です');
  }
}
/** 内容が変わらなければ同じ参照、変われば revision+1。結果は必ず検証する。 */
export function applySlideCommand(document: SlideDocument, command: SlideCommand): SlideDocument {
  if (countSlideLeaves(command) > SLIDES_MAX_COMMAND_LEAVES) outOfRange('まとめる編集操作が多すぎます');
  const before = slideContentKey(document), next = applyMarked(structuredClone(document), command);
  if (slideContentKey(next) === before) return document;
  next.revision = document.revision + 1;
  validateSlideDocument(next);
  return next;
}
