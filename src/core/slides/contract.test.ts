import { describe, expect, it } from 'vitest';
import { SLIDES_MAX_ISSUES, coverageIssues, fieldIssues, graphemeLength, SLIDES_OUTLINE_SCHEMA, splitScript, validateOutline, validatePageBodies } from './contract';
import { pageBody, scriptText, slidesFixture, validFields } from './fixtures';
import { SLIDE_LAYOUT_IDS, type SlideDocument, type SlideOutlinePage } from './model';

const script = { paragraphs: splitScript(scriptText(6)) };
const outline = (pages: SlideOutlinePage[], extra: Record<string, unknown> = {}) => ({ schema: SLIDES_OUTLINE_SCHEMA, pages, glossary: [], ...extra });
const good: SlideOutlinePage[] = [
  { key: 's01', layout: 'cover', title: '表紙', sourceParagraphIds: ['p1'] },
  { key: 's02', layout: 'points', title: '要点', sourceParagraphIds: ['p2', 'p3'] },
  { key: 's03', layout: 'steps', title: '手順', sourceParagraphIds: ['p4', 'p5', 'p6'] },
];
function generating(): SlideDocument {
  const document = slidesFixture();
  document.script = script;
  document.generation = { runId: 'r1', status: 'generating', confirmed: true, outline: good, glossary: [], model: null,
    pages: good.map(entry => ({ key: entry.key, status: 'pending', pageId: null, reasons: [] })) };
  return document;
}
const codes = (issues: ReadonlyArray<{ code: string }>) => issues.map(issue => issue.code);

describe('段落分け', () => {
  it('空行で分けて番号を付ける。空行が無ければ行で分ける', () => {
    expect(splitScript('一つ目\n続き\n\n二つ目\r\n\r\n\r\n三つ目')).toEqual([{ id: 'p1', text: '一つ目\n続き' }, { id: 'p2', text: '二つ目' }, { id: 'p3', text: '三つ目' }]);
    expect(splitScript('行1\n行2\n\n')).toEqual([{ id: 'p1', text: '行1' }, { id: 'p2', text: '行2' }]);
    expect(splitScript('  \n ')).toEqual([]);
  });
  it('段落は 400 まで・1 段落 2000 文字まで', () => {
    expect(splitScript(scriptText(400))).toHaveLength(400);
    expect(() => splitScript(scriptText(401))).toThrow('段落は 400 までです');
    expect(() => splitScript(`短い\n\n${'あ'.repeat(2001)}`)).toThrow('段落 p2 が長すぎます');
  });
  it('文字数は見た目の 1 文字で数える', () => { expect(graphemeLength('👍🏽あa')).toBe(3); });
});

