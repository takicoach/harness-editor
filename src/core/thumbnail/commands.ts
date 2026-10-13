import { SequenceError } from '../sequence/errors';
import type { SequenceAsset } from '../sequence/model';
import { rotateHexHue } from './color';
import { findLayer, findPage, THUMBNAIL_MAX_COMMAND_LEAVES, THUMBNAIL_MAX_LAYERS, THUMBNAIL_MAX_PAGES, thumbnailMainPageId, thumbnailPageNameKey,
  type ThumbnailContent, type ThumbnailDocument, type ThumbnailLayer, type ThumbnailVisual } from './model';
import { thumbnailContentBytes, validateThumbnailDocument } from './validate';

export type ThumbnailCommand =
  | { type: 'add-layer'; pageId: string; layer: ThumbnailLayer; index?: number }
  | { type: 'update-layer'; pageId: string; layerId: string; patch: { name?: string; content?: ThumbnailContent; visual?: ThumbnailVisual } }
  | { type: 'delete-layers'; pageId: string; layerIds: string[] }
  | { type: 'reorder-layer'; pageId: string; layerId: string; index: number }
  | { type: 'set-layer-flags'; pageId: string; layerId: string; hidden?: boolean; locked?: boolean }
  | { type: 'add-page'; pageId: string; name: string; duplicateOf?: string; index?: number }
  | { type: 'delete-page'; pageId: string }
  | { type: 'reorder-page'; pageId: string; index: number }
  | { type: 'rename-page'; pageId: string; name: string }
  | { type: 'shift-page-hue'; pageId: string; degrees: number }
  | { type: 'set-main-page'; pageId: string }
  | { type: 'register-assets'; assets: SequenceAsset[] }
  | { type: 'batch'; commands: ThumbnailCommand[] };
export type ThumbnailHistoryCommand = { type: 'undo' } | { type: 'redo' };
export const THUMBNAIL_COMMAND_TYPES: readonly ThumbnailCommand['type'][] = ['add-layer', 'update-layer', 'delete-layers', 'reorder-layer', 'set-layer-flags',
  'add-page', 'delete-page', 'reorder-page', 'rename-page', 'shift-page-hue', 'set-main-page', 'register-assets', 'batch'];

function invalid(message: string, targets: string[] = []): never { throw new SequenceError('INVALID_DOCUMENT', message, targets); }
function range(message: string): never { throw new SequenceError('INVALID_RANGE', message); }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function checkIndex(index: unknown, max: number): number {
  if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) > max) range('並べる位置が範囲外です');
  return index as number;
}
/** 案の複製と色の組み合わせは 1 操作。まとめ（batch）の入れ物は数えない。 */
export function countThumbnailLeaves(command: ThumbnailCommand, depth = 0): number {
  if (!record(command)) return invalid('操作の形が不正です');
  if (command.type !== 'batch') return 1;
  if (depth >= 4 || !Array.isArray(command.commands)) return invalid('まとめる操作の形が不正です');
  return command.commands.reduce((sum, child) => sum + countThumbnailLeaves(child, depth + 1), 0);
}
function layerIdAllocator(document: ThumbnailDocument): () => string {
  const used = new Set(document.pages.flatMap(page => page.layers.map(layer => layer.id)));
  let counter = 0;
  return () => { let id: string; do { id = `layer-${++counter}`; } while (used.has(id)); used.add(id); return id; };
}
function shiftLayerHue(layer: ThumbnailLayer, delta: number): void {
  const content = layer.content;
  if (content.kind === 'text') {
    const appearance = content.appearance;
    appearance.color = rotateHexHue(appearance.color, delta);
    appearance.strokeColor = rotateHexHue(appearance.strokeColor, delta);
    if (appearance.outlines) appearance.outlines = appearance.outlines.map(outline => ({ ...outline, color: rotateHexHue(outline.color, delta) }));
    if (appearance.band) appearance.band = { ...appearance.band, color: rotateHexHue(appearance.band.color, delta) };
  } else if (content.kind === 'shape') {
    const shape = content.shape;
    shape.color = rotateHexHue(shape.color, delta);
    if (shape.fill?.kind === 'solid') shape.fill = { kind: 'solid', color: rotateHexHue(shape.fill.color, delta) };
    else if (shape.fill?.kind === 'linear') shape.fill = { ...shape.fill, stops: shape.fill.stops.map(stop => ({ ...stop, color: rotateHexHue(stop.color, delta) })) };
  }
}

