import { describe, expect, it } from 'vitest';
import { extractFields } from './build';
import { applySlideCommand, type SlideCommand } from './commands';
import { splitScript, validatePageBodies } from './contract';
import { pageBody, scriptText } from './fixtures';
import { emptySlideDocument, SLIDE_LAYOUT_IDS, type SlideDocument, type SlideOutlinePage } from './model';

const run = (document: SlideDocument, command: SlideCommand) => applySlideCommand(document, command);
function withScript(count: number): SlideDocument {
  const document = emptySlideDocument('slides-gen'); document.script = { paragraphs: splitScript(scriptText(count)) }; return document;
}
function outlineOf(count: number, perPage: number): SlideOutlinePage[] {
  return Array.from({ length: Math.ceil(count / perPage) }, (_, index) => ({ key: `s${index + 1}`, layout: SLIDE_LAYOUT_IDS[index % 6]!, title: `ページ ${index + 1}`,
    sourceParagraphIds: Array.from({ length: perPage }, (_, n) => index * perPage + n + 1).filter(n => n <= count).map(n => `p${n}`) }));
}
const outlineCommand = (outline: SlideOutlinePage[], runId = 'r1'): SlideCommand => ({ type: 'set-outline', runId, outline, glossary: [{ term: 'グリップ' }], model: 'test-model' });
const bodiesCommand = (keys: readonly string[], document: SlideDocument, runId = 'r1'): Extract<SlideCommand, { type: 'apply-page-bodies' }> => ({
  type: 'apply-page-bodies', runId, failures: [], model: null,
  bodies: keys.map(key => ({ body: pageBody(key, document.generation!.outline.find(entry => entry.key === key)!.layout), images: {} })) });
const confirmed = (count = 9, perPage = 3) => run(run(withScript(count), outlineCommand(outlineOf(count, perPage))), { type: 'confirm-outline' });

describe('構成案の確認', () => {
  it('構成案を受け取ると「確認中」。並べ替え・削除（段落は隣へ移す）・レイアウト変更ができる', () => {
    let document = run(withScript(9), outlineCommand(outlineOf(9, 3)));
    expect(document.generation).toMatchObject({ status: 'outline', confirmed: false, model: 'test-model' });
    expect(document.generation!.pages.map(page => page.status)).toEqual(['pending', 'pending', 'pending']);
    document = run(document, { type: 'move-outline-page', key: 's3', index: 0 });
    expect(document.generation!.outline.map(entry => entry.key)).toEqual(['s3', 's1', 's2']);
    document = run(document, { type: 'remove-outline-page', key: 's1' });
    expect(document.generation!.outline.map(entry => [entry.key, entry.sourceParagraphIds])).toEqual([['s3', ['p7', 'p8', 'p9', 'p1', 'p2', 'p3']], ['s2', ['p4', 'p5', 'p6']]]);
    document = run(document, { type: 'set-outline-layout', key: 's2', layout: 'compare' });
    expect(document.generation!.outline[1]!.layout).toBe('compare');
    expect(document.pages).toEqual([]);
  });
  it('確定すると、構成案の順に「本文待ち」のページ（題だけ）ができる。確定後は構成案を直せない', () => {
    const document = confirmed();
    expect(document.generation).toMatchObject({ status: 'generating', confirmed: true });
    expect(document.pages.map(page => [page.id, page.layout, page.origin, page.outlineKey, page.sourceParagraphIds.length]))
      .toEqual([['pg-r1-s1', 'cover', 'ai', 's1', 3], ['pg-r1-s2', 'chapter', 'ai', 's2', 3], ['pg-r1-s3', 'points', 'ai', 's3', 3]]);
    expect(extractFields(document.pages[2]!)).toEqual({ heading: 'ページ 3' });
    expect(() => run(document, { type: 'move-outline-page', key: 's1', index: 1 })).toThrow('構成案を直せるのは、確定する前だけです');
  });
});

