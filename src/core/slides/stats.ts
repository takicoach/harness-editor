import { pageFit } from './fit';
import type { SlideDocument } from './model';

export interface SlidesStats {
  pages: number; paragraphs: number; missingParagraphs: string[]; overflowPages: number[]; smallPages: number[];
  editedPages: number; aiPages: number; failedKeys: string[]; waitingKeys: string[];
}
/** 実運用の受け入れで記録する数（欠落・あふれ・手直し・生成の残り）を、保存した文書から数える。ページ番号は 1 始まり。 */
export function slidesStats(document: SlideDocument): SlidesStats {
  const covered = new Set(document.pages.flatMap(page => page.sourceParagraphIds)), fits = document.pages.map(page => pageFit(page).status);
  const numbers = (status: string) => fits.flatMap((value, index) => value === status ? [index + 1] : []);
  return {
    pages: document.pages.length, paragraphs: document.script.paragraphs.length,
    missingParagraphs: document.script.paragraphs.filter(paragraph => !covered.has(paragraph.id)).map(paragraph => paragraph.id),
    overflowPages: numbers('overflow'), smallPages: numbers('small'),
    editedPages: document.pages.filter(page => page.editedAfterGeneration).length, aiPages: document.pages.filter(page => page.origin === 'ai').length,
    failedKeys: document.generation?.pages.filter(page => page.status === 'failed').map(page => page.key) ?? [],
    waitingKeys: document.generation?.pages.filter(page => page.status === 'pending' || page.status === 'cancelled').map(page => page.key) ?? [],
  };
}
