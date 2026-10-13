import { describe, expect, it } from 'vitest';
import { ScenePlan } from '../sequence/scenePlan';
import { validateSequenceDocument } from '../sequence/validate';
import { thumbnailFixture } from './fixtures';
import { pureLayerBox, shapeBoxData, videoFrameSize } from './geometry';
import { pageToSequence } from './pageToSequence';

describe('pageToSequence', () => {
  it('1 レイヤー＝1 トラック。重なり順はレイヤーの順。コマ 0 で全部が描かれる', () => {
    const document = thumbnailFixture(), sequence = pageToSequence(document, 'page-a');
    expect(() => validateSequenceDocument(sequence)).not.toThrow();
    expect(sequence.tracks.map(track => track.id)).toEqual(document.pages[0]!.layers.map(layer => `track-${layer.id}`));
    expect(sequence).toMatchObject({ id: 'thumbnail.page-a', sequenceEndFrame: 1, resolution: { width: 1280, height: 720 }, revision: 0 });
    expect(new ScenePlan(sequence).frame(0).visuals.map(visual => visual.clip.id)).toEqual(['photo', 'shade', 'title', 'box', 'frame']);
  });
  it('出入りの動きなし・画像は plain・文字は自由書式（コマ 0 で透明にならない）', () => {
    const clips = pageToSequence(thumbnailFixture(), 'page-a').clips;
    for (const clip of clips) expect(clip.visual).toMatchObject({ enter: { kind: 'none', frames: 0 }, exit: { kind: 'none', frames: 0 } });
    expect(clips.find(clip => clip.id === 'photo')!.content).toEqual({ kind: 'image', assetId: 'img-1', style: 'plain' });
    expect(clips.find(clip => clip.id === 'title')!.content).toMatchObject({ kind: 'telop', textMode: 'free', data: { text: 'サムネ', animation: 'none' } });
  });
  it('コマは原本の秒を sourceIn にして終端で止める', () => {
    const frame = pageToSequence(thumbnailFixture(), 'page-a').clips.find(clip => clip.id === 'frame')!;
    expect(frame.content).toEqual({ kind: 'video', assetId: 'vid-1', streamIndex: 0, sourceIn: { num: 1, den: 20 }, rate: { num: 1, den: 1 }, endBehavior: 'hold' });
  });
  it('非表示・元が無い素材・その場編集中のレイヤーはトラックを無効にする', () => {
    const document = thumbnailFixture(); document.pages[0]!.layers[0]!.hidden = true;
    const sequence = pageToSequence(document, 'page-a', { unavailableAssetIds: new Set(['vid-1']), hiddenLayerIds: new Set(['title']) });
    expect(sequence.tracks.filter(track => !track.enabled).map(track => track.id)).toEqual(['track-photo', 'track-title', 'track-frame']);
  });
  it('写真の色は画像なら look.grade、コマなら colorGrade。白フチ・影・反転は画像だけ', () => {
    const document = thumbnailFixture(), layers = document.pages[0]!.layers, color = { brightness: 0, contrast: 0, saturation: -100, temperature: 0 };
    layers[0]!.visual = { ...layers[0]!.visual, color, blur: 3, edge: { width: 6, color: '#ffffff' }, flipX: true };
    layers[4]!.visual = { ...layers[4]!.visual, color, blur: 2 };
    const clips = pageToSequence(document, 'page-a').clips;
    expect(clips[0]!.visual!.look).toEqual({ grade: color, blur: 3, edge: { width: 6, color: '#ffffff' }, flipX: true });
    expect(clips[4]!.visual).toMatchObject({ colorGrade: color, look: { blur: 2 } });
    expect(clips[2]!.visual!.look).toBeUndefined();
  });
  it('図形は自分の箱を中央に置き、帯の暗さは全面の線形グラデーションになる', () => {
    const document = thumbnailFixture(), clips = pageToSequence(document, 'page-a').clips;
    expect(clips.find(clip => clip.id === 'box')!.content).toMatchObject({ kind: 'shape', strokeWidth: 8, cornerRadius: 0,
      data: { kind: 'rect', x1: .5 - 300 / 1280 / 2, y1: .5 - 200 / 720 / 2, x2: .5 + 300 / 1280 / 2, y2: .5 + 200 / 720 / 2 } });
    expect(clips.find(clip => clip.id === 'shade')!.content).toMatchObject({ kind: 'shape', strokeWidth: 0, data: { x1: 0, y1: 0, x2: 1, y2: 1 },
      fill: { kind: 'linear', angle: 0, stops: [{ offset: 0, color: '#00000099' }, { offset: .65, color: '#00000000' }] } });
    expect(shapeBoxData({ kind: 'arrow', width: 640, height: 40, color: '#ffffff', strokeWidth: 12, cornerRadius: 0, fill: null }, document.canvas)).toEqual({ x1: .25, y1: .5, x2: .75, y2: .5 });
  });
  it('コマ・図形・帯の外接箱は文書だけから求まる', () => {
    const document = thumbnailFixture(), layers = document.pages[0]!.layers;
    expect(videoFrameSize(document.assets[1]!.streams[0]!, document.canvas)).toEqual({ width: 1280, height: 720 });
    expect(pureLayerBox(document, layers[4]!)).toEqual({ cx: 640, cy: 360, width: 1280, height: 720, rotation: 0 });
    layers[3]!.visual = { ...layers[3]!.visual, position: { x: .5, y: -.5 }, scale: 2, rotation: 30 };
    expect(pureLayerBox(document, layers[3]!)).toEqual({ cx: 960, cy: 180, width: 600, height: 400, rotation: 30 });
    expect(pureLayerBox(document, layers[1]!)).toEqual({ cx: 640, cy: 360, width: 1280, height: 720, rotation: 0 });
    expect(pureLayerBox(document, layers[2]!)).toBeNull();
  });
});
