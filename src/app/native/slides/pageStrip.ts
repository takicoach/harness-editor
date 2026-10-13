import { slidePageTitle } from '../../../core/slides/build';
import { SLIDE_LAYOUTS } from '../../../core/slides/layouts';
import type { SlideDocument } from '../../../core/slides/model';

export type PageBadge = 'ai' | 'edited' | 'proposal' | 'pending' | 'failed';
export interface PageStripItem { pageId: string; number: number; layoutName: string; badges: PageBadge[]; title: string }
export const BADGE_LABELS: Readonly<Record<PageBadge, string>> = { ai: 'AI', edited: '手直し', proposal: '置き換え案', pending: '本文待ち', failed: '失敗' };
/** ページの帯と格子表示に出す中身。印は「AI が作った／手で直した」「置き換え案がある」「本文待ち」「失敗」。 */
export function pageStripItems(document: SlideDocument): PageStripItem[] {
  const states = new Map((document.generation?.pages ?? []).map(state => [state.key, state]));
  return document.pages.map((page, index) => {
    const state = page.outlineKey ? states.get(page.outlineKey) : undefined, badges: PageBadge[] = [];
    if (page.origin === 'ai') badges.push(page.editedAfterGeneration ? 'edited' : 'ai');
    if (state?.proposal) badges.push('proposal');
    if (state?.status === 'pending' || state?.status === 'cancelled') badges.push('pending');
    if (state?.status === 'failed') badges.push('failed');
    return { pageId: page.id, number: index + 1, layoutName: SLIDE_LAYOUTS[page.layout].name, badges, title: slidePageTitle(page) };
  });
}