/**
 * 案の名前は、書き出しのファイル名と同じ規則で比べて他の案と重ならないこと（重なると書き出しが上書きし合う）。
 * 文書の検証（validateThumbnailDocument）には入れない: すでに重複を持つ古い文書を開けなくしないため、新しく付ける名前だけを確かめる。
 */
function assertUniquePageName(document: ThumbnailDocument, name: unknown, pageId: string): void {
  if (typeof name !== 'string') return; // 形の不正は文書の検証が断る
  const key = thumbnailPageNameKey(name), clash = document.pages.find(page => page.id !== pageId && thumbnailPageNameKey(page.name) === key);
  if (clash) invalid(`「${clash.name}」と同じ名前になります（書き出すと同じファイル名になります）。別の名前にしてください`, [clash.id]);
}
/** 案の順序を変える前に、既定（先頭）のメインを ID で固定する。並べ替えや先頭への追加でメインが入れ替わらないようにする。 */
function pinMainPage(document: ThumbnailDocument): void {
  if (document.mainPageId === undefined) document.mainPageId = thumbnailMainPageId(document);
}

/** 色の組み合わせのつまみを動かしている間の見た目（画面の一時表示用。保存は shift-page-hue）。 */
export function hueShiftedLayer(layer: ThumbnailLayer, delta: number): ThumbnailLayer {
  const copy = structuredClone(layer);
  shiftLayerHue(copy, delta);
  return copy;
}
/** 1 つの操作を複製済みの文書へ当てる。途中で失敗したら呼び出し元が複製ごと捨てる（原子的）。 */
function apply(document: ThumbnailDocument, command: ThumbnailCommand): ThumbnailDocument {
  switch (command.type) {
    case 'add-layer': {
      const page = findPage(document, command.pageId);
      if (page.layers.length >= THUMBNAIL_MAX_LAYERS) range(`1 つの案に置けるレイヤーは ${THUMBNAIL_MAX_LAYERS} までです`);
      if (!record(command.layer)) invalid('追加するレイヤーが不正です');
      page.layers.splice(checkIndex(command.index ?? page.layers.length, page.layers.length), 0, structuredClone(command.layer));
      return document;
    }
    case 'update-layer': {
      const layer = findLayer(findPage(document, command.pageId), command.layerId), patch = command.patch;
      if (!record(patch)) invalid('変更内容が不正です');
      if (patch.content !== undefined && (!record(patch.content) || patch.content.kind !== layer.content.kind)) invalid('レイヤーの種類は変えられません', [layer.id]);
      if (patch.name !== undefined) layer.name = patch.name;
      if (patch.content !== undefined) layer.content = structuredClone(patch.content);
      if (patch.visual !== undefined) layer.visual = structuredClone(patch.visual);
      return document;
    }
    case 'delete-layers': {
      const page = findPage(document, command.pageId);
      if (!Array.isArray(command.layerIds) || !command.layerIds.length) invalid('削除するレイヤーを指定してください');
      for (const id of command.layerIds) findLayer(page, id);
      page.layers = page.layers.filter(layer => !command.layerIds.includes(layer.id));
      return document;
    }
    case 'reorder-layer': {
      const page = findPage(document, command.pageId), layer = findLayer(page, command.layerId);
      const index = checkIndex(command.index, page.layers.length - 1);
      page.layers.splice(page.layers.indexOf(layer), 1);
      page.layers.splice(index, 0, layer);
      return document;
    }
    case 'set-layer-flags': {
      const layer = findLayer(findPage(document, command.pageId), command.layerId);
      if (command.hidden === undefined && command.locked === undefined) invalid('表示かロックを指定してください');
      if (command.hidden !== undefined) layer.hidden = command.hidden;
      if (command.locked !== undefined) layer.locked = command.locked;
      return document;
    }
    case 'add-page': {
      if (document.pages.length >= THUMBNAIL_MAX_PAGES) range(`案は ${THUMBNAIL_MAX_PAGES} つまでです`);
      if (document.pages.some(page => page.id === command.pageId)) invalid('同じ案 ID があります', [command.pageId]);
      assertUniquePageName(document, command.name, command.pageId);
      const source = command.duplicateOf === undefined ? undefined : findPage(document, command.duplicateOf), fresh = layerIdAllocator(document);
      const page = { id: command.pageId, name: command.name, hueShift: source?.hueShift ?? 0,
        layers: (source?.layers ?? []).map(layer => ({ ...structuredClone(layer), id: fresh() })) };
      const at = checkIndex(command.index ?? (source ? document.pages.indexOf(source) + 1 : document.pages.length), document.pages.length);
      if (at === 0) pinMainPage(document);
      document.pages.splice(at, 0, page);
      return document;
    }
    case 'delete-page': {
      if (document.pages.length <= 1) range('最後の案は削除できません');
      const page = findPage(document, command.pageId), wasMain = thumbnailMainPageId(document) === page.id;
      document.pages = document.pages.filter(item => item !== page);
      // メインを消したら先頭の案がメイン（指定を外すと先頭になる）。
      if (wasMain) delete document.mainPageId;
      return document;
    }
    case 'reorder-page': {
      const page = findPage(document, command.pageId), index = checkIndex(command.index, document.pages.length - 1);
      // 位置が変わる時だけメインを固定する（同じ位置なら内容を変えず、元に戻すも積まない）。
      if (document.pages.indexOf(page) === index) return document;
      pinMainPage(document);
      document.pages.splice(document.pages.indexOf(page), 1);
      document.pages.splice(index, 0, page);
      return document;
    }
    case 'rename-page': {
      const page = findPage(document, command.pageId);
      assertUniquePageName(document, command.name, page.id);
      page.name = command.name;
      return document;
    }
    case 'shift-page-hue': {
      const page = findPage(document, command.pageId);
      if (typeof command.degrees !== 'number' || !Number.isFinite(command.degrees) || command.degrees < -180 || command.degrees > 180) range('色の組み合わせの角度が範囲外です');
      const delta = command.degrees - page.hueShift;
      for (const layer of page.layers) shiftLayerHue(layer, delta);
      page.hueShift = command.degrees;
      return document;
    }
    case 'set-main-page': {
      const page = findPage(document, command.pageId);
      // すでにメインなら何も変えない（既定の先頭を選び直しても版を進めない）。
      if (thumbnailMainPageId(document) !== page.id) document.mainPageId = page.id;
      return document;
    }
    case 'register-assets': {
      if (!Array.isArray(command.assets) || !command.assets.length || command.assets.length > 20) invalid('登録する素材の一覧が不正です');
      for (const asset of command.assets) {
        const existing = document.assets.find(item => item.id === asset.id);
        if (existing && (existing.fingerprint !== asset.fingerprint || existing.kind !== asset.kind)) invalid('同じ素材 ID に異なる素材があります', [asset.id]);
        if (!existing) document.assets.push(structuredClone(asset));
      }
      return document;
    }
    case 'batch': {
      let next = document;
      for (const child of command.commands) next = apply(next, child);
      return next;
    }
    default: return invalid('未対応の操作です');
  }
}
/** 内容が変わらなければ同じ参照、変われば revision+1。結果は必ず検証する。 */
export function applyThumbnailCommand(document: ThumbnailDocument, command: ThumbnailCommand): ThumbnailDocument {
  if (countThumbnailLeaves(command) > THUMBNAIL_MAX_COMMAND_LEAVES) range('まとめる編集操作が多すぎます');
  const before = thumbnailContentBytes(document);
  const next = apply(structuredClone(document), command);
  if (thumbnailContentBytes(next) === before) return document;
  next.revision = document.revision + 1;
  validateThumbnailDocument(next);
  return next;
}
