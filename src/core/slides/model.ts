import { SequenceError } from '../sequence/errors';
import type { SequenceAsset } from '../sequence/model';
import type { ThumbnailLayer } from '../thumbnail/model';

/** スライドは 16:9・1920×1080 だけ（設計書）。 */
export const SLIDES_CANVAS = { width: 1920, height: 1080 } as const;
/** 上限（設計書）。ページ 120 は実測で上げる。 */
export const SLIDES_MAX_PAGES = 120;
export const SLIDES_MAX_LAYERS = 40;
export const SLIDES_MAX_COMMAND_LEAVES = 50;
export const SLIDES_MAX_PARAGRAPHS = 400;
export const SLIDES_MAX_PARAGRAPH_CHARS = 2000;
export const SLIDES_MAX_SCRIPT_CHARS = 200_000;
export const SLIDES_MAX_NOTES_CHARS = 2000;
/** 本文を 1 回に渡せるページ数（数ページずつ）。 */
export const SLIDES_MAX_PAGES_PER_REQUEST = 8;
/** 修復の試行は 1 ページにつき 2 回まで（最初の 1 回＋修復 2 回で直らなければ失敗として画面に示す）。 */
export const SLIDES_MAX_REPAIRS = 2;

export const SLIDE_LAYOUT_IDS = ['cover', 'chapter', 'points', 'image-text', 'compare', 'steps'] as const;
export type SlideLayoutId = typeof SLIDE_LAYOUT_IDS[number];
export const SLIDE_THEME_IDS = ['forest-gold', 'white-navy'] as const;
export type SlideThemeId = typeof SLIDE_THEME_IDS[number];
/** 色 5 色: 地・面・文字・強調・補助。 */
export const SLIDE_COLOR_ROLES = ['background', 'surface', 'text', 'accent', 'muted'] as const;
export type SlideColorRole = typeof SLIDE_COLOR_ROLES[number];
export const SLIDE_FONT_ROLES = ['heading', 'body'] as const;
export type SlideFontRole = typeof SLIDE_FONT_ROLES[number];

export interface SlideThemeOverrides { colors?: Partial<Record<SlideColorRole, string>>; fonts?: Partial<Record<SlideFontRole, string>> }
/** テーマ ID ＋ 色・書体の上書き（書体は同梱の書体の ID）。 */
export interface SlideThemeChoice { id: SlideThemeId; overrides?: SlideThemeOverrides }
export interface SlideParagraph { id: string; text: string }
export interface SlideScript { paragraphs: SlideParagraph[] }
/** レイヤーとレイアウトの枠・テーマの役割の結び付き。手で色や書体を変えた項目は外れる（テーマを変えても手で決めた色は残る）。 */
export interface SlideLayerBinding { slot?: string; color?: SlideColorRole; font?: SlideFontRole; stroke?: SlideColorRole; fill?: SlideColorRole }
export interface SlidePage {
  id: string; layout: SlideLayoutId; layers: ThumbnailLayer[]; bindings: Record<string, SlideLayerBinding>;
  notes: string; sourceParagraphIds: string[]; origin: 'ai' | 'human'; editedAfterGeneration: boolean;
  /** 生成の構成案の key（生成で作ったページだけ）。 */
  outlineKey?: string;
}
export interface SlidePair { title: string; body: string }
/** レイアウト別の入力型（ページ本文の fields）。 */
export interface SlideFieldsByLayout {
  cover: { title: string; subtitle?: string };
  chapter: { number: string; title: string };
  points: { heading: string; bullets: string[] };
  'image-text': { heading: string; bullets: string[] };
  compare: { heading: string; left: SlidePair; right: SlidePair };
  steps: { heading: string; steps: string[] };
}
export type SlideFields = SlideFieldsByLayout[SlideLayoutId];
/** file は MCP の経路だけで使う（AI が作った画像の絶対パス）。貼り付けの経路では受け取らない。 */
export interface SlideImageSlotRequest { slot: string; prompt: string; file?: string }
/** ページ本文（harness-slides-page/1）。 */
export interface SlidePageBody { schema: 'harness-slides-page/1'; key: string; layout: SlideLayoutId; fields: SlideFields; notes: string; imageSlots: SlideImageSlotRequest[] }
export interface SlideOutlinePage { key: string; layout: SlideLayoutId; title: string; sourceParagraphIds: string[] }
export interface SlideGlossaryEntry { term: string; note?: string }
/** 構成案（harness-slides-outline/1）。 */
export interface SlideOutline { schema: 'harness-slides-outline/1'; pages: SlideOutlinePage[]; glossary: SlideGlossaryEntry[] }
/** 受け取った本文（置き換え案にもなる）。images は画像枠 → 登録済みの素材 ID。 */
export interface SlideProposal { body: SlidePageBody; images: Record<string, string> }
export type SlideGenerationPageStatus = 'pending' | 'generated' | 'failed' | 'cancelled';
export interface SlideGenerationPage { key: string; status: SlideGenerationPageStatus; pageId: string | null; reasons: string[]; proposal?: SlideProposal }
export type SlideGenerationStatus = 'outline' | 'generating' | 'complete' | 'cancelled';
/** 生成の途中状態。構成案は生成の記録として残す（正本は生成後のページ）。confirmed は人が構成案を確かめて確定したか。 */
export interface SlideGeneration {
  runId: string; status: SlideGenerationStatus; confirmed: boolean; outline: SlideOutlinePage[]; glossary: SlideGlossaryEntry[];
  pages: SlideGenerationPage[]; model: string | null;
}
export interface SlideDocument {
  schemaVersion: 1; id: string; revision: number; canvas: { width: number; height: number }; theme: SlideThemeChoice;
  script: SlideScript; pages: SlidePage[]; assets: SequenceAsset[]; generation: SlideGeneration | null;
}

export function emptySlideDocument(id: string): SlideDocument {
  return { schemaVersion: 1, id, revision: 0, canvas: { ...SLIDES_CANVAS }, theme: { id: 'forest-gold' }, script: { paragraphs: [] }, pages: [], assets: [], generation: null };
}
export function findSlidePage(document: SlideDocument, pageId: string): SlidePage {
  const page = document.pages.find(item => item.id === pageId);
  if (!page) throw new SequenceError('MISSING_TARGET', '対象のページが見つかりません', [pageId]);
  return page;
}
export function findSlideLayer(page: SlidePage, layerId: string): ThumbnailLayer {
  const layer = page.layers.find(item => item.id === layerId);
  if (!layer) throw new SequenceError('MISSING_TARGET', '対象のレイヤーが見つかりません', [layerId]);
  return layer;
}
export function generationPage(document: SlideDocument, key: string): SlideGenerationPage | undefined {
  return document.generation?.pages.find(page => page.key === key);
}
/** 1 から数えるページ番号。 */
export function slidePageNumber(document: SlideDocument, pageId: string): number {
  const index = document.pages.findIndex(page => page.id === pageId);
  if (index < 0) throw new SequenceError('MISSING_TARGET', '対象のページが見つかりません', [pageId]);
  return index + 1;
}
