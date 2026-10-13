import { describe, expect, it } from 'vitest';
import { applyThumbnailCommand } from '../../../core/thumbnail/commands';
import { gradientLayer, imageLayer, shapeLayer, textLayer, thumbnailFixture, videoFrameLayer } from '../../../core/thumbnail/fixtures';
import type { ThumbnailDocument, ThumbnailLayer } from '../../../core/thumbnail/model';
import { ThumbnailSession } from '../../../core/thumbnail/session';
import { knobGroupFor, resetCommand, resetKnobs, type NumberKnob } from './knobs';

const knob = (layer: ThumbnailLayer, id: string) => knobGroupFor(layer).knobs.find(item => item.id === id) as NumberKnob;
const valueOf = (layer: ThumbnailLayer) => ({ visual: layer.visual, content: layer.content });
const element = (): ThumbnailLayer => ({ ...imageLayer('e'), content: { kind: 'image', assetId: 'img-1', role: 'element' } });

describe('つまみの定義（設計の表どおり）', () => {
  it('選んだ物ごとのつまみの並び', () => {
    expect(knobGroupFor(videoFrameLayer('f')).knobs.map(item => item.label)).toEqual(['明るさ', 'コントラスト', '彩度', 'あたたかさ', 'ぼかし', '拡大', '左右の位置', '上下の位置']);
    expect(knobGroupFor(imageLayer('p')).title).toBe('写真');
    expect(knobGroupFor(element()).knobs.map(item => item.label)).toEqual(['大きさ', '回転', '透明度', '明るさ', '白フチの太さ', '白フチの色', '影']);
    expect(knobGroupFor(textLayer('t')).knobs.map(item => item.label)).toEqual(['大きさ', '字間', '行間', '傾き', '内側の縁', '外側の縁', '影のずらし', '影のぼかし', '影の色', '帯の色', '帯の余白', '帯の角丸']);
    expect(knobGroupFor(shapeLayer('s')).knobs.map(item => item.label)).toEqual(['大きさ', '回転', '透明度', '線の太さ', '角丸']);
    expect(knobGroupFor(gradientLayer('g')).knobs).toEqual([]);
  });
  it('2 重の縁取り: 内側と外側を別々に足し、0 で外す', () => {
    const layer = textLayer('t'), both = knob(layer, 'outline-outer').write(knob(layer, 'outline-inner').write(valueOf(layer), 8), 6);
    expect(both.content.kind === 'text' && both.content.appearance.outlines).toEqual([{ width: 8, color: '#000000' }, { width: 6, color: '#ffffff' }]);
    const none = knob(layer, 'outline-inner').write(knob(layer, 'outline-outer').write(both, 0), 0);
    expect(none.content.kind === 'text' && none.content.appearance.outlines).toBeUndefined();
  });
  it('写真の色調整と白フチ', () => {
    const frame = videoFrameLayer('f');
    expect(knob(frame, 'saturation').write(valueOf(frame), -100).visual.color).toEqual({ brightness: 0, contrast: 0, saturation: -100, temperature: 0 });
    expect(knob(frame, 'saturation').write(knob(frame, 'saturation').write(valueOf(frame), -100), 0).visual.color).toBeUndefined();
    const edged = knob(element(), 'edge-width').write(valueOf(element()), 12);
    expect(edged.visual.edge).toEqual({ width: 12, color: '#ffffff' });
    expect(knob(element(), 'edge-width').write(edged, 0).visual.edge).toBeUndefined();
  });
  it('初期値に戻すは縁・影・帯・傾き・色調整を外し、左右反転は残す', () => {
    const text = textLayer('t');
    if (text.content.kind === 'text') text.content.appearance = { ...text.content.appearance, outlines: [{ width: 8, color: '#000000' }], band: { color: '#e60012', padX: 20, padY: 8, radius: 4 }, skewDeg: 10, fontSize: 200 };
    const reset = resetKnobs(text);
    expect(reset.content.kind === 'text' && [reset.content.appearance.outlines, reset.content.appearance.band, reset.content.appearance.skewDeg, reset.content.appearance.fontSize]).toEqual([undefined, undefined, undefined, 140]);
    const photo = imageLayer('p');
    photo.visual = { ...photo.visual, color: { brightness: 20, contrast: 0, saturation: 0, temperature: 0 }, flipX: true, scale: 1.5 };
    expect(resetKnobs(photo).visual).toEqual({ position: { x: 0, y: 0 }, scale: 1, rotation: 0, opacity: 1, flipX: true });
  });
});

