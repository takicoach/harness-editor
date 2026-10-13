import { describe, expect, it } from 'vitest';
import { applyThumbnailCommand } from '../../core/thumbnail/commands';
import { IMAGE_ASSET, textLayer, thumbnailFixture, VIDEO_ASSET } from '../../core/thumbnail/fixtures';
import { thumbnailMainPageId, type ThumbnailDocument } from '../../core/thumbnail/model';
import type { ThumbnailAiRequest } from '../../shared/thumbnailAi';
import { buildThumbnailAiCommand, checkThumbnailAiTarget, NEW_PAGE, thumbnailPageFingerprint, ThumbnailAiScopeError } from './aiCommand';

function threePages(): ThumbnailDocument {
  let document = thumbnailFixture();
  for (const [pageId, name] of [['page-b', '案B'], ['page-c', '案C']] as const) document = applyThumbnailCommand(document, { type: 'add-page', pageId, name });
  return document;
}
function requestFor(document: ThumbnailDocument, kind: 'new' | 'edit', targetPageId: string | null): ThumbnailAiRequest {
  const page = targetPageId ? document.pages.find(item => item.id === targetPageId)! : null;
  return { requestId: 'inst-1', route: 'button', projectId: 'p', documentId: document.id, kind, targetPageId, targetPageName: page?.name ?? null,
    targetFingerprint: page ? thumbnailPageFingerprint(page) : null, cutout: 'auto', note: '', phase: 'working',
    frames: [{ frameId: 'f1', assetId: VIDEO_ASSET.id, streamIndex: VIDEO_ASSET.streams.find(s => s.kind === 'video')!.index, fingerprint: VIDEO_ASSET.fingerprint, sourceTime: { num: 1, den: 60 }, file: 'x.jpg' }],
    nextFrame: 2, previews: 0, apply: null, createdAt: 't', updatedAt: 't' };
}
const scopeCode = (run: () => unknown) => { try { run(); } catch (error) { return error instanceof ThumbnailAiScopeError ? error.code : 'OTHER'; } return 'NONE'; };
const text = (id: string) => ({ type: 'add-layer', pageId: NEW_PAGE, layer: { id, content: { kind: 'text', text: '飛ぶ', style: 'double-outline' } } });

describe('buildThumbnailAiCommand: 直す', () => {
  const document = thumbnailFixture(), pageId = document.pages[0]!.id, request = requestFor(document, 'edit', pageId);
  it('対象の案のレイヤー操作・改名・色の組み合わせは通り、1 つのまとめになる', () => {
    const built = buildThumbnailAiCommand({ document, request, videos: [VIDEO_ASSET], newPageId: 'unused', ops: [
      { type: 'add-layer', pageId, layer: { id: 'ai-t1', content: { kind: 'text', text: '直した', style: 'white-red' } } },
      { type: 'rename-page', pageId, name: '直した案' }, { type: 'shift-page-hue', pageId, degrees: 30 }] });
    expect(built.pageId).toBe(pageId);
    expect(built.command.type).toBe('batch');
    const next = applyThumbnailCommand(document, built.command);
    expect(next.pages[0]!.name).toBe('直した案');
    expect(next.pages[0]!.layers.at(-1)).toMatchObject({ id: 'ai-t1', hidden: false, locked: false, content: { kind: 'text', text: '直した' } });
  });
  it.each([
    ['別の案の削除', { type: 'delete-page', pageId: 'page-x' }],
    ['メインの変更', { type: 'set-main-page', pageId: 'page-x' }],
    ['案の追加', { type: 'add-page', pageId: 'page-x', name: '案X' }],
    ['素材の登録', { type: 'register-assets', assets: [IMAGE_ASSET] }],
    ['まとめの入れ子', { type: 'batch', commands: [] }],
    ['別の案のレイヤー', { type: 'add-layer', pageId: 'page-x', layer: textLayer('t9') }],
    ['new を指す', text('t9')],
  ])('%s は OUT_OF_REQUEST', (_name, op) => {
    expect(scopeCode(() => buildThumbnailAiCommand({ document, request, videos: [VIDEO_ASSET], newPageId: 'unused', ops: [op] }))).toBe('OUT_OF_REQUEST');
  });
});

