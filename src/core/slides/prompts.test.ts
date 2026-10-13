import { describe, expect, it } from 'vitest';
import { applySlideCommand } from './commands';
import { splitScript, SLIDES_OUTLINE_SCHEMA, validatePageBodies } from './contract';
import { scriptText } from './fixtures';
import { emptySlideDocument, SLIDE_LAYOUT_IDS, type SlideDocument } from './model';
import { nextPendingKeys, outlineRequestText, pagesRequestText } from './prompts';

function withScript(count: number): SlideDocument { const document = emptySlideDocument('slides-p'); document.script = { paragraphs: splitScript(scriptText(count)) }; return document; }
function confirmedDocument(count = 9): SlideDocument {
  const outline = Array.from({ length: count / 3 }, (_, index) => ({ key: `s${index + 1}`, layout: SLIDE_LAYOUT_IDS[index % 6]!, title: `ページ ${index + 1}`,
    sourceParagraphIds: [1, 2, 3].map(n => `p${index * 3 + n}`) }));
  const drafted = applySlideCommand(withScript(count), { type: 'set-outline', runId: 'r1', outline, glossary: [{ term: 'グリップ', note: 'カタカナで書く' }], model: null });
  return applySlideCommand(drafted, { type: 'confirm-outline' });
}

describe('依頼文（貼り付けの経路）', () => {
  it('構成案の依頼文に、段落・スキーマ・レイアウトの入力型と上限・守ることが入る', () => {
    const document = withScript(5), text = outlineRequestText(document);
    expect(text).toContain(`"schema":"${SLIDES_OUTLINE_SCHEMA}"`);
    for (const paragraph of document.script.paragraphs) expect(text).toContain(`${paragraph.id}: ${paragraph.text}`);
    expect(text).toContain('"bullets": 文字の配列（箇条書き・3〜5 件・各 30 文字まで）');
    expect(text).toContain('抜けも重複もなし');
    expect(text).toContain('JSON だけ');
  });
  it('本文の依頼文は、頼むページの段落だけと全体の構成・用語表を入れる。例の JSON はそのまま検証を通る', () => {
    const document = confirmedDocument(), text = pagesRequestText(document, ['s2']);
    expect(text).toContain('「s2」');
    expect(text).toContain('p4: ');
    expect(text).not.toContain('p1: ');
    expect(text).toContain('s1 cover「ページ 1」段落 p1・p2・p3');
    expect(text).toContain('グリップ（カタカナで書く）');
    const example = JSON.parse(text.split('\n').find(line => line.startsWith('{"schema":"harness-slides-page/1"'))!);
    expect(validatePageBodies(document, [example], { regenerate: false }).pages[0]!.issues).toEqual([]);
  });
  it('短くする・作り直しの依頼はその旨を書く。続きは待ち・失敗のページから 6 つ', () => {
    const document = confirmedDocument(30);
    expect(pagesRequestText(document, ['s3'], { shorten: true })).toContain('枠に収まっていません');
    expect(pagesRequestText(document, ['s3'], { regenerate: true })).toContain('作り直し');
    expect(nextPendingKeys(document)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
  });
  it('台本が無い・構成案が未確定なら依頼文を作らない', () => {
    expect(() => outlineRequestText(emptySlideDocument('x'))).toThrow('台本がありません');
    expect(() => pagesRequestText(withScript(3), ['s1'])).toThrow('構成案が確定していません');
  });
});
