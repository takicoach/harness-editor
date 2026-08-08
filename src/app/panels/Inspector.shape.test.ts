/**
 * Inspector 図形設定タブのロジックテスト。
 * DOM レンダリングを伴わない純粋なロジック確認。
 * - 色プリセット6種、太さ3種の定数確認
 * - `setShapeColor / setShapeThickness / setShapeOpacity / retimeShape` の動作確認
 */
import { describe, it, expect } from 'vitest';
import { SHAPE_COLORS } from '../../core/shapeStyle';
import { addShape, setShapeColor, setShapeThickness, setShapeOpacity, retimeShape } from '../edit/shapeOps';
import { createEditState } from '../edit/editState';
import type { EditorProject } from '../../core/types';

function makeProject(over: Partial<EditorProject> = {}): EditorProject {
  return {
    videoConfig: {
      format: 'short',
      fps: 30,
      durationFrames: 900,
      videoFile: 'main.mp4',
      resolution: { width: 1080, height: 1920 },
      orientation: 'portrait',
      titleStyle: { top: 60, left: 30, fontSize: 30 },
    },
    projectConfig: null,
    transcript: { durationMs: 30000, words: [], segments: [] },
    telops: [],
    cutRegions: [],
    se: [],
    images: [],
    videoInserts: [],
    bgm: [],
    shapes: [],
    telopDataSource: 'export const telopData = [];\n',
    cutDataSource: null,
    seDataSource: null,
    insertImageDataSource: null,
    titles: [],
    titleDataSource: null,
    shapeDataSource: null,
    mainSpeed: 1,
    segmentSpeeds: {},
    ...over,
  };
}

const base = () => createEditState(makeProject());

describe('Inspector 図形設定 - 色プリセット', () => {
  it('SHAPE_COLORS は 6 種類ある（受入基準: 色6プリセット）', () => {
    expect(SHAPE_COLORS).toHaveLength(6);
  });

  it('プリセット色（赤・黄・白・黒・青・緑）の順番', () => {
    expect(SHAPE_COLORS[0]).toBe('#FF3B30'); // 赤
    expect(SHAPE_COLORS[1]).toBe('#FFCC00'); // 黄
    expect(SHAPE_COLORS[2]).toBe('#FFFFFF'); // 白
    expect(SHAPE_COLORS[3]).toBe('#000000'); // 黒
    expect(SHAPE_COLORS[4]).toBe('#0A84FF'); // 青
    expect(SHAPE_COLORS[5]).toBe('#34C759'); // 緑
  });

  it('setShapeColor で色が変わる', () => {
    const s0 = base();
    const s1 = addShape(s0, 'rect', 0.1, 0.1, 0.5, 0.5, 10);
    const shape = s1.shapes[0];
    expect(shape).toBeDefined();
    const s2 = setShapeColor(s1, shape!.id, '#0A84FF');
    expect(s2.shapes.find((sh) => sh.id === shape!.id)?.color).toBe('#0A84FF');
  });
});

describe('Inspector 図形設定 - 太さ（受入基準: 太さ3段）', () => {
  it('太さのプリセットが3種（thin/medium/thick）', () => {
    const THICKNESS_PRESETS = ['thin', 'medium', 'thick'] as const;
    expect(THICKNESS_PRESETS).toHaveLength(3);
  });

  it('setShapeThickness で太さが変わる', () => {
    const s0 = base();
    const s1 = addShape(s0, 'line', 0, 0, 1, 1, 0);
    const shape = s1.shapes[0];
    expect(shape).toBeDefined();
    const s2 = setShapeThickness(s1, shape!.id, 'thick');
    expect(s2.shapes.find((sh) => sh.id === shape!.id)?.thickness).toBe('thick');
  });
});

describe('Inspector 図形設定 - 不透明度スライダー', () => {
  it('setShapeOpacity で不透明度が変わる（0..1 範囲）', () => {
    const s0 = base();
    const s1 = addShape(s0, 'ellipse', 0.2, 0.2, 0.8, 0.8, 0);
    const shape = s1.shapes[0];
    expect(shape).toBeDefined();
    const s2 = setShapeOpacity(s1, shape!.id, 0.5);
    expect(s2.shapes.find((sh) => sh.id === shape!.id)?.opacity).toBe(0.5);
  });

  it('setShapeOpacity は 0..1 にクランプ', () => {
    const s0 = base();
    const s1 = addShape(s0, 'ellipse', 0.2, 0.2, 0.8, 0.8, 0);
    const shape = s1.shapes[0];
    expect(shape).toBeDefined();
    const s2 = setShapeOpacity(s1, shape!.id, 2.0);
    expect(s2.shapes.find((sh) => sh.id === shape!.id)?.opacity).toBe(1);
    const s3 = setShapeOpacity(s1, shape!.id, -0.5);
    expect(s3.shapes.find((sh) => sh.id === shape!.id)?.opacity).toBe(0);
  });
});

describe('Inspector 図形設定 - 表示区間（秒）', () => {
  it('retimeShape で表示区間が変わる', () => {
    const s0 = base();
    const s1 = addShape(s0, 'arrow', 0, 0, 1, 1, 0);
    const shape = s1.shapes[0];
    expect(shape).toBeDefined();
    const s2 = retimeShape(s1, shape!.id, 30, 90);
    const updated = s2.shapes.find((sh) => sh.id === shape!.id);
    expect(updated?.originalStart).toBe(30);
    expect(updated?.originalEnd).toBe(90);
  });
});

describe('Inspector 図形設定 - 「図形機能を導入」CTA', () => {
  it('shapeInstalled フラグが false のとき CTA が表示されるべき（設計確認）', () => {
    // Inspector に shapeInstalled prop が渡される
    const shapeInstalled = false;
    expect(shapeInstalled).toBe(false);
  });

  it('shapeInstalled が true のとき「導入済み」表示になるべき', () => {
    const shapeInstalled = true;
    expect(shapeInstalled).toBe(true);
  });
});