describe('buildThumbnailAiCommand: 新しい案', () => {
  it('案が 1 つの時: サーバが案を追加し、"new" を新しい案の ID に置き換える。名前は自動', () => {
    const document = thumbnailFixture(), built = buildThumbnailAiCommand({ document, request: requestFor(document, 'new', null), videos: [VIDEO_ASSET], newPageId: 'page-new', ops: [text('ai-t1')] });
    const next = applyThumbnailCommand(document, built.command);
    expect(built.pageId).toBe('page-new');
    expect(next.pages.map(page => page.id)).toEqual([document.pages[0]!.id, 'page-new']);
    expect(next.pages[1]!.name).toBe('案B');
    expect(next.pages[1]!.layers[0]!.content).toMatchObject({ kind: 'text', text: '飛ぶ' });
  });
  it('入れ替え: 入れ替える案を消し、同じ位置に新しい案を置く。メインだった時だけ新しい案をメインにする', () => {
    let document = threePages();
    document = applyThumbnailCommand(document, { type: 'set-main-page', pageId: 'page-b' });
    const built = buildThumbnailAiCommand({ document, request: requestFor(document, 'new', 'page-b'), videos: [VIDEO_ASSET], newPageId: 'page-new', ops: [text('ai-t1')] });
    const next = applyThumbnailCommand(document, built.command);
    expect(next.pages.map(page => page.id)).toEqual([document.pages[0]!.id, 'page-new', 'page-c']);
    expect(next.pages[1]!.name).toBe('案B');
    expect(thumbnailMainPageId(next)).toBe('page-new');
    const notMain = buildThumbnailAiCommand({ document, request: requestFor(document, 'new', 'page-c'), videos: [VIDEO_ASSET], newPageId: 'page-new', ops: [text('ai-t1')] });
    expect(thumbnailMainPageId(applyThumbnailCommand(document, notMain.command))).toBe('page-b');
  });
  it.each([
    ['依頼に無い案の削除', { type: 'delete-page', pageId: 'page-c' }],
    ['入れ替える案のレイヤー操作', { type: 'delete-layers', pageId: 'page-b', layerIds: ['x'] }],
    ['案の並べ替え', { type: 'reorder-page', pageId: NEW_PAGE, index: 0 }],
  ])('%s は OUT_OF_REQUEST', (_name, op) => {
    const document = threePages();
    expect(scopeCode(() => buildThumbnailAiCommand({ document, request: requestFor(document, 'new', 'page-b'), videos: [VIDEO_ASSET], newPageId: 'n', ops: [op] }))).toBe('OUT_OF_REQUEST');
  });
});

