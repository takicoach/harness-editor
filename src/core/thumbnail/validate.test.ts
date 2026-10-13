import { describe, expect, it } from 'vitest';
import { SequenceError } from '../sequence/errors';
import { thumbnailFixture, textLayer } from './fixtures';
import { emptyThumbnailDocument, thumbnailCanvasFor, type ThumbnailDocument } from './model';
import { parseThumbnail, serializeThumbnail, thumbnailContentBytes, validateThumbnailDocument } from './validate';

const rejects = (mutate: (document: ThumbnailDocument) => void, message: string | RegExp) => {
  const document = thumbnailFixture(); mutate(document);
  expect(() => validateThumbnailDocument(document)).toThrow(message);
  try { validateThumbnailDocument(document); } catch (error) { expect(error).toBeInstanceOf(SequenceError); }
};

describe('ThumbnailDocument の検証', () => {
  it('見本の文書は通り、直列化して読み戻すと同じになる', () => {
    const document = thumbnailFixture();
    expect(() => validateThumbnailDocument(document)).not.toThrow();
    expect(parseThumbnail(serializeThumbnail(document))).toEqual(document);
  });
  it('キャンバスは案件の形式に合わせる', () => {
    expect(thumbnailCanvasFor({ width: 1920, height: 1080 })).toEqual({ width: 1280, height: 720 });
    expect(thumbnailCanvasFor({ width: 1080, height: 1920 })).toEqual({ width: 1080, height: 1920 });
    expect(thumbnailCanvasFor({ width: 720, height: 720 })).toEqual({ width: 1080, height: 1080 });
    expect(() => validateThumbnailDocument(emptyThumbnailDocument('t', { width: 1080, height: 1080 }, 'p'))).not.toThrow();
    rejects(document => { document.canvas = { width: 1000, height: 1000 }; }, 'キャンバスの大きさが不正です');
  });
  it('案は 3 つまで、1 案のレイヤーは 40 まで', () => {
    rejects(document => { for (const id of ['b', 'c', 'd']) document.pages.push({ id, name: id, hueShift: 0, layers: [] }); }, '案は 1〜3 つです');
    rejects(document => { document.pages[0]!.layers = Array.from({ length: 41 }, (_, index) => textLayer(`l${index}`)); }, '1 つの案に置けるレイヤーは 40 までです');
  });
  it('レイヤーの ID は案をまたいでも重複しない', () => {
    rejects(document => { document.pages.push({ id: 'page-b', name: '案B', hueShift: 0, layers: [textLayer('title')] }); }, 'レイヤーの ID が重複しています');
  });
  it('知らない種類・壊れた値・同梱外の書体を拒否する', () => {
    rejects(document => { (document.pages[0]!.layers[0]!.content as { kind: string }).kind = 'sticker'; }, '未対応のレイヤーです');
    rejects(document => { document.pages[0]!.layers[0]!.visual.opacity = Number.NaN; }, 'NaN');
    rejects(document => { const layer = document.pages[0]!.layers.find(item => item.content.kind === 'text')!; if (layer.content.kind === 'text') layer.content.appearance.fontFamily = 'Comic Sans MS'; }, 'サムネで使える書体は同梱の書体だけです');
  });
  it('コマは素材の指紋と一致し、素材の長さの内側だけ', () => {
    rejects(document => { const layer = document.pages[0]!.layers.find(item => item.content.kind === 'video-frame')!; if (layer.content.kind === 'video-frame') layer.content.fingerprint = 'c'.repeat(64); }, 'コマの元の動画が一致しません');
    rejects(document => { const layer = document.pages[0]!.layers.find(item => item.content.kind === 'video-frame')!; if (layer.content.kind === 'video-frame') layer.content.sourceTime = { num: 3, den: 1 }; }, 'コマの時刻が動画の外です');
  });
  it('内容のバイト列は版を含まない', () => {
    const document = thumbnailFixture(), next = { ...document, revision: 9 };
    expect(thumbnailContentBytes(next)).toBe(thumbnailContentBytes(document));
  });
  it('メインの案は存在する案だけを指せる', () => {
    const document = thumbnailFixture(); document.mainPageId = 'page-a';
    expect(() => validateThumbnailDocument(document)).not.toThrow();
    expect(parseThumbnail(serializeThumbnail(document)).mainPageId).toBe('page-a');
    rejects(document => { document.mainPageId = 'page-x'; }, 'メインの案が見つかりません');
    rejects(document => { (document as unknown as { mainPageId: number }).mainPageId = 3; }, 'メインの案が見つかりません');
  });
});
