import { fontById } from '../fonts';
import { SequenceError } from '../sequence/errors';
import type { SequenceAsset } from '../sequence/model';
import { validateSequenceDocument } from '../sequence/validate';
import { assertPlainJson, canonicalJson } from '../thumbnail/json';
import { THUMBNAIL_ID, validateLayer } from '../thumbnail/validate';
import { outlineStructureIssues, PARAGRAPH_ID, RUN_ID, storedBodyIssues } from './contract';
import { SLIDE_LAYOUTS } from './layouts';
import { SLIDE_COLOR_ROLES, SLIDE_FONT_ROLES, SLIDE_LAYOUT_IDS, SLIDE_THEME_IDS, SLIDES_CANVAS, SLIDES_MAX_LAYERS, SLIDES_MAX_NOTES_CHARS, SLIDES_MAX_PAGES,
  SLIDES_MAX_PARAGRAPH_CHARS, SLIDES_MAX_PARAGRAPHS, type SlideDocument, type SlideGeneration, type SlideLayoutId } from './model';
import { slidePageToSequence } from './pageView';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// 関数宣言にする（const の矢印関数だと never による型の絞り込みが効かない）。
function fail(message: string, targets: string[] = []): never { throw new SequenceError('INVALID_DOCUMENT', message, targets); }
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const id = (value: unknown): value is string => typeof value === 'string' && THUMBNAIL_ID.test(value);
const hex6 = (value: unknown) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
const SLOT = /^[a-z0-9-]{1,40}$/;
const LAYER_KINDS = ['text', 'image', 'shape', 'gradient'];

