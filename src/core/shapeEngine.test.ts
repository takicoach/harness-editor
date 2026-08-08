import { describe, expect, it } from 'vitest';
import { anchorShapes, projectShapes, clampShapes, shapeInCutRegion } from './shapeEngine';
import type { CutRegion, EditorShape, ShapeSegment } from './types';

const REGIONS: CutRegion[] = [{ start: 1000, end: 3000 }];

const BASE_SHAPE: Omit<ShapeSegment, 'id' | 'startFrame' | 'endFrame'> = {
  kind: 'arrow',
  x1: 0.1,
  y1: 0.2,
  x2: 0.8,
  y2: 0.9,
  color: '#ff0000',
  thickness: 'medium',
};

const BASE_EDITOR: Omit<EditorShape, 'id' | 'originalStart' | 'originalEnd'> = {
  kind: 'arrow',
  x1: 0.1,
  y1: 0.2,
  x2: 0.8,
  y2: 0.9,
  color: '#ff0000',
  thickness: 'medium',
};

describe('anchorShapes', () => {
  it('再生フレーム区間を原本フレーム区間へ逆射影する', () => {
    const shapes: ShapeSegment[] = [
      { id: 1, startFrame: 500, endFrame: 800, ...BASE_SHAPE },
      { id: 2, startFrame: 1500, endFrame: 1800, ...BASE_SHAPE, kind: 'rect' },
    ];
    expect(anchorShapes(shapes, REGIONS)).toEqual([
      { id: 1, originalStart: 500, originalEnd: 800, ...BASE_EDITOR },
      { id: 2, originalStart: 3500, originalEnd: 3800, ...BASE_EDITOR, kind: 'rect' },
    ]);
  });

  it('カット無しなら frame はそのまま', () => {
    expect(
      anchorShapes(
        [{ id: 1, startFrame: 80, endFrame: 200, ...BASE_SHAPE }],
        [],
      ),
    ).toEqual([
      { id: 1, originalStart: 80, originalEnd: 200, ...BASE_EDITOR },
    ]);
  });
});

describe('projectShapes', () => {
  it('原本フレーム区間を再生フレーム区間へ射影する', () => {
    const shapes: EditorShape[] = [
      { id: 1, originalStart: 500, originalEnd: 800, ...BASE_EDITOR },
      { id: 2, originalStart: 3500, originalEnd: 3800, ...BASE_EDITOR, kind: 'ellipse' },
    ];
    expect(projectShapes(shapes, REGIONS)).toEqual([
      { id: 1, startFrame: 500, endFrame: 800, ...BASE_SHAPE },
      { id: 2, startFrame: 1500, endFrame: 1800, ...BASE_SHAPE, kind: 'ellipse' },
    ]);
  });

  it('anchorShapes → projectShapes はカット外で往復一致する', () => {
    const shapes: ShapeSegment[] = [
      { id: 1, startFrame: 100, endFrame: 600, ...BASE_SHAPE, kind: 'line' },
    ];
    expect(projectShapes(anchorShapes(shapes, REGIONS), REGIONS)).toEqual(shapes);
  });
});

describe('clampShapes', () => {
  it('開始端がカット内なら区間終端へ寄せる', () => {
    const result = clampShapes(
      [{ id: 1, originalStart: 1500, originalEnd: 3500, ...BASE_EDITOR }],
      REGIONS,
    );
    expect(result.shapes).toEqual([
      { id: 1, originalStart: 3000, originalEnd: 3500, ...BASE_EDITOR },
    ]);
    expect(result.flaggedIds).toEqual([]);
  });

  it('終了端がカット内なら区間始端へ寄せる', () => {
    const result = clampShapes(
      [{ id: 1, originalStart: 500, originalEnd: 2500, ...BASE_EDITOR }],
      REGIONS,
    );
    expect(result.shapes).toEqual([
      { id: 1, originalStart: 500, originalEnd: 1000, ...BASE_EDITOR },
    ]);
    expect(result.flaggedIds).toEqual([]);
  });

  it('完全にカット区間内へ飲まれた図形は flagged になり原形のまま残す', () => {
    const original: EditorShape = {
      id: 7, originalStart: 1500, originalEnd: 2500, ...BASE_EDITOR,
    };
    const result = clampShapes([original], REGIONS);
    expect(result.shapes).toEqual([original]);
    expect(result.flaggedIds).toEqual([7]);
  });

  it('カット境界に触れない図形は手を加えない（参照同一）', () => {
    const original: EditorShape = {
      id: 1, originalStart: 100, originalEnd: 900, ...BASE_EDITOR,
    };
    const result = clampShapes([original], REGIONS);
    expect(result.shapes[0]).toBe(original);
    expect(result.flaggedIds).toEqual([]);
  });
});

describe('shapeInCutRegion', () => {
  it('両端がカット内なら true', () => {
    expect(shapeInCutRegion(1200, 2500, REGIONS)).toBe(true);
  });

  it('開始のみカット内（部分カット）は false', () => {
    expect(shapeInCutRegion(1500, 3500, REGIONS)).toBe(false);
  });

  it('終了のみカット内（部分カット）は false', () => {
    expect(shapeInCutRegion(500, 2500, REGIONS)).toBe(false);
  });

  it('カット区間を跨ぐが両端は外側なら false（区間を含むだけでは true にしない）', () => {
    expect(shapeInCutRegion(500, 3500, REGIONS)).toBe(false);
  });

  it('終端が cut.end と一致する場合は exclusive 扱いで両端外と判定して false', () => {
    expect(shapeInCutRegion(500, 3000, REGIONS)).toBe(false);
  });

  it('開始端が cut.start と一致する場合（区間内扱い）+ 終了も区間内 → true', () => {
    expect(shapeInCutRegion(1000, 2500, REGIONS)).toBe(true);
  });
});