describe('「初期値に戻す」（選んだ物のつまみ＋サムネ全体のつまみを 1 回の操作で）', () => {
  /** 文字 1 つ・暗さの帯あり・色の組み合わせ 40° の案。 */
  function shifted(): { document: ThumbnailDocument; original: ThumbnailDocument } {
    const original: ThumbnailDocument = { ...thumbnailFixture(), pages: [{ id: 'page-a', name: '案A', hueShift: 0, layers: [gradientLayer('shade'), textLayer('title'), shapeLayer('box')] }] };
    let document = applyThumbnailCommand(original, { type: 'shift-page-hue', pageId: 'page-a', degrees: 40 });
    document = applyThumbnailCommand(document, { type: 'update-layer', pageId: 'page-a', layerId: 'title', patch: { content: (() => {
      const layer = document.pages[0]!.layers[1]!;
      if (layer.content.kind !== 'text') throw new Error('文字ではありません');
      return { ...layer.content, appearance: { ...layer.content.appearance, outlines: [{ width: 8, color: '#000000' }], skewDeg: 10, fontSize: 200 } };
    })() } });
    return { document, original };
  }
  const page = (document: ThumbnailDocument) => document.pages[0]!;
  const layerOf = (document: ThumbnailDocument, id: string) => page(document).layers.find(layer => layer.id === id);
  it('何も選んでいない時は「サムネ全体」（暗さ・色の組み合わせ）だけを戻す', () => {
    const { document, original } = shifted(), command = resetCommand(page(document), undefined)!;
    expect(command.type).toBe('batch');
    const next = applyThumbnailCommand(document, command);
    expect(page(next).hueShift).toBe(0);
    expect(layerOf(next, 'shade')).toBeUndefined();
    // 文字のつまみは触らない（縁・傾き・大きさは残る）。色は回し戻る。
    const title = layerOf(next, 'title')!;
    expect(title.content.kind === 'text' && [title.content.appearance.fontSize, title.content.appearance.skewDeg]).toEqual([200, 10]);
    expect(layerOf(next, 'box')!.content).toEqual(layerOf(original, 'box')!.content);
  });
  it('選んだ物があれば、その物のつまみも同じ 1 回で戻す（色を回し戻すのは選んだ物を戻した後）', () => {
    const { document, original } = shifted(), title = layerOf(document, 'title')!;
    const command = resetCommand(page(document), title)!;
    expect(command.type === 'batch' && command.commands.map(item => item.type)).toEqual(['update-layer', 'shift-page-hue', 'delete-layers']);
    const next = applyThumbnailCommand(document, command), reset = layerOf(next, 'title')!;
    expect(reset.content.kind === 'text' && [reset.content.appearance.outlines, reset.content.appearance.skewDeg, reset.content.appearance.fontSize]).toEqual([undefined, undefined, 140]);
    const before = layerOf(original, 'title')!;
    expect(reset.content.kind === 'text' && before.content.kind === 'text' && reset.content.appearance.color).toBe(before.content.kind === 'text' && before.content.appearance.color);
    expect(page(next).hueShift).toBe(0);
  });
  it('元に戻す 1 回で、戻す前の状態にそろって戻る', () => {
    const { document } = shifted(), session = new ThumbnailSession('s', document);
    session.execute({ sessionId: 's', expectedRevision: document.revision, executionId: 'reset', command: resetCommand(page(document), layerOf(document, 'title'))! });
    const undone = session.execute({ sessionId: 's', expectedRevision: session.document.revision, executionId: 'undo', command: { type: 'undo' } }).document;
    expect({ ...undone, revision: 0 }).toEqual({ ...document, revision: 0 });
    expect(session.canUndo).toBe(false);
  });
  it('戻すものが無ければ何もしない。ロック中の物のつまみと、ロック中の暗さの帯は戻さない', () => {
    const initial = { ...textLayer('title'), ...resetKnobs(textLayer('title')) };
    const plain: ThumbnailDocument = { ...thumbnailFixture(), pages: [{ id: 'page-a', name: '案A', hueShift: 0, layers: [initial] }] };
    expect(resetCommand(page(plain), layerOf(plain, 'title'))).toBeNull();
    expect(resetCommand(page(plain), undefined)).toBeNull();
    const { document } = shifted(), locked = { ...layerOf(document, 'title')!, locked: true };
    const lockedPage = { ...page(document), layers: page(document).layers.map(layer => layer.id === 'title' ? locked : layer.id === 'shade' ? { ...layer, locked: true } : layer) };
    expect(resetCommand(lockedPage, locked)).toEqual({ type: 'shift-page-hue', pageId: 'page-a', degrees: 0 });
  });
});
