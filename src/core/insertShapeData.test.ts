import { describe, expect, it } from 'vitest';
import {
  parseInsertShapeData,
  formatInsertShapeArray,
  serializeInsertShapeData,
} from './insertShapeData';
import type { ShapeSegment } from './types';

// ---------------------------------------------------------------------------
// テスト用ソース（shapeData.ts 相当）
// ---------------------------------------------------------------------------
const SOURCE = `import type { ShapeSegment } from './types';

// ==== 図形オーバーレイデータ ====
export const shapeData: ShapeSegment[] = [
  {
    id: 1,
    startFrame: 60,
    endFrame: 180,
    kind: "arrow",
    x1: 0.1,
    y1: 0.2,
    x2: 0.8,
    y2: 0.7,
    color: "#ff0000",
    thickness: "medium",
  },
  {
    id: 2,
    startFrame: 200,
    endFrame: 300,
    kind: "rect",
    x1: 0.2,
    y1: 0.3,
    x2: 0.6,
    y2: 0.8,
    color: "#00ff00",
    thickness: "thin",
    opacity: 0.5,
  },
];
`;

// ---------------------------------------------------------------------------
// parseInsertShapeData
// ---------------------------------------------------------------------------
describe('parseInsertShapeData', () => {
  it('shapeData 配列を読み取る', () => {
    const shapes = parseInsertShapeData(SOURCE);
    expect(shapes).toHaveLength(2);
    expect(shapes[0]).toMatchObject({
      id: 1,
      startFrame: 60,
      endFrame: 180,
      kind: 'arrow',
      x1: 0.1,
      y1: 0.2,
      x2: 0.8,
      y2: 0.7,
      color: '#ff0000',
      thickness: 'medium',
    });
    expect(shapes[0]?.opacity).toBeUndefined();
    expect(shapes[1]).toMatchObject({
      id: 2,
      opacity: 0.5,
    });
  });

  it('source が null なら空配列', () => {
    expect(parseInsertShapeData(null)).toEqual([]);
  });

  it('shapeData が配列でなければ throw する', () => {
    expect(() => parseInsertShapeData('export const shapeData = 5;')).toThrow(
      /shapeData 配列/,
    );
  });
});

// ---------------------------------------------------------------------------
// formatInsertShapeArray
// ---------------------------------------------------------------------------
describe('formatInsertShapeArray', () => {
  it('空配列は []', () => {
    expect(formatInsertShapeArray([])).toBe('[]');
  });

  it('必須フィールドをすべて出力する', () => {
    const shapes: ShapeSegment[] = [
      {
        id: 3,
        startFrame: 10,
        endFrame: 50,
        kind: 'line',
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 1,
        color: '#ffffff',
        thickness: 'thick',
      },
    ];
    const out = formatInsertShapeArray(shapes);
    expect(out).toContain('id: 3,');
    expect(out).toContain('startFrame: 10,');
    expect(out).toContain('endFrame: 50,');
    expect(out).toContain('kind: "line",');
    expect(out).toContain('x1: 0,');
    expect(out).toContain('y1: 0,');
    expect(out).toContain('x2: 1,');
    expect(out).toContain('y2: 1,');
    expect(out).toContain('color: "#ffffff",');
    expect(out).toContain('thickness: "thick",');
    // opacity 未指定なら出力しない
    expect(out).not.toContain('opacity');
  });

  it('opacity を指定したときは出力する', () => {
    const shapes: ShapeSegment[] = [
      {
        id: 4,
        startFrame: 0,
        endFrame: 60,
        kind: 'ellipse',
        x1: 0.1,
        y1: 0.1,
        x2: 0.9,
        y2: 0.9,
        color: '#0000ff',
        thickness: 'medium',
        opacity: 0.75,
      },
    ];
    const out = formatInsertShapeArray(shapes);
    expect(out).toContain('opacity: 0.75,');
  });

  it('color / kind / thickness は文字列としてクォートされる', () => {
    const shapes: ShapeSegment[] = [
      {
        id: 1,
        startFrame: 0,
        endFrame: 60,
        kind: 'rect',
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 1,
        color: '#abc',
        thickness: 'thin',
      },
    ];
    const out = formatInsertShapeArray(shapes);
    expect(out).toContain('kind: "rect",');
    expect(out).toContain('color: "#abc",');
    expect(out).toContain('thickness: "thin",');
  });

  it('originalStart / originalEnd を出力しない', () => {
    // EditorShape 由来の余分なフィールドを ShapeSegment キャストして渡しても出力しない
    const shape = {
      id: 5,
      startFrame: 0,
      endFrame: 30,
      kind: 'arrow' as const,
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      color: '#f00',
      thickness: 'thin' as const,
      originalStart: 0,
      originalEnd: 30,
    };
    const out = formatInsertShapeArray([shape as ShapeSegment]);
    expect(out).not.toContain('originalStart');
    expect(out).not.toContain('originalEnd');
  });
});