describe('構成案の検証', () => {
  it('正しい構成案を受け入れる', () => {
    const result = validateOutline(script, outline(good, { glossary: [{ term: 'グリップ', note: 'カタカナで書く' }] }));
    expect(result.issues).toEqual([]);
    expect(result.outline?.pages.map(page => page.key)).toEqual(['s01', 's02', 's03']);
  });
  it.each([
    ['版違い', outline(good, { schema: 'harness-slides-outline/2' }), 'SCHEMA_VERSION', 'schema'],
    ['知らないレイアウト', outline([{ ...good[0]!, layout: 'hero' as never }, good[1]!, good[2]!]), 'UNKNOWN_LAYOUT', 'pages[0].layout'],
    ['存在しない段落', outline([good[0]!, { ...good[1]!, sourceParagraphIds: ['p2', 'p3', 'p99'] }, good[2]!]), 'UNKNOWN_PARAGRAPH', 'pages[1].sourceParagraphIds[2]'],
    ['段落の欠落', outline([good[0]!, { ...good[1]!, sourceParagraphIds: ['p2'] }, good[2]!]), 'MISSING', 'pages'],
    ['段落の重複', outline([good[0]!, { ...good[1]!, sourceParagraphIds: ['p2', 'p3', 'p4'] }, good[2]!]), 'DUPLICATE', 'pages'],
    ['key の重複', outline([good[0]!, { ...good[1]!, key: 's01' }, good[2]!]), 'DUPLICATE', 'pages[1].key'],
    ['題の文字数超え', outline([{ ...good[0]!, title: 'あ'.repeat(61) }, good[1]!, good[2]!]), 'TOO_LONG', 'pages[0].title'],
    ['必須項目の欠落', outline([{ key: 's01', layout: 'cover', sourceParagraphIds: ['p1'] } as never, good[1]!, good[2]!]), 'REQUIRED', 'pages[0].title'],
    ['知らない項目', outline(good, { theme: 'dark' }), 'UNKNOWN_FIELD', 'theme'],
  ])('%s は位置と理由を返して拒否する', (_label, payload, code, path) => {
    const result = validateOutline(script, payload);
    expect(result.outline).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code, path }));
    expect(result.issues.every(issue => issue.message.length > 0)).toBe(true);
  });
  it('台本が空なら構成案を受け取らない', () => {
    expect(codes(validateOutline({ paragraphs: [] }, outline(good)).issues)).toEqual(['REQUIRED']);
  });
  it('段落 45 の台本で、全段落がどれか 1 ページだけに入っていることを確かめる', () => {
    const long = { paragraphs: splitScript(scriptText(45)) };
    const pages = Array.from({ length: 15 }, (_, index): SlideOutlinePage => ({ key: `s${index + 1}`, layout: SLIDE_LAYOUT_IDS[index % 6]!, title: `ページ ${index + 1}`,
      sourceParagraphIds: [1, 2, 3].map(n => `p${index * 3 + n}`) }));
    expect(validateOutline(long, outline(pages)).issues).toEqual([]);
    expect(coverageIssues(long, pages.slice(0, 14)).map(issue => issue.message))
      .toEqual(['段落「p43」がどのページにも入っていません', '段落「p44」がどのページにも入っていません', '段落「p45」がどのページにも入っていません']);
  });
});

