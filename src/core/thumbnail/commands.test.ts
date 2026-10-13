import { describe, expect, it } from 'vitest';
import { applyThumbnailCommand, countThumbnailLeaves, type ThumbnailCommand } from './commands';
import { rotateHexHue } from './color';
import { textLayer, thumbnailFixture } from './fixtures';
import { nextPageName, thumbnailDuplicatePageNames, thumbnailMainPageId, type ThumbnailDocument } from './model';
import { validateThumbnailDocument } from './validate';
import { ThumbnailSession } from './session';

const apply = (document: ThumbnailDocument, command: ThumbnailCommand) => applyThumbnailCommand(document, command);

describe('サムネのコマンド', () => {
  it('add-layer は末尾（最前面）に足し、版を 1 進める。41 枚目は断る', () => {
    const document = thumbnailFixture(), next = apply(document, { type: 'add-layer', pageId: 'page-a', layer: textLayer('extra') });
    expect(next.revision).toBe(1);
    expect(next.pages[0]!.layers.at(-1)!.id).toBe('extra');
    expect(document.pages[0]!.layers).toHaveLength(5);
    let full = document;
    for (let index = 5; index < 40; index++) full = apply(full, { type: 'add-layer', pageId: 'page-a', layer: textLayer(`l${index}`) });
    expect(() => apply(full, { type: 'add-layer', pageId: 'page-a', layer: textLayer('over') })).toThrow('1 つの案に置けるレイヤーは 40 までです');
  });
  it('update-layer は名前・内容・配置を丸ごと差し替える。種類は変えられない', () => {
    const document = thumbnailFixture(), title = document.pages[0]!.layers.find(layer => layer.id === 'title')!;
    const next = apply(document, { type: 'update-layer', pageId: 'page-a', layerId: 'title', patch: { visual: { ...title.visual, position: { x: .5, y: -.25 } } } });
    expect(next.pages[0]!.layers.find(layer => layer.id === 'title')!.visual.position).toEqual({ x: .5, y: -.25 });
    expect(() => apply(document, { type: 'update-layer', pageId: 'page-a', layerId: 'title', patch: { content: { kind: 'gradient', side: 'left', amount: .5, color: '#000000' } } })).toThrow('レイヤーの種類は変えられません');
  });
  it('削除・並べ替え・表示とロックは指定した案だけに効く', () => {
    let document = apply(thumbnailFixture(), { type: 'add-page', pageId: 'page-b', name: '案B', duplicateOf: 'page-a' });
    const before = JSON.stringify(document.pages[0]);
    const pageB = document.pages[1]!, firstB = pageB.layers[0]!.id;
    document = apply(document, { type: 'set-layer-flags', pageId: 'page-b', layerId: firstB, hidden: true, locked: true });
    document = apply(document, { type: 'reorder-layer', pageId: 'page-b', layerId: firstB, index: 4 });
    document = apply(document, { type: 'delete-layers', pageId: 'page-b', layerIds: [pageB.layers[1]!.id] });
    expect(JSON.stringify(document.pages[0])).toBe(before);
    expect(document.pages[1]!.layers.at(-1)).toMatchObject({ id: firstB, hidden: true, locked: true });
  });
  it('案の複製はレイヤーを新しい ID で写し、1 操作として数える。4 つ目と最後の削除は断る', () => {
    const command: ThumbnailCommand = { type: 'add-page', pageId: 'page-b', name: '案B', duplicateOf: 'page-a' };
    expect(countThumbnailLeaves(command)).toBe(1);
    const document = apply(thumbnailFixture(), command), ids = document.pages.flatMap(page => page.layers.map(layer => layer.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(document.pages[1]!.layers.map(layer => layer.content)).toEqual(document.pages[0]!.layers.map(layer => layer.content));
    const three = apply(document, { type: 'add-page', pageId: 'page-c', name: '案C' });
    expect(() => apply(three, { type: 'add-page', pageId: 'page-d', name: '案D' })).toThrow('案は 3 つまでです');
    expect(() => apply(thumbnailFixture(), { type: 'delete-page', pageId: 'page-a' })).toThrow('最後の案は削除できません');
  });
  it('案の並べ替え・改名は ID を変えない', () => {
    let document = apply(thumbnailFixture(), { type: 'add-page', pageId: 'page-b', name: '案B' });
    document = apply(document, { type: 'reorder-page', pageId: 'page-b', index: 0 });
    document = apply(document, { type: 'rename-page', pageId: 'page-a', name: 'ためし' });
    expect(document.pages.map(page => [page.id, page.name])).toEqual([['page-b', '案B'], ['page-a', 'ためし']]);
  });
  it('色の組み合わせは文字と図形の色だけを回し、写真・帯の暗さは回さない', () => {
    const document = thumbnailFixture(), next = apply(document, { type: 'shift-page-hue', pageId: 'page-a', degrees: 120 });
    const title = next.pages[0]!.layers.find(layer => layer.id === 'title')!, box = next.pages[0]!.layers.find(layer => layer.id === 'box')!;
    expect(title.content.kind === 'text' && title.content.appearance.color).toBe('#ffffff');
    expect(box.content.kind === 'shape' && box.content.shape.color).toBe(rotateHexHue('#ff3b30', 120));
    expect(next.pages[0]!.layers.find(layer => layer.id === 'shade')!.content).toEqual(document.pages[0]!.layers.find(layer => layer.id === 'shade')!.content);
    expect(next.pages[0]!.hueShift).toBe(120);
    expect(countThumbnailLeaves({ type: 'shift-page-hue', pageId: 'page-a', degrees: 30 })).toBe(1);
  });
  it('1 回の要求は 50 操作まで', () => {
    const toggles = (count: number): ThumbnailCommand => ({ type: 'batch', commands: Array.from({ length: count }, (_, index) => ({ type: 'set-layer-flags' as const, pageId: 'page-a', layerId: 'title', hidden: index % 2 === 0 })) });
    expect(() => apply(thumbnailFixture(), toggles(50))).not.toThrow();
    expect(() => apply(thumbnailFixture(), toggles(51))).toThrow('まとめる編集操作が多すぎます');
  });
  it('知らない操作と変化の無い操作', () => {
    const document = thumbnailFixture();
    expect(() => apply(document, { type: 'explode' } as unknown as ThumbnailCommand)).toThrow('未対応の操作です');
    expect(apply(document, { type: 'set-layer-flags', pageId: 'page-a', layerId: 'title', hidden: false })).toBe(document);
  });
  it('色相の回転', () => {
    expect(rotateHexHue('#ff0000', 120)).toBe('#00ff00');
    expect(rotateHexHue('#ff000080', 240)).toBe('#0000ff80');
    expect(rotateHexHue('#808080', 90)).toBe('#808080');
    expect(rotateHexHue('transparent', 90)).toBe('transparent');
  });
});

describe('メインの案', () => {
  const three = () => {
    let document = apply(thumbnailFixture(), { type: 'add-page', pageId: 'page-b', name: '案B' });
    document = apply(document, { type: 'add-page', pageId: 'page-c', name: '案C' });
    return document;
  };
  it('既定は先頭の案', () => {
    const document = three();
    expect(document.mainPageId).toBeUndefined();
    expect(thumbnailMainPageId(document)).toBe('page-a');
  });
  it('set-main-page で切り替わり、元に戻す 1 回で前のメインへ戻る', () => {
    const session = new ThumbnailSession('s', three());
    const changed = session.execute({ sessionId: 's', expectedRevision: 2, executionId: 'e1', command: { type: 'set-main-page', pageId: 'page-c' } });
    expect(changed.changed).toBe(true);
    expect(thumbnailMainPageId(changed.document)).toBe('page-c');
    const undone = session.execute({ sessionId: 's', expectedRevision: changed.appliedRevision, executionId: 'e2', command: { type: 'undo' } });
    expect(thumbnailMainPageId(undone.document)).toBe('page-a');
  });
  it('メインの案を消すと先頭の案がメインになる', () => {
    let document = apply(three(), { type: 'set-main-page', pageId: 'page-b' });
    document = apply(document, { type: 'delete-page', pageId: 'page-b' });
    expect(document.pages.map(page => page.id)).toEqual(['page-a', 'page-c']);
    expect(thumbnailMainPageId(document)).toBe('page-a');
    const firstDeleted = apply(three(), { type: 'delete-page', pageId: 'page-a' });
    expect(thumbnailMainPageId(firstDeleted)).toBe('page-b');
  });
  it('メインでない案を消してもメインは変わらない', () => {
    const document = apply(apply(three(), { type: 'set-main-page', pageId: 'page-c' }), { type: 'delete-page', pageId: 'page-a' });
    expect(thumbnailMainPageId(document)).toBe('page-c');
  });
  it('並べ替え・先頭への追加ではメインは変わらない（ID で持つ）', () => {
    const reordered = apply(three(), { type: 'reorder-page', pageId: 'page-c', index: 0 });
    expect(reordered.pages[0]!.id).toBe('page-c');
    expect(thumbnailMainPageId(reordered)).toBe('page-a');
    const chosen = apply(apply(three(), { type: 'set-main-page', pageId: 'page-b' }), { type: 'reorder-page', pageId: 'page-b', index: 2 });
    expect(thumbnailMainPageId(chosen)).toBe('page-b');
    const inserted = apply(thumbnailFixture(), { type: 'add-page', pageId: 'page-z', name: '案B', index: 0 });
    expect(thumbnailMainPageId(inserted)).toBe('page-a');
  });
  it('古い文書（メインの指定なし）で同じ位置へ並べ替えても変化なし（元に戻すを積まない）', () => {
    const document = three();
    expect(document.mainPageId).toBeUndefined();
    expect(apply(document, { type: 'reorder-page', pageId: 'page-b', index: 1 })).toBe(document);
    const session = new ThumbnailSession('s', document);
    const receipt = session.execute({ sessionId: 's', expectedRevision: 2, executionId: 'same', command: { type: 'reorder-page', pageId: 'page-a', index: 0 } });
    expect(receipt.changed).toBe(false);
    expect(session.canUndo).toBe(false);
  });
  it('存在しない案は拒否し、文書は変えない', () => {
    const document = three(), before = JSON.stringify(document);
    expect(() => apply(document, { type: 'set-main-page', pageId: 'page-x' })).toThrow('対象の案が見つかりません');
    expect(JSON.stringify(document)).toBe(before);
  });
  it('すでにメインの案を選んでも変化なし（元に戻すを積まない）', () => {
    const document = three();
    expect(apply(document, { type: 'set-main-page', pageId: 'page-a' })).toBe(document);
  });
});

describe('同じ名前の案（書き出しのファイル名と同じ規則で比べる）', () => {
  const two = (nameA: string, nameB: string) => {
    const document = apply(thumbnailFixture(), { type: 'add-page', pageId: 'page-b', name: '仮' });
    document.pages[0]!.name = nameA; document.pages[1]!.name = nameB;
    return document;
  };
  it.each([['案A', '案a'], ['A/B', 'A_B'], ['案B', '案B.'], ['案B', '案B '], ['\u304c', '\u304b\u3099']])('「%s」があると「%s」への改名は断り、文書と元に戻すは変えない', (existing, name) => {
    const session = new ThumbnailSession('s', two(existing, '別'));
    const before = JSON.stringify(session.document);
    expect(() => session.execute({ sessionId: 's', expectedRevision: 1, executionId: 'r', command: { type: 'rename-page', pageId: 'page-b', name } })).toThrow('同じ名前');
    expect(JSON.stringify(session.document)).toBe(before);
    expect(session.canUndo).toBe(false);
  });
  it('追加・複製でも同じ名前は断る。まとめた操作も丸ごと断る', () => {
    const document = two('案A', '案B'), before = JSON.stringify(document);
    expect(() => apply(document, { type: 'add-page', pageId: 'page-c', name: '案a' })).toThrow('同じ名前');
    expect(() => apply(document, { type: 'add-page', pageId: 'page-c', name: '案b.', duplicateOf: 'page-b' })).toThrow('同じ名前');
    expect(() => apply(document, { type: 'batch', commands: [{ type: 'rename-page', pageId: 'page-a', name: '新' }, { type: 'rename-page', pageId: 'page-b', name: '新' }] })).toThrow('同じ名前');
    expect(JSON.stringify(document)).toBe(before);
  });
  it('自分の名前の大文字小文字を変えるのは断らない', () => {
    expect(apply(two('案A', '案B'), { type: 'rename-page', pageId: 'page-a', name: '案a' }).pages[0]!.name).toBe('案a');
  });
  it('すでに重複している古い文書も開け、重複していない名前への改名・追加はできる', () => {
    const old = two('案A', '案a');
    expect(() => validateThumbnailDocument(old)).not.toThrow();
    expect(apply(old, { type: 'rename-page', pageId: 'page-b', name: '案B' }).pages[1]!.name).toBe('案B');
    expect(apply(old, { type: 'add-page', pageId: 'page-c', name: '案C' }).pages).toHaveLength(3);
    expect(thumbnailDuplicatePageNames(old.pages)).toEqual(['案A', '案a']);
    expect(thumbnailDuplicatePageNames(two('案A', '案B').pages)).toEqual([]);
  });
  it('自動で付ける名前は既存の名前と重ならないものを選ぶ', () => {
    expect(nextPageName(two('案a', '案B'))).toBe('案C');
    expect(nextPageName(two('案c', '案b'))).toBe('案A');
    expect(nextPageName(two('案A', '案c.'))).toBe('案B');
  });
});
