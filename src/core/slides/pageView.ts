import type { SequenceDocument } from '../sequence/model';
import type { ThumbnailDocument } from '../thumbnail/model';
import { pageToSequence, type PageToSequenceOptions } from '../thumbnail/pageToSequence';
import { findSlidePage, slidePageNumber, type SlideDocument } from './model';

/** サムネの変換関数にそのまま渡せる形。1 ページだけを案 1 つとして見せる（保存も検証もしない、描画と画面の部品の共有用）。 */
export function slidePageAsThumbnail(document: SlideDocument, pageId: string): ThumbnailDocument {
  const page = findSlidePage(document, pageId);
  return { schemaVersion: 1, id: document.id, revision: document.revision, canvas: { ...document.canvas },
    pages: [{ id: page.id, name: String(slidePageNumber(document, pageId)), hueShift: 0, layers: page.layers }], assets: document.assets };
}
/** ページ → 1 コマの SequenceDocument（プレビュー＝書き出し）。 */
export function slidePageToSequence(document: SlideDocument, pageId: string, options: PageToSequenceOptions = {}): SequenceDocument {
  return pageToSequence(slidePageAsThumbnail(document, pageId), pageId, options);
}