describe('本文の適用', () => {
  it('本文で埋めると「生成済み」。全部そろうと完了', () => {
    let document = confirmed();
    document = run(document, bodiesCommand(['s1', 's2'], document));
    expect(document.generation!.pages.map(page => page.status)).toEqual(['generated', 'generated', 'pending']);
    expect(document.pages[1]).toMatchObject({ layout: 'chapter', notes: 's2 のメモ', editedAfterGeneration: false });
    expect(extractFields(document.pages[1]!)).toEqual({ number: '01', title: '握り方' });
    document = run(document, bodiesCommand(['s3'], document));
    expect(document.generation!.status).toBe('complete');
  });
  it('手で直したページは作り直しで上書きせず置き換え案にする。採用した時だけ置き換わる（受け入れ 3）', () => {
    let document = confirmed(); document = run(document, bodiesCommand(['s1', 's2', 's3'], document));
    const page = document.pages[2]!, heading = page.layers.find(layer => page.bindings[layer.id]?.slot === 'heading')!;
    if (heading.content.kind !== 'text') throw new Error('文字ではありません');
    document = run(document, { type: 'update-layer', pageId: page.id, layerId: heading.id, patch: { content: { ...heading.content, text: '手で直した見出し' } } });
    expect(document.pages[2]!.editedAfterGeneration).toBe(true);
    expect(validatePageBodies(document, [pageBody('s3', 'points')], { regenerate: true }).pages[0]!.body).not.toBeNull();
    document = run(document, bodiesCommand(['s3'], document));
    expect(extractFields(document.pages[2]!).heading).toBe('手で直した見出し');
    expect(document.generation!.pages[2]!.proposal?.body.key).toBe('s3');
    const discarded = run(document, { type: 'discard-proposal', pageId: page.id });
    expect([discarded.generation!.pages[2]!.proposal, extractFields(discarded.pages[2]!).heading]).toEqual([undefined, '手で直した見出し']);
    const adopted = run(document, { type: 'adopt-proposal', pageId: page.id });
    expect([extractFields(adopted.pages[2]!).heading, adopted.pages[2]!.editedAfterGeneration, adopted.generation!.pages[2]!.proposal]).toEqual(['握り方のコツ', false, undefined]);
  });
  it('手で消したページを作り直すと、構成案の位置に戻す', () => {
    let document = confirmed(); document = run(document, bodiesCommand(['s1', 's2', 's3'], document));
    document = run(document, { type: 'delete-pages', pageIds: ['pg-r1-s2'] });
    expect(document.generation!.pages[1]!.pageId).toBeNull();
    document = run(document, bodiesCommand(['s2'], document));
    expect(document.pages.map(page => page.outlineKey)).toEqual(['s1', 's2', 's3']);
  });
  it('直らなかったページは「失敗」として理由を残す。成功したページは残す', () => {
    let document = confirmed();
    document = run(document, { ...bodiesCommand(['s1'], document), failures: [{ key: 's2', reasons: ['[0].fields.title: 章名がありません'] }] });
    expect(document.generation!.pages.map(page => [page.status, page.reasons])).toEqual([['generated', []], ['failed', ['[0].fields.title: 章名がありません']], ['pending', []]]);
  });
  it('中止すると待ちのページは「中止」。再開すると待ちに戻る。中止中は本文を受け取らない', () => {
    let document = confirmed();
    document = run(document, bodiesCommand(['s1'], document));
    document = run(document, { type: 'cancel-generation', runId: 'r1' });
    expect([document.generation!.status, ...document.generation!.pages.map(page => page.status)]).toEqual(['cancelled', 'generated', 'cancelled', 'cancelled']);
    expect(() => run(document, bodiesCommand(['s2'], document))).toThrow('中止された生成です');
    document = run(document, { type: 'resume-generation', runId: 'r1' });
    expect([document.generation!.status, ...document.generation!.pages.map(page => page.status)]).toEqual(['generating', 'generated', 'pending', 'pending']);
    const draft = run(run(withScript(3), outlineCommand(outlineOf(3, 3))), { type: 'cancel-generation', runId: 'r1' });
    expect(run(draft, { type: 'resume-generation', runId: 'r1' }).generation!.status).toBe('outline');
  });
  it('段落 45・途中で止めて再開しても、ページが二重にならず全段落がどれか 1 ページに入る（受け入れ 2）', () => {
    let document = confirmed(45, 3);
    const keys = document.generation!.outline.map(entry => entry.key);
    document = run(document, bodiesCommand(keys.slice(0, 6), document));
    document = run(run(document, { type: 'cancel-generation', runId: 'r1' }), { type: 'resume-generation', runId: 'r1' });
    const resent = validatePageBodies(document, keys.slice(0, 6).map(key => pageBody(key, document.generation!.outline.find(entry => entry.key === key)!.layout)), { regenerate: false });
    expect(resent.pages.every(page => page.body === null && page.issues.some(issue => issue.code === 'ALREADY_GENERATED'))).toBe(true);
    for (let start = 6; start < keys.length; start += 6) document = run(document, bodiesCommand(keys.slice(start, start + 6), document));
    expect(document.generation!.status).toBe('complete');
    expect(document.pages).toHaveLength(15);
    expect(new Set(document.pages.map(page => page.outlineKey)).size).toBe(15);
    expect(document.pages.flatMap(page => page.sourceParagraphIds).sort()).toEqual(document.script.paragraphs.map(paragraph => paragraph.id).sort());
  });
  it('別の生成への本文は断る', () => {
    const document = confirmed();
    expect(() => run(document, bodiesCommand(['s1'], document, 'r2'))).toThrow('別の生成への本文です');
  });
});
