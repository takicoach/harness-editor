/**
 * サムネの AI の書き込みの範囲（設計「依頼の固定」）。AI の操作を確かめ、案の追加・入れ替え・コマの素材の登録はサーバが組み立てる。
 * AI は案の追加・削除・並べ替え・メイン・素材の登録を直接送れない。
 */
import { createHash } from 'node:crypto';
import type { SequenceAsset } from '../../core/sequence/model';
import type { ThumbnailCommand } from '../../core/thumbnail/commands';
import { defaultThumbnailVisual, nextPageName, THUMBNAIL_MAX_PAGES, thumbnailMainPageId, type ThumbnailContent, type ThumbnailDocument, type ThumbnailLayer, type ThumbnailPage } from '../../core/thumbnail/model';
import { THUMBNAIL_TEXT_STYLES, thumbnailTextAppearance } from '../../core/thumbnail/textStyles';
import { THUMBNAIL_AI_MAX_OPS, type ThumbnailAiRequest } from '../../shared/thumbnailAi';
import { stableJson } from '../agentHandoff';

export const NEW_PAGE = 'new';
const READER = 'thumbnail_read';
export type ThumbnailAiScopeCode = 'OUT_OF_REQUEST' | 'INVALID_INPUT' | 'TARGET_CHANGED' | 'PAGE_LIMIT';
export class ThumbnailAiScopeError extends Error {
  constructor(readonly code: ThumbnailAiScopeCode, message: string, readonly recovery: string) { super(message); this.name = 'ThumbnailAiScopeError'; }
}
const AI_OPS = ['add-layer', 'update-layer', 'delete-layers', 'reorder-layer', 'set-layer-flags', 'rename-page', 'shift-page-hue'] as const;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = (message: string, recovery = `${READER} で今の案と依頼を読み直し、editor_guide('thumbnail') の操作の形に合わせて送ってください`) =>
  new ThumbnailAiScopeError('INVALID_INPUT', message, recovery);
