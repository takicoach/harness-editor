/** @vitest-environment jsdom */
/**
 * R2-M1: 分度器の装飾式（弧の半径・弧線の太さ・読み取り値の位置と字の大きさ）は
 * `core/shapeGeometry` の `angleDecorations` だけが持つ。ここでは native の実描画（DOM）と
 * 書き出しの SVG 文字列を突き合わせ、2 つの経路が同じ値を描いていることを実測する。
 */
import { expect, it, vi } from 'vitest';
import { NativeSceneRenderer } from './sceneRenderer';
import { buildShapeSvg } from '../../server/shapeRaster';
import { angleDecorations } from '../../core/shapeGeometry';
import { thicknessToPx } from '../../core/shapeStyle';
import { ScenePlan } from '../../core/sequence/scenePlan';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import { rational as r } from '../../core/sequence/time';
import type { SequenceDocument } from '../../core/sequence/model';
import type { ShapeSegment } from '../../core/types';

vi.mock('./compositor', () => ({ NativeCompositor: class { dispose() {} } }));

const WIDTH = 640, HEIGHT = 360;
const shape = { kind: 'angle' as const, x1: 0.5, y1: 0.7, x2: 0.8, y2: 0.25, x3: 0.18, y3: 0.42,
  color: '#ff2255', thickness: 'medium' as const, opacity: 1 };

function document_(): SequenceDocument {
  return { schemaVersion: 2, id: 'angle-doc', name: 'angle', revision: 1, fps: r(30),
    resolution: { width: WIDTH, height: HEIGHT }, sequenceEndFrame: 60, background: '#000000', assets: [],
    tracks: [{ id: 'v', name: '図形', kind: 'visual', enabled: true }], transitions: [], transcripts: [],
    ducking: { enabled: false, strength: 'mid' },
    clips: [{ id: 'angle', name: '分度器', trackId: 'v', startFrame: 0, durationFrames: 60,
      clock: { offset: r(0), rate: r(1), duration: r(60) }, content: { kind: 'shape', data: { ...shape } },
      visual: { layout: structuredClone(DEFAULT_MAIN_LAYOUT), opacity: 1, keyframes: [],
        enter: { kind: 'none', frames: 0 }, exit: { kind: 'none', frames: 0 } } }] };
}

const attribute = (svg: string, tag: string, name: string): string =>
  new RegExp(`<${tag}[^>]*\\s${name}="([^"]*)"`).exec(svg)?.[1] ?? '';

it('分度器の装飾は native と書き出しで同じ値になる', async () => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
  const container = document.createElement('div');
  document.body.append(container);
  const renderer = new NativeSceneRenderer(container, 'angle-project');
  try {
    await renderer.render(new ScenePlan(document_()), 10);
    const shadow = container.firstElementChild?.shadowRoot;
    const arc = shadow?.querySelector('path'), readout = shadow?.querySelector('[data-native-angle-readout]');
    expect(arc, 'native が弧を描いていない').toBeTruthy();
    expect(readout, 'native が読み取り値を描いていない').toBeTruthy();

    const segment: ShapeSegment = { id: 1, startFrame: 0, endFrame: 60, ...shape };
    const exported = buildShapeSvg(segment, WIDTH, HEIGHT);
    const expected = angleDecorations(shape, WIDTH, HEIGHT, thicknessToPx(shape.thickness, HEIGHT));

    // native の DOM ＝ 書き出しの SVG ＝ 共有関数の出力（3 つが一致する）。
    expect(arc!.getAttribute('d')).toBe(expected.arcPath);
    expect(attribute(exported, 'path', 'd')).toBe(expected.arcPath);
    expect(Number(arc!.getAttribute('stroke-width'))).toBe(expected.arcStroke);
    expect(Number(attribute(exported, 'path', 'stroke-width'))).toBe(expected.arcStroke);
    expect(Number(readout!.getAttribute('x'))).toBe(expected.label.x);
    expect(Number(readout!.getAttribute('y'))).toBe(expected.label.y);
    expect(Number(attribute(exported, 'text', 'x'))).toBe(expected.label.x);
    expect(Number(attribute(exported, 'text', 'y'))).toBe(expected.label.y);
    expect((readout as HTMLElement).style.fontSize).toBe(`${expected.fontSize}px`);
    expect(Number(attribute(exported, 'text', 'font-size'))).toBe(expected.fontSize);
    expect(readout!.textContent).toBe(`${expected.degrees.toFixed(1)}°`);
    expect(exported).toContain(`>${expected.degrees.toFixed(1)}°</text>`);
  } finally { renderer.dispose(); await Promise.resolve(); container.remove(); }
});
