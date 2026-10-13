/** テスト専用の見本。本番コードから import しない。 */
import type { SequenceAsset } from '../sequence/model';
import { buildSlideLayers } from './build';
import type { SlideFieldsInput } from './layouts';
import { emptySlideDocument, type SlideDocument, type SlideFields, type SlideLayoutId, type SlidePage, type SlidePageBody } from './model';
import { resolveSlideTheme } from './themes';

export const SLIDE_IMAGE_ASSET: SequenceAsset = { id: 'img-1', kind: 'image', name: 'photo.png', file: `.harness/assets/${'a'.repeat(64)}.png`, fingerprint: 'a'.repeat(64), streams: [] };
/** レイアウトごとの正しい入力（文字数・件数の上限内）。 */
export function validFields(layout: SlideLayoutId): SlideFields {
  switch (layout) {
    case 'cover': return { title: 'スイングの基本', subtitle: '今日の 3 つの要点' };
    case 'chapter': return { number: '01', title: '握り方' };
    case 'points': return { heading: '握り方のコツ', bullets: ['左手から握る', '親指は少し右', '力は 3 割'] };
    case 'image-text': return { heading: '構えの形', bullets: ['背すじを伸ばす', '膝は軽く曲げる'] };
    case 'compare': return { heading: '良い例と悪い例', left: { title: '良い例', body: '肩の力が抜けている' }, right: { title: '悪い例', body: '腕だけで振っている' } };
    case 'steps': return { heading: '練習の順番', steps: ['素振り', 'ハーフ', 'フル'] };
  }
}
export function pageBody(key: string, layout: SlideLayoutId, fields: SlideFields = validFields(layout), notes = `${key} のメモ`): SlidePageBody {
  return { schema: 'harness-slides-page/1', key, layout, fields, notes, imageSlots: layout === 'image-text' ? [{ slot: 'image', prompt: '構えの写真' }] : [] };
}
export function slidePage(document: SlideDocument, pageId: string, layout: SlideLayoutId, fields: SlideFieldsInput, extra: Partial<SlidePage> = {}): SlidePage {
  const built = buildSlideLayers(layout, fields, resolveSlideTheme(document.theme), slot => `${pageId}-${slot}`);
  return { id: pageId, layout, layers: built.layers, bindings: built.bindings, notes: '', sourceParagraphIds: [], origin: 'human', editedAfterGeneration: false, ...extra };
}
/** 台本 3 段落・ページ 2 枚（表紙・要点）。テーマは深緑×金。 */
export function slidesFixture(): SlideDocument {
  const document = emptySlideDocument('slides-1');
  document.script = { paragraphs: [{ id: 'p1', text: '今日はスイングの基本を話します。' }, { id: 'p2', text: 'グリップは左手から握ります。' }, { id: 'p3', text: '最後に練習方法をまとめます。' }] };
  document.pages = [slidePage(document, 'page-1', 'cover', validFields('cover')), slidePage(document, 'page-2', 'points', validFields('points'), { sourceParagraphIds: ['p2'] })];
  return document;
}
/** 段落 count 個の台本（空行区切り）。 */
export function scriptText(count: number): string {
  return Array.from({ length: count }, (_, index) => `これは段落 ${index + 1} の話です。練習のコツを一つ伝えます。`).join('\n\n');
}
