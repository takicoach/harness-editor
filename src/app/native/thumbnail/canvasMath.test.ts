import { describe, expect, it } from 'vitest';
import { thumbnailFixture } from '../../../core/thumbnail/fixtures';
import type { RenderedSceneGeometry } from '../../../preview/native/renderGeometry';
import { applyOverrides, boxStyle, fitStage, layerBoxes } from './canvasMath';

const geometry = (clipId: string, bounds: { x: number; y: number; width: number; height: number; rotation: number }): RenderedSceneGeometry => ({
  documentId: 'thumbnail.page-a', revision: 0, frame: 0, resolution: { width: 1280, height: 720 }, videos: [],
  elements: [{ clipId, source: { displayWidth: 1280, displayHeight: 720, sampleAspectRatio: 1, rotation: 0 }, fittedSize: bounds, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false }, bounds, transition: false, animated: false }] });

describe('canvasMath（骨格）', () => {
  it('一時表示は指定した案のレイヤーだけを差し替え、元の文書は変えない', () => {
    const document = thumbnailFixture(), title = document.pages[0]!.layers[2]!;
    const preview = applyOverrides(document, 'page-a', new Map([['title', { visual: { ...title.visual, position: { x: .5, y: 0 } } }]]));
    expect(preview.pages[0]!.layers[2]!.visual.position).toEqual({ x: .5, y: 0 });
    expect(document.pages[0]!.layers[2]!.visual.position).toEqual({ x: 0, y: 0 });
    expect(applyOverrides(document, 'page-a', new Map())).toBe(document);
  });
  it('外接箱: 図形と帯は文書から、文字は描画の計測から。計測が無い文字は箱なし', () => {
    const document = thumbnailFixture();
    const boxes = layerBoxes(document, 'page-a', geometry('title', { x: 100, y: 200, width: 300, height: 100, rotation: 10 }));
    expect(boxes.get('title')).toEqual({ cx: 250, cy: 250, width: 300, height: 100, rotation: 10 });
    expect(boxes.get('box')).toEqual({ cx: 640, cy: 360, width: 300, height: 200, rotation: 0 });
    expect(boxes.get('shade')).toEqual({ cx: 640, cy: 360, width: 1280, height: 720, rotation: 0 });
    expect(boxes.get('frame')).toEqual({ cx: 640, cy: 360, width: 1280, height: 720, rotation: 0 });
    expect(layerBoxes(document, 'page-a', null).has('title')).toBe(false);
  });
  it('箱は表示倍率を掛けた CSS の位置になる', () => {
    expect(boxStyle({ cx: 100, cy: 50, width: 40, height: 20, rotation: 30 }, .5)).toEqual({ left: 40, top: 20, width: 20, height: 10, transform: 'rotate(30deg)' });
  });
});

import { hitTest, movedVisual, scaledLayer, scaleRatio, toCanvasPoint, widthFromHandle, boxCorners } from './canvasMath';
import { shapeLayer, textLayer } from '../../../core/thumbnail/fixtures';