describe('ページ本文の検証', () => {
  it('正しい本文を受け入れる', () => {
    const result = validatePageBodies(generating(), [pageBody('s02', 'points'), pageBody('s03', 'steps')], { regenerate: false });
    expect(result.requestIssues).toEqual([]);
    expect(result.pages.map(page => [page.key, page.issues.length, !!page.body])).toEqual([['s02', 0, true], ['s03', 0, true]]);
  });
  it.each([
    ['版違い', { ...pageBody('s02', 'points'), schema: 'harness-slides-page/0' }, 'SCHEMA_VERSION', '[0].schema'],
    ['構成案に無い key', pageBody('s99', 'points'), 'UNKNOWN_KEY', '[0].key'],
    ['構成案とレイアウトが違う', pageBody('s02', 'compare'), 'LAYOUT_MISMATCH', '[0].layout'],
    ['知らないレイアウト', { ...pageBody('s02', 'points'), layout: 'hero' }, 'UNKNOWN_LAYOUT', '[0].layout'],
    ['件数違い', pageBody('s02', 'points', { heading: '見出し', bullets: ['一', '二'] }), 'COUNT', '[0].fields.bullets'],
    ['文字数超え', pageBody('s02', 'points', { heading: 'あ'.repeat(25), bullets: ['一', '二', '三'] }), 'TOO_LONG', '[0].fields.heading'],
    ['必須の欠落', pageBody('s02', 'points', { bullets: ['一', '二', '三'] } as never), 'REQUIRED', '[0].fields.heading'],
    ['改行', pageBody('s02', 'points', { heading: '一行目\n二行目', bullets: ['一', '二', '三'] }), 'SHAPE', '[0].fields.heading'],
    ['知らない項目', pageBody('s02', 'points', { heading: '見出し', bullets: ['一', '二', '三'], footer: 'x' } as never), 'UNKNOWN_FIELD', '[0].fields.footer'],
    ['無い画像枠', { ...pageBody('s02', 'points'), imageSlots: [{ slot: 'image', prompt: '写真' }] }, 'IMAGE_SLOT', '[0].imageSlots[0].slot'],
    ['メモの欠落', { ...pageBody('s02', 'points'), notes: undefined }, 'REQUIRED', '[0].notes'],
  ])('%s のページを拒否する（位置と理由）', (_label, body, code, path) => {
    const result = validatePageBodies(generating(), [body], { regenerate: false });
    expect(result.pages[0]!.body).toBeNull();
    expect(result.pages[0]!.issues).toContainEqual(expect.objectContaining({ code, path }));
  });
  it('巨大な入力でも問題の数と文言は上限で止まる', () => {
    const unknown = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`x${i}${'y'.repeat(100)}`, 1]));
    const fields = { heading: '見出し', bullets: Array.from({ length: 20_000 }, () => '点'), ...unknown };
    const body = validatePageBodies(generating(), [{ ...pageBody('s02', 'points'), fields, junk: 1, layout: 'x'.repeat(100_000) }], { regenerate: false }).pages[0]!;
    expect(body.issues.length).toBeLessThanOrEqual(SLIDES_MAX_ISSUES * 2 + 2);
    expect(JSON.stringify(body.issues).length).toBeLessThan(40_000);
    expect(fieldIssues('points', fields, 'fields').length).toBeLessThanOrEqual(SLIDES_MAX_ISSUES + 1);
    const outlineIssues = validateOutline(script, { schema: SLIDES_OUTLINE_SCHEMA, pages: Array.from({ length: 50_000 }, () => ({})), ...unknown }).issues;
    expect(outlineIssues.length).toBeLessThanOrEqual(SLIDES_MAX_ISSUES + 2);
  });
  it('画像枠はレイアウトの枠数まで・同じ枠の重複は拒否する', () => {
    const many = { ...pageBody('s02', 'points'), imageSlots: Array.from({ length: 10_000 }, () => ({ slot: 'image', prompt: '写真' })) };
    expect(codes(validatePageBodies(generating(), [many], { regenerate: false }).pages[0]!.issues)).toEqual(['COUNT']);
    const document = generating(); document.generation!.outline = [...good]; document.generation!.outline[1] = { ...document.generation!.outline[1]!, layout: 'image-text' };
    const twice = { ...pageBody('s02', 'image-text'), imageSlots: [{ slot: 'image', prompt: '一' }, { slot: 'image', prompt: '二' }] };
    expect(validatePageBodies(document, [twice], { regenerate: false }).pages[0]!.issues.map(i => i.code)).toEqual(['DUPLICATE']);
  });
  it('1 回の要求に同じ key が 2 つあれば 2 つ目を拒否する', () => {
    const result = validatePageBodies(generating(), [pageBody('s02', 'points'), pageBody('s02', 'points')], { regenerate: false });
    expect(result.pages.map(page => codes(page.issues))).toEqual([[], ['DUPLICATE']]);
  });
  it('生成済みのページは regenerate を付けた時だけ受け取る（再開しても二重にならない）', () => {
    const document = generating(); document.generation!.pages[1]!.status = 'generated';
    expect(codes(validatePageBodies(document, [pageBody('s02', 'points')], { regenerate: false }).pages[0]!.issues)).toEqual(['ALREADY_GENERATED']);
    expect(validatePageBodies(document, [pageBody('s02', 'points')], { regenerate: true }).pages[0]!.body).not.toBeNull();
  });
  it('要求の形が違えば全体を拒否する（配列でない・多すぎる・構成案が未確定）', () => {
    expect(codes(validatePageBodies(generating(), pageBody('s02', 'points'), { regenerate: false }).requestIssues)).toEqual(['SHAPE']);
    expect(codes(validatePageBodies(generating(), Array.from({ length: 9 }, () => pageBody('s02', 'points')), { regenerate: false }).requestIssues)).toEqual(['TOO_MANY']);
    const draft = generating(); draft.generation!.status = 'outline'; draft.generation!.confirmed = false;
    expect(codes(validatePageBodies(draft, [pageBody('s02', 'points')], { regenerate: false }).requestIssues)).toEqual(['RUN_STATE']);
  });
  it('レイアウトごとの入力型を検証する', () => {
    for (const layout of SLIDE_LAYOUT_IDS) expect(fieldIssues(layout, validFields(layout), 'fields')).toEqual([]);
    expect(codes(fieldIssues('compare', { heading: '比較', left: { title: '左' }, right: { title: '右', body: '本文', extra: 1 } }, 'fields'))).toEqual(['REQUIRED', 'UNKNOWN_FIELD']);
  });
});
