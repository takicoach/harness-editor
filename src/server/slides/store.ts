import type { SlideDocument } from '../../core/slides/model';
import { parseSlides, serializeSlides, slideContentBytes } from '../../core/slides/validate';
import { DesignDocumentStore, type DesignStoreFormat } from '../design/documentStore';

export const SLIDES_FILE = 'slides.v1.json';
export const SLIDES_FORMAT: DesignStoreFormat<SlideDocument> = {
  format: 'harness-slides', fileBase: 'slides.v1', lockFile: 'slides.save.lock', label: 'スライド',
  parse: parseSlides, serialize: serializeSlides, contentBytes: slideContentBytes,
};
/** スライドの保存（<スライド>/.harness/slides.v1.json）。 */
export class SlidesStore extends DesignDocumentStore<SlideDocument> {
  constructor(projectDirectory: string) { super(projectDirectory, SLIDES_FORMAT); }
}