describe('canvasMath（直接操作）', () => {
  const canvas = { width: 1280, height: 720 };
  it('画面の座標をキャンバスの px にする', () => {
    expect(toCanvasPoint({ clientX: 150, clientY: 80 }, { left: 50, top: 30 }, .5)).toEqual({ x: 200, y: 100 });
  });
  it('当たり判定は前面から。回転した箱・非表示・帯の暗さを正しく扱う', () => {
    const page = thumbnailFixture().pages[0]!, boxes = new Map([['photo', { cx: 640, cy: 360, width: 1280, height: 720, rotation: 0 }],
      ['shade', { cx: 640, cy: 360, width: 1280, height: 720, rotation: 0 }], ['box', { cx: 640, cy: 360, width: 400, height: 40, rotation: 90 }]]);
    expect(hitTest(page, boxes, { x: 640, y: 520 })).toBe('box');
    expect(hitTest(page, boxes, { x: 820, y: 360 })).toBe('photo');
    page.layers[0]!.hidden = true;
    expect(hitTest(page, boxes, { x: 820, y: 360 })).toBeNull();
    expect(boxCorners({ cx: 0, cy: 0, width: 2, height: 2, rotation: 0 })).toEqual([{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]);
  });
  it('移動は正規化座標に直し、範囲で止める', () => {
    expect(movedVisual(shapeLayer('s'), 64, -36, canvas).position).toEqual({ x: .1, y: -.1 });
    const photo = { ...shapeLayer('p'), content: { kind: 'image' as const, assetId: 'img-1', role: 'photo' as const } };
    expect(movedVisual(photo, 5000, 0, canvas).position.x).toBe(1.5);
  });
  it('四隅の拡縮: 文字は大きさと文字枠が連動し、ほかは scale', () => {
    expect(scaleRatio({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 })).toBe(2);
    const text = scaledLayer(textLayer('t'), 1.5);
    expect(text.content?.kind === 'text' && [text.content.appearance.fontSize, text.content.appearance.box?.width]).toEqual([180, 1]);
    expect(scaledLayer(shapeLayer('s'), 2).visual?.scale).toBe(2);
  });
  it('文字の左右のハンドルは、回転を考えて文字枠の幅を両側へ広げる', () => {
    const layer = textLayer('t'), box = { cx: 640, cy: 360, width: 600, height: 100, rotation: 0 };
    const wider = widthFromHandle(layer, box, { x: 940, y: 360 }, { x: 1004, y: 360 }, 'right', canvas);
    expect(wider.content?.kind === 'text' && wider.content.appearance.box).toEqual({ width: 1, anchor: 'center' });
    const narrower = widthFromHandle(layer, box, { x: 340, y: 360 }, { x: 468, y: 360 }, 'left', canvas);
    expect(narrower.content?.kind === 'text' && narrower.content.appearance.box?.width).toBe(.7);
  });
});

import { rotationFromPointer } from './canvasMath';

describe('回転', () => {
  it('中心からの角度の差だけ回し、-180..180 に収める。Shift で 15° 刻み', () => {
    const center = { x: 0, y: 0 };
    expect(rotationFromPointer(center, { x: 10, y: 0 }, { x: 0, y: 10 }, 0, false)).toBe(90);
    expect(rotationFromPointer(center, { x: 10, y: 0 }, { x: -10, y: 1 }, 30, false)).toBe(-155.7);
    expect(rotationFromPointer(center, { x: 10, y: 0 }, { x: 10, y: 4 }, 0, true)).toBe(15);
    expect(rotationFromPointer(center, { x: 10, y: 0 }, { x: 10, y: 1 }, 0, true)).toBe(0);
  });
});

import { snapMove, unionBox } from './canvasMath';

describe('吸着', () => {
  const canvas = { width: 1280, height: 720 };
  it('キャンバスの中央と端に吸い付く', () => {
    expect(snapMove({ cx: 644, cy: 300, width: 100, height: 50, rotation: 0 }, [], canvas, 8)).toEqual({ dx: -4, dy: 0, guidesX: [640], guidesY: [] });
    expect(snapMove({ cx: 53, cy: 27, width: 100, height: 50, rotation: 0 }, [], canvas, 8)).toEqual({ dx: -3, dy: -2, guidesX: [0], guidesY: [0] });
  });
  it('ほかの要素の端と中央に吸い付き、閾値の外は動かさない', () => {
    const other = { cx: 300, cy: 200, width: 200, height: 100, rotation: 0 };
    expect(snapMove({ cx: 455, cy: 500, width: 100, height: 50, rotation: 0 }, [other], canvas, 8)).toMatchObject({ dx: -5, guidesX: [400] });
    expect(snapMove({ cx: 470, cy: 500, width: 100, height: 50, rotation: 0 }, [other], canvas, 8)).toMatchObject({ dx: 0, guidesX: [] });
  });
  it('複数の箱は外接の長方形にまとめる', () => {
    expect(unionBox([{ cx: 10, cy: 10, width: 20, height: 20, rotation: 0 }, { cx: 50, cy: 30, width: 20, height: 20, rotation: 0 }])).toEqual({ cx: 30, cy: 20, width: 60, height: 40, rotation: 0 });
  });
});

import { textEditBox } from './canvasMath';

describe('その場編集の枠', () => {
  it('文字枠の幅 × 行数ぶんの高さを、位置・拡大・回転に合わせて置く', () => {
    const layer = { ...textLayer('t'), visual: { position: { x: .5, y: -.5 }, scale: 2, rotation: 10, opacity: 1 } };
    expect(textEditBox(layer, { width: 1280, height: 720 }, '一行目\n二行目')).toEqual({ cx: 960, cy: 180, width: 2304, height: 120 * 1.4 * 2 * 2, rotation: 10 });
    expect(textEditBox(shapeLayer('s'), { width: 1280, height: 720 }, '')).toBeNull();
  });
  it('上揃え（anchor top）は、層の位置が枠の上端なので、中央基準へ高さの半分だけ下げる', () => {
    const base = textLayer('t');
    const content = base.content.kind === 'text' ? base.content : null!;
    const layer = { ...base, visual: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, opacity: 1 }, content: { ...content, appearance: { ...content.appearance, box: { width: .5, anchor: 'top' as const } } } };
    const height = content.appearance.fontSize * content.appearance.lineHeight * 3;
    expect(textEditBox(layer, { width: 1280, height: 720 }, 'a\nb\nc')).toEqual({ cx: 640, cy: 360 + height / 2, width: 640, height, rotation: 0 });
  });
});

