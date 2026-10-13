import { resolveFontByValue } from '../fonts';
import { SequenceError } from '../sequence/errors';
import type { SequenceAsset } from '../sequence/model';
import { HEX_COLOR, invalidShadow, shapeFillIssue, textExtrasIssue } from '../sequence/renderExtras';
import { compareTime, isRational } from '../sequence/time';
import { validateSequenceDocument } from '../sequence/validate';
import { assertPlainJson, canonicalJson } from './json';
import { pageToSequence } from './pageToSequence';
import { THUMBNAIL_CANVASES, THUMBNAIL_MAX_LAYERS, THUMBNAIL_MAX_PAGES, type ThumbnailDocument, type ThumbnailLayer } from './model';

export const THUMBNAIL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// 関数宣言にする（const の矢印関数だと never による型の絞り込みが効かない）。
function fail(message: string, targets: string[] = []): never { throw new SequenceError('INVALID_DOCUMENT', message, targets); }
const id = (value: unknown): value is string => typeof value === 'string' && THUMBNAIL_ID.test(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const num = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const hex = (value: unknown): value is string => typeof value === 'string' && HEX_COLOR.test(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const COLOR_KEYS = ['brightness', 'contrast', 'saturation', 'temperature'] as const;

/** 作成・読み込み・コマンド適用・Undo/Redo・保存のすべてで呼ぶ。 */
export function validateThumbnailDocument(value: unknown): asserts value is ThumbnailDocument {
  assertPlainJson(value);
  if (!record(value) || !only(value, ['schemaVersion', 'id', 'revision', 'canvas', 'pages', 'assets', 'mainPageId']) || value.schemaVersion !== 1 || !id(value.id)) fail('サムネのデータ形式が不正です');
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) fail('サムネの版が不正です');
  const canvas = value.canvas;
  if (!record(canvas) || !only(canvas, ['width', 'height']) || !THUMBNAIL_CANVASES.some(item => item.width === canvas.width && item.height === canvas.height)) fail('キャンバスの大きさが不正です');
  if (!Array.isArray(value.pages) || !Array.isArray(value.assets)) fail('案または素材の一覧がありません');
  const document = value as unknown as ThumbnailDocument;
  if (document.pages.length < 1 || document.pages.length > THUMBNAIL_MAX_PAGES) fail(`案は 1〜${THUMBNAIL_MAX_PAGES} つです`);
  validateAssets(document);
  const assets = new Map(document.assets.map(asset => [asset.id, asset]));
  const pageIds = new Set<string>(), layerIds = new Set<string>();
  for (const page of document.pages) {
    const raw = page as unknown;
    if (!record(raw) || !only(raw, ['id', 'name', 'hueShift', 'layers']) || !id(raw.id) || !text(raw.name, 40) || !num(raw.hueShift, -180, 180) || !Array.isArray(raw.layers)) fail('案の形式が不正です');
    if (pageIds.has(page.id)) fail('案の ID が重複しています', [page.id]);
    pageIds.add(page.id);
    if (page.layers.length > THUMBNAIL_MAX_LAYERS) fail(`1 つの案に置けるレイヤーは ${THUMBNAIL_MAX_LAYERS} までです`, [page.id]);
    for (const layer of page.layers) {
      validateLayer(layer, assets);
      if (layerIds.has(layer.id)) fail('レイヤーの ID が重複しています', [layer.id]);
      layerIds.add(layer.id);
    }
  }
  if (document.mainPageId !== undefined && (typeof document.mainPageId !== 'string' || !pageIds.has(document.mainPageId))) fail('メインの案が見つかりません', [String(document.mainPageId)]);
  // 描く側（SequenceDocument の検証）でも通ることを確かめる。保存した案が描けない状態を作らない。
  for (const page of document.pages) {
    try { validateSequenceDocument(pageToSequence(document, page.id)); }
    catch (error) { fail(`案「${page.name}」を描画用に変換できません: ${error instanceof Error ? error.message : String(error)}`, [page.id]); }
  }
}
function validateAssets(document: ThumbnailDocument): void {
  const ids = new Set<string>();
  for (const asset of document.assets) {
    if (!record(asset) || !id(asset.id) || ids.has(asset.id) || (asset.kind !== 'image' && asset.kind !== 'media')) fail('サムネの素材が不正です');
    ids.add(asset.id);
  }
  try {
    validateSequenceDocument({ schemaVersion: 2, id: 'thumbnail-assets', name: 'サムネの素材', revision: 0, fps: { num: 30, den: 1 }, resolution: { ...document.canvas },
      sequenceEndFrame: 0, background: '#000000', assets: document.assets, tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } });
  } catch (error) { fail(`サムネの素材が不正です: ${error instanceof Error ? error.message : String(error)}`); }
}
export function validateLayer(layer: ThumbnailLayer, assets: Map<string, SequenceAsset>): void {
  const raw = layer as unknown;
  if (!record(raw) || !only(raw, ['id', 'name', 'hidden', 'locked', 'content', 'visual']) || !id(raw.id) || !text(raw.name, 80)
    || typeof raw.hidden !== 'boolean' || typeof raw.locked !== 'boolean' || !record(raw.content) || !record(raw.visual)) fail('レイヤーの形式が不正です');
  const content = layer.content as unknown as Record<string, unknown>, kind = content.kind;
  if (kind === 'text') {
    if (!only(content, ['kind', 'text', 'appearance']) || !text(content.text, 300) || !record(content.appearance)) fail('文字レイヤーの形式が不正です', [layer.id]);
    const appearance = (layer.content as Extract<ThumbnailLayer['content'], { kind: 'text' }>).appearance;
    if (typeof appearance.fontFamily !== 'string' || resolveFontByValue(appearance.fontFamily)?.group !== 'bundled') fail('サムネで使える書体は同梱の書体だけです', [layer.id]);
    if (!num(appearance.fontSize, 8, 1000) || !Number.isSafeInteger(appearance.fontWeight) || !num(appearance.fontWeight, 100, 900)
      || !hex(appearance.color) || !hex(appearance.strokeColor) || !num(appearance.strokeWidth, 0, 40)
      || (appearance.background !== 'transparent' && !hex(appearance.background))
      || !num(appearance.lineHeight, .5, 5) || !num(appearance.letterSpacing, -100, 100) || !['left', 'center', 'right'].includes(appearance.align)) fail('文字の書式が不正です', [layer.id]);
    const extras = textExtrasIssue(appearance);
    if (extras) fail(extras, [layer.id]);
  } else if (kind === 'image') {
    if (!only(content, ['kind', 'assetId', 'role']) || assets.get(String(content.assetId))?.kind !== 'image' || !['photo', 'element'].includes(String(content.role))) fail('画像レイヤーの素材が不正です', [layer.id]);
  } else if (kind === 'shape') {
    const shape = content.shape;
    if (!only(content, ['kind', 'shape']) || !record(shape) || !only(shape, ['kind', 'width', 'height', 'color', 'strokeWidth', 'cornerRadius', 'fill'])
      || !['rect', 'ellipse', 'arrow', 'line'].includes(String(shape.kind)) || !num(shape.width, 1, 10000) || !num(shape.height, 1, 10000)
      || !hex(shape.color) || !num(shape.strokeWidth, 0, 80) || !num(shape.cornerRadius, 0, 1000)
      || (shape.fill !== null && shapeFillIssue(shape.fill) !== null)) fail('図形レイヤーの形式が不正です', [layer.id]);
  } else if (kind === 'video-frame') {
    if (!only(content, ['kind', 'assetId', 'streamIndex', 'fingerprint', 'sourceTime'])) fail('コマのレイヤーの形式が不正です', [layer.id]);
    const asset = assets.get(String(content.assetId)), stream = asset?.streams.find(item => item.index === content.streamIndex && item.kind === 'video');
    if (asset?.kind !== 'media' || !stream) fail('コマの元の動画が素材にありません', [layer.id]);
    if (content.fingerprint !== asset!.fingerprint) fail('コマの元の動画が一致しません', [layer.id]);
    const time = content.sourceTime;
    if (!isRational(time) || time.num < 0 || compareTime(time, stream!.duration) >= 0) fail('コマの時刻が動画の外です', [layer.id]);
  } else if (kind === 'gradient') {
    if (!only(content, ['kind', 'side', 'amount', 'color']) || !['left', 'right', 'top', 'bottom'].includes(String(content.side))
      || !num(content.amount, 0, 1) || typeof content.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(content.color)) fail('グラデーションの帯が不正です', [layer.id]);
  } else fail('未対応のレイヤーです', [layer.id]);
  validateVisual(layer);
}
function validateVisual(layer: ThumbnailLayer): void {
  const visual = layer.visual as unknown as Record<string, unknown>, kind = layer.content.kind, position = visual.position;
  const limit = kind === 'image' || kind === 'video-frame' || kind === 'gradient' ? 1.5 : 3;
  if (!only(visual, ['position', 'scale', 'rotation', 'opacity', 'color', 'blur', 'edge', 'shadow', 'flipX']) || !record(position) || !only(position, ['x', 'y'])
    || !num(position.x, -limit, limit) || !num(position.y, -limit, limit) || !num(visual.scale, .05, 8) || !num(visual.rotation, -180, 180) || !num(visual.opacity, 0, 1)) fail('レイヤーの配置が不正です', [layer.id]);
  const pictured = kind === 'image' || kind === 'video-frame', color = visual.color, edge = visual.edge;
  if (color !== undefined && (!pictured || !record(color) || !only(color, COLOR_KEYS) || !COLOR_KEYS.every(key => num(color[key], -100, 100)))) fail('色調整が不正です', [layer.id]);
  if (visual.blur !== undefined && (!pictured || !num(visual.blur, 0, 40))) fail('ぼかしが不正です', [layer.id]);
  if (edge !== undefined && (kind !== 'image' || !record(edge) || !only(edge, ['width', 'color']) || !num(edge.width, 0, 40) || !hex(edge.color))) fail('白フチが不正です', [layer.id]);
  if (visual.shadow !== undefined && (kind !== 'image' || invalidShadow(visual.shadow))) fail('画像の影が不正です', [layer.id]);
  if (visual.flipX !== undefined && (kind !== 'image' || typeof visual.flipX !== 'boolean')) fail('左右反転が不正です', [layer.id]);
}

export function thumbnailContentBytes(document: ThumbnailDocument): string {
  validateThumbnailDocument(document);
  const { revision: _revision, ...content } = document;
  return JSON.stringify(canonicalJson(content));
}
export function serializeThumbnail(document: ThumbnailDocument): string {
  validateThumbnailDocument(document);
  return JSON.stringify(canonicalJson(document)) + '\n';
}
export function parseThumbnail(text: string): ThumbnailDocument {
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail('サムネのデータを読み取れません'); }
  validateThumbnailDocument(value);
  return JSON.parse(JSON.stringify(canonicalJson(value))) as ThumbnailDocument;
}