/** 作成・読み込み・コマンド適用・Undo/Redo・保存のすべてで呼ぶ。 */
export function validateSlideDocument(value: unknown): asserts value is SlideDocument {
  assertPlainJson(value);
  if (!record(value) || !only(value, ['schemaVersion', 'id', 'revision', 'canvas', 'theme', 'script', 'pages', 'assets', 'generation']) || value.schemaVersion !== 1 || !id(value.id)) fail('スライドのデータ形式が不正です');
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) fail('スライドの版が不正です');
  const canvas = value.canvas;
  if (!record(canvas) || !only(canvas, ['width', 'height']) || canvas.width !== SLIDES_CANVAS.width || canvas.height !== SLIDES_CANVAS.height) fail('キャンバスの大きさが不正です');
  validateTheme(value.theme);
  const paragraphs = validateScript(value.script);
  if (!Array.isArray(value.pages) || !Array.isArray(value.assets)) fail('ページまたは素材の一覧がありません');
  const document = value as unknown as SlideDocument;
  if (document.pages.length > SLIDES_MAX_PAGES) fail(`ページは ${SLIDES_MAX_PAGES} までです`);
  const assets = validateAssets(document), outlineKeys = validateGenerationShape(document);
  const pageIds = new Set<string>(), layerIds = new Set<string>();
  for (const page of document.pages) {
    const raw = page as unknown;
    if (!record(raw) || !only(raw, ['id', 'layout', 'layers', 'bindings', 'notes', 'sourceParagraphIds', 'origin', 'editedAfterGeneration', 'outlineKey']) || !id(raw.id)
      || !SLIDE_LAYOUT_IDS.includes(raw.layout as SlideLayoutId) || !Array.isArray(raw.layers) || !record(raw.bindings) || typeof raw.notes !== 'string'
      || raw.notes.length > SLIDES_MAX_NOTES_CHARS || !Array.isArray(raw.sourceParagraphIds) || (raw.origin !== 'ai' && raw.origin !== 'human')
      || typeof raw.editedAfterGeneration !== 'boolean') fail('ページの形式が不正です', [record(raw) ? String(raw.id) : '']);
    if (pageIds.has(page.id)) fail('ページの ID が重複しています', [page.id]);
    pageIds.add(page.id);
    if (page.layers.length > SLIDES_MAX_LAYERS) fail(`1 ページに置けるレイヤーは ${SLIDES_MAX_LAYERS} までです`, [page.id]);
    for (const layer of page.layers) {
      const rawLayer = layer as unknown;
      if (!record(rawLayer) || !record(rawLayer.content) || !LAYER_KINDS.includes(String(rawLayer.content.kind))) fail('スライドに置けるのは文字・画像・図形だけです', [record(rawLayer) ? String(rawLayer.id) : '']);
      validateLayer(layer, assets);
      if (layerIds.has(layer.id)) fail('レイヤーの ID が重複しています', [layer.id]);
      layerIds.add(layer.id);
    }
    for (const [layerId, binding] of Object.entries(page.bindings)) {
      const b = binding as unknown;
      if (!page.layers.some(layer => layer.id === layerId) || !record(b) || !only(b, ['slot', 'color', 'font', 'stroke', 'fill'])
        || (b.slot !== undefined && (typeof b.slot !== 'string' || !SLOT.test(b.slot)))
        || [b.color, b.stroke, b.fill].some(role => role !== undefined && !SLIDE_COLOR_ROLES.includes(role as never))
        || (b.font !== undefined && !SLIDE_FONT_ROLES.includes(b.font as never))) fail('レイヤーの結び付きが不正です', [page.id, layerId]);
    }
    if (page.sourceParagraphIds.some(pid => typeof pid !== 'string' || !paragraphs.has(pid)) || new Set(page.sourceParagraphIds).size !== page.sourceParagraphIds.length) fail('元の段落が台本にありません', [page.id]);
    if (page.outlineKey !== undefined && (typeof page.outlineKey !== 'string' || !outlineKeys.has(page.outlineKey))) fail('構成案に無いページです', [page.id]);
  }
  validateGenerationLinks(document, assets);
  // 描く側（SequenceDocument の検証）でも通ることを確かめる。保存したページが描けない状態を作らない。
  for (const [index, page] of document.pages.entries()) {
    try { validateSequenceDocument(slidePageToSequence(document, page.id)); }
    catch (error) { fail(`${index + 1} ページ目を描画用に変換できません: ${error instanceof Error ? error.message : String(error)}`, [page.id]); }
  }
}
function validateTheme(theme: unknown): void {
  if (!record(theme) || !only(theme, ['id', 'overrides']) || !SLIDE_THEME_IDS.includes(theme.id as never)) fail('テーマが不正です');
  const overrides = theme.overrides;
  if (overrides === undefined) return;
  if (!record(overrides) || !only(overrides, ['colors', 'fonts'])) fail('テーマの上書きが不正です');
  if (overrides.colors !== undefined && (!record(overrides.colors) || Object.entries(overrides.colors).some(([role, color]) => !SLIDE_COLOR_ROLES.includes(role as never) || !hex6(color)))) fail('テーマの色が不正です');
  if (overrides.fonts !== undefined && (!record(overrides.fonts) || Object.entries(overrides.fonts).some(([role, font]) => !SLIDE_FONT_ROLES.includes(role as never)
    || typeof font !== 'string' || fontById(font)?.group !== 'bundled'))) fail('スライドで使える書体は同梱の書体だけです');
}
function validateScript(script: unknown): Set<string> {
  if (!record(script) || !only(script, ['paragraphs']) || !Array.isArray(script.paragraphs) || script.paragraphs.length > SLIDES_MAX_PARAGRAPHS) fail('台本の形式が不正です');
  const ids = new Set<string>();
  for (const paragraph of script.paragraphs as unknown[]) {
    if (!record(paragraph) || !only(paragraph, ['id', 'text']) || typeof paragraph.id !== 'string' || !PARAGRAPH_ID.test(paragraph.id) || ids.has(paragraph.id)
      || typeof paragraph.text !== 'string' || !paragraph.text || paragraph.text.length > SLIDES_MAX_PARAGRAPH_CHARS) fail('台本の段落が不正です', [record(paragraph) ? String(paragraph.id) : '']);
    ids.add(paragraph.id);
  }
  return ids;
}
function validateAssets(document: SlideDocument): Map<string, SequenceAsset> {
  const ids = new Set<string>();
  for (const asset of document.assets) {
    if (!record(asset) || !id(asset.id) || ids.has(asset.id) || asset.kind !== 'image') fail('スライドの素材が不正です');
    ids.add(asset.id);
  }
  try {
    validateSequenceDocument({ schemaVersion: 2, id: 'slides-assets', name: 'スライドの素材', revision: 0, fps: { num: 30, den: 1 }, resolution: { ...SLIDES_CANVAS },
      sequenceEndFrame: 0, background: '#000000', assets: document.assets, tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } });
  } catch (error) { fail(`スライドの素材が不正です: ${error instanceof Error ? error.message : String(error)}`); }
  return new Map(document.assets.map(asset => [asset.id, asset]));
}
/** 生成の形と構成案の記録。構成案の key の集合を返す（無ければ空）。 */
function validateGenerationShape(document: SlideDocument): Set<string> {
  const raw = document.generation as unknown;
  if (raw === null) return new Set();
  if (!record(raw) || !only(raw, ['runId', 'status', 'confirmed', 'outline', 'glossary', 'pages', 'model']) || typeof raw.runId !== 'string' || !RUN_ID.test(raw.runId)
    || !['outline', 'generating', 'complete', 'cancelled'].includes(String(raw.status)) || typeof raw.confirmed !== 'boolean'
    || (raw.status === 'outline' && raw.confirmed) || ((raw.status === 'generating' || raw.status === 'complete') && !raw.confirmed)
    || (raw.model !== null && (typeof raw.model !== 'string' || raw.model.length > 80))) fail('生成の状態が不正です');
  const issues = outlineStructureIssues(document.script, raw.outline, raw.glossary);
  if (issues.length) fail(`構成案の記録が不正です: ${issues[0]!.path} ${issues[0]!.message}`);
  const generation = raw as unknown as SlideGeneration;
  if (!Array.isArray(generation.pages) || generation.pages.length !== generation.outline.length
    || generation.pages.some((page, index) => !record(page) || page.key !== generation.outline[index]!.key)) fail('生成の状態が構成案と合いません');
  return new Set(generation.outline.map(entry => entry.key));
}
/** 生成の各ページの状態・ページとのつながり・置き換え案。 */
function validateGenerationLinks(document: SlideDocument, assets: Map<string, SequenceAsset>): void {
  const linkedPages = document.pages.filter(page => page.outlineKey !== undefined), linked = new Map(linkedPages.map(page => [page.outlineKey!, page]));
  if (linked.size !== linkedPages.length) fail('同じ構成案の key を持つページが 2 つあります');
  const generation = document.generation;
  if (!generation) return;
  for (const [index, state] of generation.pages.entries()) {
    const raw = state as unknown as Record<string, unknown>, entry = generation.outline[index]!;
    if (!only(raw, ['key', 'status', 'pageId', 'reasons', 'proposal']) || !['pending', 'generated', 'failed', 'cancelled'].includes(String(raw.status))
      || (raw.pageId !== null && typeof raw.pageId !== 'string') || !Array.isArray(raw.reasons) || raw.reasons.length > 10
      || raw.reasons.some(reason => typeof reason !== 'string' || reason.length > 300)) fail('生成の状態が不正です', [entry.key]);
    const page = linked.get(entry.key);
    if (state.pageId === null ? page !== undefined : page?.id !== state.pageId) fail('生成の状態とページが合いません', [entry.key]);
    if (state.proposal === undefined) continue;
    const proposal = state.proposal as unknown;
    if (!record(proposal) || !only(proposal, ['body', 'images']) || !record(proposal.images)) fail('置き換え案が不正です', [entry.key]);
    const issues = storedBodyIssues(proposal.body, entry.key, entry.layout);
    if (issues.length) fail(`置き換え案が不正です: ${issues[0]!.message}`, [entry.key]);
    for (const [slot, assetId] of Object.entries(proposal.images))
      if (!SLIDE_LAYOUTS[entry.layout].imageSlots.includes(slot) || typeof assetId !== 'string' || assets.get(assetId)?.kind !== 'image') fail('置き換え案の画像が不正です', [entry.key]);
  }
}

/** 検証済みの文書の内容（版を除く）。コマンドで「変わったか」を見るのに使う（検証はしない）。 */
export function slideContentKey(document: SlideDocument): string {
  const { revision: _revision, ...content } = document;
  return JSON.stringify(canonicalJson(content));
}
export function slideContentBytes(document: SlideDocument): string {
  validateSlideDocument(document);
  return slideContentKey(document);
}
export function serializeSlides(document: SlideDocument): string {
  validateSlideDocument(document);
  return JSON.stringify(canonicalJson(document)) + '\n';
}
export function parseSlides(text: string): SlideDocument {
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail('スライドのデータを読み取れません'); }
  validateSlideDocument(value);
  return JSON.parse(JSON.stringify(canonicalJson(value))) as SlideDocument;
}
