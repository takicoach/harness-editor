import { describe, expect, it } from 'vitest';
import { extractFields } from './build';
import { applySlideCommand, type SlideCommand } from './commands';
import { SLIDE_IMAGE_ASSET, slidesFixture } from './fixtures';
import type { SlideDocument } from './model';
import { SLIDE_THEMES } from './themes';

const run = (document: SlideDocument, command: SlideCommand) => applySlideCommand(document, command);
const aiDocument = () => { const document = slidesFixture(); document.pages[1]!.origin = 'ai'; return document; };
const slotLayer = (document: SlideDocument, pageIndex: number, slot: string) => {
  const page = document.pages[pageIndex]!;
  return page.layers.find(layer => page.bindings[layer.id]?.slot === slot)!;
};

describe('ページの操作', () => {
  it('白紙のページを足す・複製する・並べ替える・消す', () => {
    let document = run(slidesFixture(), { type: 'add-page', pageId: 'page-3', layout: 'compare' });
    expect(document.pages.map(page => page.id)).toEqual(['page-1', 'page-2', 'page-3']);
    expect(document.pages[2]).toMatchObject({ layout: 'compare', origin: 'human', editedAfterGeneration: false, notes: '' });
    document = run(document, { type: 'duplicate-page', pageId: 'page-2', newPageId: 'page-2b' });
    const copy = document.pages[2]!;
    expect(copy.id).toBe('page-2b');
    expect(copy.layers.every(layer => layer.id.startsWith('page-2b-'))).toBe(true);
    expect(extractFields(copy)).toEqual(extractFields(document.pages[1]!));
    document = run(document, { type: 'reorder-page', pageId: 'page-3', index: 0 });
    expect(document.pages.map(page => page.id)).toEqual(['page-3', 'page-1', 'page-2', 'page-2b']);
    document = run(document, { type: 'delete-pages', pageIds: ['page-1', 'page-2b'] });
    expect(document.pages.map(page => page.id)).toEqual(['page-3', 'page-2']);
    expect(document.revision).toBe(4);
  });
  it('最後のページも消せる（ページなしの文書）', () => {
    expect(run(slidesFixture(), { type: 'delete-pages', pageIds: ['page-1', 'page-2'] }).pages).toEqual([]);
  });
  it('話すメモを書ける。2000 文字を超えると断る', () => {
    expect(run(slidesFixture(), { type: 'set-notes', pageId: 'page-1', notes: 'ここで自己紹介' }).pages[0]!.notes).toBe('ここで自己紹介');
    expect(() => run(slidesFixture(), { type: 'set-notes', pageId: 'page-1', notes: 'あ'.repeat(2001) })).toThrow('話すメモは 2000 文字までです');
  });
});

describe('手で直したページの印', () => {
  it('AI が作ったページを人が直すと editedAfterGeneration が付く。人のページには付けない', () => {
    const document = aiDocument(), heading = slotLayer(document, 1, 'heading');
    const moved = run(document, { type: 'update-layer', pageId: 'page-2', layerId: heading.id, patch: { visual: { ...heading.visual, position: { x: .1, y: -.7 } } } });
    expect(moved.pages[1]!.editedAfterGeneration).toBe(true);
    expect(run(aiDocument(), { type: 'set-notes', pageId: 'page-2', notes: '手で書いたメモ' }).pages[1]!.editedAfterGeneration).toBe(true);
    expect(run(slidesFixture(), { type: 'set-notes', pageId: 'page-2', notes: 'x' }).pages[1]!.editedAfterGeneration).toBe(false);
  });
  it('まとめ操作に人の編集と別の種類の操作（テーマ）が混ざっても、人の編集が当たったページに印を付ける', () => {
    const document = aiDocument(); document.pages[0]!.origin = 'ai';
    const heading = slotLayer(document, 1, 'heading');
    const after = run(document, { type: 'batch', commands: [
      { type: 'update-layer', pageId: 'page-2', layerId: heading.id, patch: { visual: { ...heading.visual, position: { x: .1, y: -.7 } } } },
      { type: 'set-theme', theme: { id: 'white-navy' } }] });
    expect(after.pages[1]!.editedAfterGeneration).toBe(true);
    // テーマだけが当たったページには付けない。
    expect(after.pages[0]!.editedAfterGeneration).toBe(false);
  });
  it('何も変わらない操作は版を進めず、印も付けない', () => {
    const document = aiDocument(), heading = slotLayer(document, 1, 'heading');
    expect(run(document, { type: 'update-layer', pageId: 'page-2', layerId: heading.id, patch: { visual: heading.visual } })).toBe(document);
  });
});

