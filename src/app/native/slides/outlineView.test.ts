import { describe, expect, it } from 'vitest';
import { applySlideCommand } from '../../../core/slides/commands';
import { splitScript } from '../../../core/slides/contract';
import { scriptText } from '../../../core/slides/fixtures';
import { emptySlideDocument } from '../../../core/slides/model';
import { generationCounts, outlineCoverage, outlineRows, paragraphRangeLabel } from './outlineView';

function drafted() {
  const document = emptySlideDocument('slides-v'); document.script = { paragraphs: splitScript(scriptText(6)) };
  return applySlideCommand(document, { type: 'set-outline', runId: 'r1', glossary: [], model: null, outline: [
    { key: 's1', layout: 'cover', title: '表紙', sourceParagraphIds: ['p1', 'p2'] }, { key: 's2', layout: 'points', title: '要点', sourceParagraphIds: ['p3', 'p5', 'p6'] }] });
}
describe('構成案と進み具合の表示', () => {
  it('段落の範囲を短く書く', () => {
    expect([paragraphRangeLabel(['p4', 'p5', 'p6']), paragraphRangeLabel(['p1', 'p3', 'p4']), paragraphRangeLabel(['p2']), paragraphRangeLabel([])]).toEqual(['段落 4〜6', '段落 1・3〜4', '段落 2', '']);
  });
  it('構成案の行・全段落が入っているか・状態ごとの数', () => {
    const document = drafted();
    expect(outlineRows(document).map(row => [row.key, row.layoutName, row.range, row.status])).toEqual([['s1', '表紙', '段落 1〜2', 'pending'], ['s2', '要点', '段落 3・5〜6', 'pending']]);
    expect(outlineCoverage(document)).toEqual({ covered: 5, total: 6 });
    expect(generationCounts(document)).toEqual({ pending: 2, generated: 0, failed: 0, cancelled: 0, total: 2 });
  });
});
