import type { ColorGrade } from '../colorGrade';
import { SequenceError } from '../sequence/errors';
import type { SequenceAsset, ShapeFill, TextAppearance, VisualShadow } from '../sequence/model';
import type { Rational } from '../sequence/time';

export const THUMBNAIL_MAX_PAGES = 3;
export const THUMBNAIL_MAX_LAYERS = 40;
export const THUMBNAIL_MAX_COMMAND_LEAVES = 50;
export const THUMBNAIL_CANVASES = [
  { format: 'landscape', width: 1280, height: 720 },
  { format: 'portrait', width: 1080, height: 1920 },
  { format: 'square', width: 1080, height: 1080 },
] as const;
export const PAGE_NAMES = ['案A', '案B', '案C'] as const;

export interface ThumbnailCanvas { width: number; height: number }
/** 写真の色調整（-100..100）。ホイールは使わない。 */
export type ThumbnailColorAdjust = Omit<ColorGrade, 'wheels'>;
/** 位置は中心原点の正規化（±1 でキャンバスの端）。scale・rotation・opacity は既存 ClipVisual と同じ意味。 */
export interface ThumbnailVisual {
  position: { x: number; y: number }; scale: number; rotation: number; opacity: number;
  color?: ThumbnailColorAdjust; blur?: number; edge?: { width: number; color: string }; shadow?: VisualShadow; flipX?: boolean;
}
export type ThumbnailShapeKind = 'rect' | 'ellipse' | 'arrow' | 'line';
/** 図形は自分の箱（px）で持ち、位置・回転・拡大は visual で動かす。矢印と線は箱の中央を左から右へ引く。 */
export interface ThumbnailShape { kind: ThumbnailShapeKind; width: number; height: number; color: string; strokeWidth: number; cornerRadius: number; fill: ShapeFill | null }
export type GradientSide = 'left' | 'right' | 'top' | 'bottom';
export type ThumbnailContent =
  | { kind: 'text'; text: string; appearance: TextAppearance }
  | { kind: 'image'; assetId: string; role: 'photo' | 'element' }
  | { kind: 'shape'; shape: ThumbnailShape }
  /** sourceTime は原本の秒。描画は proxy ではなく原本。 */
  | { kind: 'video-frame'; assetId: string; streamIndex: number; fingerprint: string; sourceTime: Rational }
  /** 文字側を暗くするグラデーションの帯（キャンバス全面）。 */
  | { kind: 'gradient'; side: GradientSide; amount: number; color: string };
export interface ThumbnailLayer { id: string; name: string; hidden: boolean; locked: boolean; content: ThumbnailContent; visual: ThumbnailVisual }
/** layers[0] が最背面。hueShift は「色の組み合わせ」のつまみの現在角度。 */
export interface ThumbnailPage { id: string; name: string; hueShift: number; layers: ThumbnailLayer[] }
/** mainPageId はメインの案（書き出しの名前とプロジェクトのカードの画像に使う）。無ければ先頭の案。 */
export interface ThumbnailDocument { schemaVersion: 1; id: string; revision: number; canvas: ThumbnailCanvas; pages: ThumbnailPage[]; assets: SequenceAsset[]; mainPageId?: string }

export function defaultThumbnailVisual(): ThumbnailVisual {
  return { position: { x: 0, y: 0 }, scale: 1, rotation: 0, opacity: 1 };
}
export function thumbnailCanvasFor(resolution: { width: number; height: number }): ThumbnailCanvas {
  const format = resolution.width > resolution.height ? 'landscape' : resolution.width < resolution.height ? 'portrait' : 'square';
  const canvas = THUMBNAIL_CANVASES.find(item => item.format === format)!;
  return { width: canvas.width, height: canvas.height };
}
export function emptyThumbnailDocument(id: string, canvas: ThumbnailCanvas, pageId: string): ThumbnailDocument {
  return { schemaVersion: 1, id, revision: 0, canvas: { ...canvas }, pages: [{ id: pageId, name: PAGE_NAMES[0], hueShift: 0, layers: [] }], assets: [] };
}
/** メインの案の ID。指定が無い・消えた案を指す時は先頭の案。 */
export function thumbnailMainPageId(document: ThumbnailDocument): string {
  const main = document.mainPageId;
  return main !== undefined && document.pages.some(page => page.id === main) ? main : document.pages[0]!.id;
}
export function findPage(document: ThumbnailDocument, pageId: string): ThumbnailPage {
  const page = document.pages.find(item => item.id === pageId);
  if (!page) throw new SequenceError('MISSING_TARGET', '対象の案が見つかりません', [pageId]);
  return page;
}
export function findLayer(page: ThumbnailPage, layerId: string): ThumbnailLayer {
  const layer = page.layers.find(item => item.id === layerId);
  if (!layer) throw new SequenceError('MISSING_TARGET', '対象のレイヤーが見つかりません', [layerId]);
  return layer;
}
/** ファイル名に使える形へ整える（NFC・禁止文字は _・末尾のドットと空白を除く）。書き出しの名前（server/thumbnail/cover）と案の名前の比べ方で共有する。 */
export function cleanThumbnailFileName(value: string): string {
  return value.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim();
}
/** 案の名前を比べる鍵。書き出すと同じファイル名になる名前（大文字小文字の違いを含む。macOS の既定は区別しない）は同じ鍵になる。 */
export function thumbnailPageNameKey(name: string): string {
  return cleanThumbnailFileName(name).toLowerCase();
}
/** 書き出すと同じファイル名になる案の名前（並び順のまま）。重複が無ければ空。 */
export function thumbnailDuplicatePageNames(pages: readonly ThumbnailPage[]): string[] {
  const counts = new Map<string, number>();
  for (const page of pages) counts.set(thumbnailPageNameKey(page.name), (counts.get(thumbnailPageNameKey(page.name)) ?? 0) + 1);
  return pages.filter(page => counts.get(thumbnailPageNameKey(page.name))! > 1).map(page => page.name);
}
/** 新しい案に自動で付ける名前。既存の名前と（書き出しのファイル名として）重ならないものを選ぶ。 */
export function nextPageName(document: ThumbnailDocument): string {
  const used = new Set(document.pages.map(page => thumbnailPageNameKey(page.name))), free = (name: string) => !used.has(thumbnailPageNameKey(name));
  const preset = PAGE_NAMES.find(free);
  if (preset) return preset;
  let number = document.pages.length + 1;
  while (!free(`案${number}`)) number += 1;
  return `案${number}`;
}
