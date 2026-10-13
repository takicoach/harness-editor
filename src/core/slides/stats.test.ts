import { describe, expect, it } from 'vitest';
import { slidePage, slidesFixture, validFields } from './fixtures';
import { slidesStats } from './stats';

describe('受け入れの数え方', () => {
  it('どのページにも入っていない段落・収まらないページ・手直しのページを数える', () => {
    const document = slidesFixture();
    document.pages.push(slidePage(document, 'page-3', 'compare', { ...validFields('compare'), left: { title: '良い例', body: 'あ'.repeat(400) } },
      { sourceParagraphIds: ['p3'], editedAfterGeneration: true, origin: 'ai' }));
    expect(slidesStats(document)).toEqual({ pages: 3, paragraphs: 3, missingParagraphs: ['p1'], overflowPages: [3], smallPages: [], editedPages: 1, aiPages: 1, failedKeys: [], waitingKeys: [] });
  });
});
