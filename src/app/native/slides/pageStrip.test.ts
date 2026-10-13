import { describe, expect, it } from 'vitest';
import { slidesFixture } from '../../../core/slides/fixtures';
import { pageBody } from '../../../core/slides/fixtures';
import { pageStripItems } from './pageStrip';

describe('ページの帯の中身', () => {
  it('番号・レイアウト名・題と、AI・手直し・置き換え案・本文待ち・失敗の印', () => {
    const document = slidesFixture();
    document.generation = { runId: 'r1', status: 'generating', confirmed: true, glossary: [], model: null,
      outline: [{ key: 's1', layout: 'cover', title: '表紙', sourceParagraphIds: ['p1'] }, { key: 's2', layout: 'points', title: '要点', sourceParagraphIds: ['p2', 'p3'] }],
      pages: [{ key: 's1', status: 'pending', pageId: 'page-1', reasons: [] }, { key: 's2', status: 'generated', pageId: 'page-2', reasons: [], proposal: { body: pageBody('s2', 'points'), images: {} } }] };
    Object.assign(document.pages[0]!, { origin: 'ai', outlineKey: 's1' });
    Object.assign(document.pages[1]!, { origin: 'ai', outlineKey: 's2', editedAfterGeneration: true });
    expect(pageStripItems(document)).toEqual([
      { pageId: 'page-1', number: 1, layoutName: '表紙', badges: ['ai', 'pending'], title: 'スイングの基本' },
      { pageId: 'page-2', number: 2, layoutName: '要点', badges: ['edited', 'proposal'], title: '握り方のコツ' },
    ]);
  });
  it('人が作ったページには印を付けない', () => {
    expect(pageStripItems(slidesFixture()).map(item => item.badges)).toEqual([[], []]);
  });
});