// ---------------------------------------------------------------------------
// serializeInsertShapeData
// ---------------------------------------------------------------------------
describe('serializeInsertShapeData', () => {
  it('配列リテラルだけ差し替えてヘッダを保つ', () => {
    const newShape: ShapeSegment = {
      id: 9,
      startFrame: 100,
      endFrame: 200,
      kind: 'rect',
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      color: '#123456',
      thickness: 'medium',
    };
    const out = serializeInsertShapeData(SOURCE, [newShape]);
    expect(out).not.toBeNull();
    expect(out).toContain("import type { ShapeSegment } from './types';");
    expect(out).toContain('// ==== 図形オーバーレイデータ ====');
    expect(out).toContain('id: 9,');
    expect(out).not.toContain('id: 1,');
    // round-trip
    const parsed = parseInsertShapeData(out!);
    expect(parsed).toEqual([newShape]);
  });

  it('source が null かつ配列が空なら null（ファイルを作らない）', () => {
    expect(serializeInsertShapeData(null, [])).toBeNull();
  });

  it('source が null かつ図形があれば新規雛形を生成する', () => {
    const shape: ShapeSegment = {
      id: 1,
      startFrame: 10,
      endFrame: 90,
      kind: 'line',
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      color: '#fff',
      thickness: 'thin',
    };
    const out = serializeInsertShapeData(null, [shape]);
    expect(out).not.toBeNull();
    expect(out).toContain('export const shapeData');
    expect(out).toContain("import type { ShapeSegment } from './types'");
    const parsed = parseInsertShapeData(out!);
    expect(parsed).toEqual([shape]);
  });

  it('既存ソース + 空配列なら shapeData 配列を [] にする', () => {
    const out = serializeInsertShapeData(SOURCE, []);
    expect(out).not.toBeNull();
    expect(parseInsertShapeData(out!)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// round-trip: format → parse の往復
// ---------------------------------------------------------------------------
describe('insertShapeData round-trip', () => {
  it('opacity あり・なし混在で往復する', () => {
    const shapes: ShapeSegment[] = [
      {
        id: 1,
        startFrame: 0,
        endFrame: 60,
        kind: 'arrow',
        x1: 0.1,
        y1: 0.2,
        x2: 0.9,
        y2: 0.8,
        color: '#ff0000',
        thickness: 'medium',
      },
      {
        id: 2,
        startFrame: 120,
        endFrame: 240,
        kind: 'ellipse',
        x1: 0,
        y1: 0,
        x2: 0.5,
        y2: 0.5,
        color: '#00ff00',
        thickness: 'thick',
        opacity: 0.3,
      },
    ];
    const src = `import type { ShapeSegment } from './types';\nexport const shapeData: ShapeSegment[] = ${formatInsertShapeArray(shapes)};\n`;
    const parsed = parseInsertShapeData(src);
    expect(parsed).toEqual(shapes);
  });
});