function outOfRequest(request: ThumbnailAiRequest, what: string): ThumbnailAiScopeError {
  const scope = request.kind === 'edit' ? `「${request.targetPageName}」の中のレイヤーと、その案の名前・色の組み合わせ` : '新しい案（pageId は "new"）の中のレイヤーと、その案の名前・色の組み合わせ';
  return new ThumbnailAiScopeError('OUT_OF_REQUEST', `この依頼では${what}はできません。変えられるのは${scope}だけです`,
    '範囲の外を変えたい時は、利用者に確かめてから、新しい依頼として頼んでもらってください');
}
/** 案の中身の指紋（名前・色の組み合わせ・レイヤー）。鍵の順に依らない。 */
export function thumbnailPageFingerprint(page: ThumbnailPage): string {
  return createHash('sha256').update(stableJson(page, READER, (_code, message) => new Error(message))).digest('hex');
}
/** 入れ替えは案が上限の時だけ。それ未満で入れ替える案が付いた依頼は、頼まれていない案を消すので受け付けない（依頼の後に人が案を消した時も同じ）。 */
function checkReplaceAllowed(document: ThumbnailDocument, request: ThumbnailAiRequest): void {
  if (request.kind === 'new' && request.targetPageId !== null && document.pages.length < THUMBNAIL_MAX_PAGES) throw new ThumbnailAiScopeError('TARGET_CHANGED',
    `案が ${THUMBNAIL_MAX_PAGES} つ未満（今は ${document.pages.length} つ）なので、「${request.targetPageName}」との入れ替えはできません`,
    '利用者に確かめてください。入れ替えずに新しい案を作る時は、利用者に新しい依頼として頼み直してもらってください');
}
/** 依頼の後に人が対象の案を変えていないか。入れ替えの同意も、案が変わったら無効。 */
export function checkThumbnailAiTarget(document: ThumbnailDocument, request: ThumbnailAiRequest): void {
  checkReplaceAllowed(document, request);
  if (request.targetPageId !== null) {
    const page = document.pages.find(item => item.id === request.targetPageId);
    if (!page || thumbnailPageFingerprint(page) !== request.targetFingerprint) throw new ThumbnailAiScopeError('TARGET_CHANGED',
      `依頼の後に「${request.targetPageName}」が変わったか、消されました`, '利用者に、このまま続けるか確かめてください。続ける時は、利用者に頼み直してもらってください');
  } else if (request.kind === 'new' && document.pages.length >= THUMBNAIL_MAX_PAGES) {
    throw new ThumbnailAiScopeError('PAGE_LIMIT', `案が ${THUMBNAIL_MAX_PAGES} つになりました`, '入れ替える案を利用者に聞いてから、新しい依頼として頼み直してもらってください');
  }
}
/** AI の書いた中身を文書の形にする。コマ ID とスタイル名はここで解決する。 */
function resolveContent(value: unknown, input: { document: ThumbnailDocument; request: ThumbnailAiRequest; videos: readonly SequenceAsset[] }, register: Map<string, SequenceAsset>): ThumbnailContent {
  if (!record(value)) throw invalid('レイヤーの中身（content）の形が不正です');
  if (value.kind === 'text' && value.appearance === undefined) {
    const style = value.style === undefined ? THUMBNAIL_TEXT_STYLES[0]! : THUMBNAIL_TEXT_STYLES.find(item => item.id === value.style);
    if (!style) throw invalid(`文字のスタイルが不明です（${THUMBNAIL_TEXT_STYLES.map(item => item.id).join('・')} のどれか）`);
    const fontSize = typeof value.fontSize === 'number' && Number.isFinite(value.fontSize) ? value.fontSize : undefined;
    return { kind: 'text', text: String(value.text ?? ''), appearance: style.apply(thumbnailTextAppearance(fontSize)) };
  }
  if (value.kind === 'video-frame' && typeof value.frameId === 'string') {
    const frame = input.request.frames.find(item => item.frameId === value.frameId);
    if (!frame) throw invalid(`コマ ID「${value.frameId}」が見つかりません`, 'thumbnail_frames でコマを撮り直し、返ってきた frameId を使ってください');
    const asset = input.document.assets.find(item => item.id === frame.assetId) ?? input.videos.find(item => item.id === frame.assetId);
    if (!asset || asset.fingerprint !== frame.fingerprint) throw invalid('コマの元の動画が見つからないか、中身が変わっています', 'thumbnail_read で使える動画を確かめ、thumbnail_frames で撮り直してください');
    if (!input.document.assets.some(item => item.id === asset.id)) register.set(asset.id, asset);
    return { kind: 'video-frame', assetId: asset.id, streamIndex: frame.streamIndex, fingerprint: asset.fingerprint, sourceTime: { ...frame.sourceTime } };
  }
  if (value.kind === 'image' && !input.document.assets.some(item => item.id === value.assetId && item.kind === 'image'))
    throw outOfRequest(input.request, '文書に無い画像（参考の画像など）を置くこと');
  if (value.kind === 'video-frame' && !input.document.assets.some(item => item.id === value.assetId))
    throw outOfRequest(input.request, 'コマ ID を使わずに文書に無い動画を置くこと');
  return value as unknown as ThumbnailContent;
}
function resolveLayer(value: unknown, input: Parameters<typeof resolveContent>[1], register: Map<string, SequenceAsset>): ThumbnailLayer {
  if (!record(value) || typeof value.id !== 'string' || !value.id) throw invalid('追加するレイヤーには id が必要です');
  const content = resolveContent(value.content, input, register);
  const name = typeof value.name === 'string' && value.name ? value.name : content.kind === 'text' ? content.text.replace(/\s+/g, ' ').trim().slice(0, 80) || '文字' : 'AI のレイヤー';
  return { id: value.id, name, hidden: value.hidden === true, locked: value.locked === true,
    visual: record(value.visual) ? { ...defaultThumbnailVisual(), ...(value.visual as object) } as ThumbnailLayer['visual'] : defaultThumbnailVisual(), content };
}
export function buildThumbnailAiCommand(input: { document: ThumbnailDocument; request: ThumbnailAiRequest; ops: unknown; videos: readonly SequenceAsset[]; newPageId: string }): { command: ThumbnailCommand; pageId: string } {
  const { document, request } = input;
  checkReplaceAllowed(document, request);
  if (!Array.isArray(input.ops) || input.ops.length < 1 || input.ops.length > THUMBNAIL_AI_MAX_OPS) throw invalid(`操作（ops）は 1〜${THUMBNAIL_AI_MAX_OPS} 件の配列にしてください`);
  const expected = request.kind === 'edit' ? request.targetPageId! : NEW_PAGE, pageId = request.kind === 'edit' ? expected : input.newPageId;
  const register = new Map<string, SequenceAsset>(), mapped: ThumbnailCommand[] = [];
  for (const op of input.ops) {
    if (!record(op) || typeof op.type !== 'string') throw invalid('操作の形が不正です（type が必要です）');
    if (!(AI_OPS as readonly string[]).includes(op.type)) throw outOfRequest(request, `「${op.type}」`);
    if (op.pageId !== expected) throw outOfRequest(request, `別の案（${String(op.pageId)}）への操作`);
    const next: Record<string, unknown> = { ...op, pageId };
    if (op.type === 'add-layer') next.layer = resolveLayer(op.layer, input, register);
    if (op.type === 'update-layer' && record(op.patch) && op.patch.content !== undefined) next.patch = { ...op.patch, content: resolveContent(op.patch.content, input, register) };
    mapped.push(next as unknown as ThumbnailCommand);
  }
  const commands: ThumbnailCommand[] = [];
  if (register.size) commands.push({ type: 'register-assets', assets: [...register.values()].map(asset => structuredClone(asset)) });
  if (request.kind === 'new') {
    const target = request.targetPageId, index = target ? document.pages.findIndex(page => page.id === target) : document.pages.length;
    const rest = { ...document, pages: document.pages.filter(page => page.id !== target) };
    if (target) commands.push({ type: 'delete-page', pageId: target });
    commands.push({ type: 'add-page', pageId, name: nextPageName(rest), index: Math.max(0, index) });
    commands.push(...mapped);
    if (target && thumbnailMainPageId(document) === target) commands.push({ type: 'set-main-page', pageId });
  } else commands.push(...mapped);
  return { command: { type: 'batch', commands }, pageId };
}