describe('素材の出どころ', () => {
  // 見本の文書は画像と動画のレイヤーを持つので、素材を外す試験には空の案の文書を使う。
  const document = thumbnailFixture(), request = requestFor(document, 'new', null);
  const bare: ThumbnailDocument = { ...document, assets: [], pages: [{ id: 'page-a', name: '案A', hueShift: 0, layers: [] }] };
  it('コマ ID はコマの記録から元の動画と秒を入れ、動画の素材を登録する', () => {
    const built = buildThumbnailAiCommand({ document: bare, request, videos: [VIDEO_ASSET], newPageId: 'page-new',
      ops: [{ type: 'add-layer', pageId: NEW_PAGE, layer: { id: 'ai-bg', content: { kind: 'video-frame', frameId: 'f1' } } }] });
    const next = applyThumbnailCommand(bare, built.command);
    expect(next.assets.map(asset => asset.id)).toContain(VIDEO_ASSET.id);
    expect(next.pages[1]!.layers[0]!.content).toMatchObject({ kind: 'video-frame', assetId: VIDEO_ASSET.id, sourceTime: { num: 1, den: 60 } });
  });
  it('知らないコマ ID は INVALID_INPUT', () => {
    expect(scopeCode(() => buildThumbnailAiCommand({ document, request, videos: [VIDEO_ASSET], newPageId: 'n',
      ops: [{ type: 'add-layer', pageId: NEW_PAGE, layer: { id: 'x', content: { kind: 'video-frame', frameId: 'f9' } } }] }))).toBe('INVALID_INPUT');
  });
  it('文書に無い画像素材（参考画像など）は OUT_OF_REQUEST', () => {
    expect(scopeCode(() => buildThumbnailAiCommand({ document: bare, request, videos: [VIDEO_ASSET], newPageId: 'n',
      ops: [{ type: 'add-layer', pageId: NEW_PAGE, layer: { id: 'x', content: { kind: 'image', assetId: 'ref-1', role: 'photo' } } }] }))).toBe('OUT_OF_REQUEST');
  });
  it('元の動画の指紋がコマの記録と違えば INVALID_INPUT', () => {
    expect(scopeCode(() => buildThumbnailAiCommand({ document: bare, request, videos: [{ ...VIDEO_ASSET, fingerprint: 'c'.repeat(64) }], newPageId: 'n',
      ops: [{ type: 'add-layer', pageId: NEW_PAGE, layer: { id: 'x', content: { kind: 'video-frame', frameId: 'f1' } } }] }))).toBe('INVALID_INPUT');
  });
  it('操作は 1〜46 件', () => {
    expect(scopeCode(() => buildThumbnailAiCommand({ document, request, videos: [], newPageId: 'n', ops: [] }))).toBe('INVALID_INPUT');
    expect(scopeCode(() => buildThumbnailAiCommand({ document, request, videos: [], newPageId: 'n', ops: Array.from({ length: 47 }, (_v, i) => text(`t${i}`)) }))).toBe('INVALID_INPUT');
  });
});

describe('checkThumbnailAiTarget', () => {
  it('入れ替える案が付いた「新しい案」は、案が 3 つ未満なら TARGET_CHANGED（頼まれていない案を消さない）', () => {
    const three = threePages(), request = requestFor(three, 'new', 'page-b');
    const two = applyThumbnailCommand(three, { type: 'delete-page', pageId: 'page-c' });
    expect(scopeCode(() => checkThumbnailAiTarget(two, request))).toBe('TARGET_CHANGED');
    expect(scopeCode(() => buildThumbnailAiCommand({ document: two, request, videos: [VIDEO_ASSET], newPageId: 'n', ops: [text('ai-t1')] }))).toBe('TARGET_CHANGED');
  });
  it('対象の案の中身が依頼の後に変わったら TARGET_CHANGED、消えても TARGET_CHANGED', () => {
    const document = threePages(), request = requestFor(document, 'new', 'page-b');
    expect(scopeCode(() => checkThumbnailAiTarget(document, request))).toBe('NONE');
    const edited = applyThumbnailCommand(document, { type: 'add-layer', pageId: 'page-b', layer: textLayer('human') });
    expect(scopeCode(() => checkThumbnailAiTarget(edited, request))).toBe('TARGET_CHANGED');
    // 消えた場合: 案の数が 3 つのままでも（別の案が足されていても）対象が無いので TARGET_CHANGED。
    const replaced = applyThumbnailCommand(applyThumbnailCommand(document, { type: 'delete-page', pageId: 'page-b' }), { type: 'add-page', pageId: 'page-d', name: '案D' });
    expect(replaced.pages).toHaveLength(3);
    expect(scopeCode(() => checkThumbnailAiTarget(replaced, request))).toBe('TARGET_CHANGED');
    expect(scopeCode(() => checkThumbnailAiTarget(applyThumbnailCommand(document, { type: 'delete-page', pageId: 'page-b' }), request))).toBe('TARGET_CHANGED');
  });
  it('ほかの案だけが変わっても通る', () => {
    const document = threePages(), request = requestFor(document, 'new', 'page-b');
    expect(scopeCode(() => checkThumbnailAiTarget(applyThumbnailCommand(document, { type: 'add-layer', pageId: 'page-c', layer: textLayer('h') }), request))).toBe('NONE');
  });
  it('入れ替えなしの新しい案で、依頼の後に案が 3 つになったら PAGE_LIMIT', () => {
    const document = thumbnailFixture(), request = requestFor(document, 'new', null);
    expect(scopeCode(() => checkThumbnailAiTarget(threePages(), request))).toBe('PAGE_LIMIT');
  });
});