describe('テーマ（受け入れ 4）', () => {
  it('テーマを変えると色と書体だけが変わり、各レイヤーの位置は変わらない', () => {
    const before = aiDocument(), after = run(before, { type: 'set-theme', theme: { id: 'white-navy' } });
    for (const [pageIndex, page] of after.pages.entries()) for (const [index, layer] of page.layers.entries()) {
      const old = before.pages[pageIndex]!.layers[index]!;
      expect([layer.id, layer.visual]).toEqual([old.id, old.visual]);
      if (layer.content.kind === 'text' && old.content.kind === 'text') expect([layer.content.text, layer.content.appearance.fontSize, layer.content.appearance.box, layer.content.appearance.align])
        .toEqual([old.content.text, old.content.appearance.fontSize, old.content.appearance.box, old.content.appearance.align]);
      if (layer.content.kind === 'shape' && old.content.kind === 'shape') expect([layer.content.shape.width, layer.content.shape.height, layer.content.shape.cornerRadius])
        .toEqual([old.content.shape.width, old.content.shape.height, old.content.shape.cornerRadius]);
    }
    const heading = slotLayer(after, 1, 'heading'), bullets = slotLayer(after, 1, 'bullets');
    expect(heading.content.kind === 'text' && heading.content.appearance.color).toBe(SLIDE_THEMES['white-navy'].colors.text);
    expect(bullets.content.kind === 'text' && bullets.content.appearance.fontFamily).toContain('BIZ UDPGothic');
    expect(after.pages[1]!.editedAfterGeneration).toBe(false);
  });
  it('手で決めた色は、テーマを変えても残る', () => {
    const document = slidesFixture(), heading = slotLayer(document, 1, 'heading');
    if (heading.content.kind !== 'text') throw new Error('文字ではありません');
    const painted = run(document, { type: 'update-layer', pageId: 'page-2', layerId: heading.id,
      patch: { content: { ...heading.content, appearance: { ...heading.content.appearance, color: '#ff0000' } } } });
    expect(painted.pages[1]!.bindings[heading.id]).toEqual({ slot: 'heading', font: 'heading' });
    const after = slotLayer(run(painted, { type: 'set-theme', theme: { id: 'white-navy' } }), 1, 'heading');
    expect(after.content.kind === 'text' && [after.content.appearance.color, after.content.appearance.fontWeight]).toEqual(['#ff0000', 900]);
  });
});

describe('レイアウト・分割・画像枠', () => {
  it('レイアウトを変えても文字と、手で足したレイヤーは残る', () => {
    const document = slidesFixture(), free = { ...slotLayer(document, 0, 'title'), id: 'free-note', name: 'メモ' };
    const changed = run(run(document, { type: 'add-layer', pageId: 'page-2', layer: free }), { type: 'set-layout', pageId: 'page-2', layout: 'steps' });
    expect(extractFields(changed.pages[1]!)).toMatchObject({ heading: '握り方のコツ', steps: ['左手から握る', '親指は少し右', '力は 3 割'] });
    expect(changed.pages[1]!.layers.at(-1)!.id).toBe('free-note');
    expect(changed.pages[1]!.bindings['free-note']).toBeUndefined();
  });
  it('箇条書きを 2 ページに分ける', () => {
    const split = run(slidesFixture(), { type: 'split-page', pageId: 'page-2', newPageId: 'page-2-next' });
    expect(split.pages.map(page => page.id)).toEqual(['page-1', 'page-2', 'page-2-next']);
    expect(extractFields(split.pages[1]!).bullets).toEqual(['左手から握る', '親指は少し右']);
    expect(extractFields(split.pages[2]!)).toEqual({ heading: '握り方のコツ（続き）', bullets: ['力は 3 割'] });
    expect(() => run(slidesFixture(), { type: 'split-page', pageId: 'page-1', newPageId: 'x' })).toThrow('このページは分けられません');
  });
  it('画像枠に画像を入れると、枠の位置と大きさで置き換わる', () => {
    let document = run(slidesFixture(), { type: 'batch', commands: [{ type: 'register-assets', assets: [SLIDE_IMAGE_ASSET] }, { type: 'add-page', pageId: 'page-3', layout: 'image-text' }] });
    const placeholder = slotLayer(document, 2, 'image'), at = document.pages[2]!.layers.indexOf(placeholder);
    document = run(document, { type: 'fill-image-slot', pageId: 'page-3', slot: 'image', assetId: 'img-1' });
    expect(document.pages[2]!.layers[at]).toMatchObject({ id: placeholder.id, content: { kind: 'image', assetId: 'img-1' }, visual: { position: placeholder.visual.position, scale: .4375 } });
    expect(() => run(document, { type: 'fill-image-slot', pageId: 'page-1', slot: 'image', assetId: 'img-1' })).toThrow('このページに画像枠「image」はありません');
  });
});

describe('台本と拒否', () => {
  it('台本を段落に分けて入れる。生成の途中は入れ替えられない', () => {
    const document = run(slidesFixture(), { type: 'set-script', text: '一つ目\n\n二つ目' });
    expect(document.script.paragraphs).toEqual([{ id: 'p1', text: '一つ目' }, { id: 'p2', text: '二つ目' }]);
    expect(document.pages[1]!.sourceParagraphIds).toEqual([]);
    const busy = slidesFixture();
    busy.generation = { runId: 'r1', status: 'generating', confirmed: true, glossary: [], model: null,
      outline: [{ key: 's1', layout: 'points', title: '題', sourceParagraphIds: ['p1', 'p2', 'p3'] }], pages: [{ key: 's1', status: 'pending', pageId: null, reasons: [] }] };
    expect(() => run(busy, { type: 'set-script', text: 'x' })).toThrow('生成の途中は台本を入れ替えられません');
  });
  it('拒否した操作は文書を変えない（上限・知らない操作・壊れた値・ID の重複）', () => {
    const document = slidesFixture(), snapshot = structuredClone(document), heading = slotLayer(document, 1, 'heading');
    const flags = (count: number): SlideCommand => ({ type: 'batch', commands: Array.from({ length: count }, () => ({ type: 'set-layer-flags' as const, pageId: 'page-2', layerId: heading.id, hidden: true })) });
    expect(() => run(document, flags(51))).toThrow('まとめる編集操作が多すぎます');
    expect(() => run(document, { type: 'explode' } as never)).toThrow('未対応の操作です');
    expect(() => run(document, { type: 'update-layer', pageId: 'page-2', layerId: heading.id, patch: { visual: { ...heading.visual, opacity: 2 } } })).toThrow('レイヤーの配置が不正です');
    expect(() => run(document, { type: 'add-page', pageId: 'page-1', layout: 'points' })).toThrow('同じページ ID があります');
    expect(document).toEqual(snapshot);
  });
});