import { alignedVisual } from './canvasMath';

describe('配置', () => {
  it('外接箱をキャンバスの端・中央にそろえる', () => {
    const canvas = { width: 1280, height: 720 }, box = { cx: 640, cy: 360, width: 300, height: 200, rotation: 0 }, layer = shapeLayer('s');
    expect(alignedVisual(layer, box, canvas, 'left').position).toEqual({ x: -.7656, y: 0 });
    expect(alignedVisual(layer, box, canvas, 'bottom').position).toEqual({ x: 0, y: .7222 });
    expect(alignedVisual(layer, { ...box, cx: 700 }, canvas, 'center').position).toEqual({ x: -.0937, y: 0 });
  });
});

describe('全体表示の倍率と、スマホでの見え方の小窓のための余白', () => {
  const canvas = { width: 1280, height: 720 };
  it('小窓が無ければ四方 24px の余白で収める（これまでと同じ）', () => {
    expect(fitStage({ width: 1328, height: 768 }, canvas, null)).toEqual({ scale: 1, padRight: 24, padBottom: 24 });
  });
  it('縦に余裕があるときは下を空け、横に余裕があるときは右を空ける（キャンバスが大きくなる方）', () => {
    const below = fitStage({ width: 640, height: 644 }, canvas, { width: 210, height: 150 });
    expect(below).toEqual({ scale: (640 - 48) / 1280, padRight: 24, padBottom: 150 });
    const beside = fitStage({ width: 1200, height: 500 }, canvas, { width: 210, height: 150 });
    expect(beside.padRight).toBe(210);
    expect(beside.padBottom).toBe(24);
    expect(beside.scale).toBeCloseTo((500 - 48) / 720, 10);
  });
  it('空けた側にはキャンバスが入らない（中央寄せでも小窓の矩形と交わらない）', () => {
    for (const viewport of [{ width: 640, height: 644 }, { width: 812, height: 640 }, { width: 1084, height: 640 }, { width: 1200, height: 420 }]) {
      const reserve = { width: 210, height: 150 }, fit = fitStage(viewport, canvas, reserve);
      const contentWidth = viewport.width - 24 - fit.padRight, contentHeight = viewport.height - 24 - fit.padBottom;
      const right = 24 + (contentWidth + canvas.width * fit.scale) / 2, bottom = 24 + (contentHeight + canvas.height * fit.scale) / 2;
      expect(right <= viewport.width - reserve.width || bottom <= viewport.height - reserve.height).toBe(true);
    }
  });
});
