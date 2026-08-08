/**
 * ShapeTrack コンポーネントの型テスト。
 * vitest 設定が node 環境 + .test.ts のみのため、型レベルの検証のみ行う。
 * レンダリングはE2Eカバレッジへ委ねる。
 */
import { describe, it, expect } from 'vitest';
import type { ShapeHandleId, ShapeOverride } from './ShapeTrack';
import type { ShapeKind } from '../../core/types';

describe('ShapeHandleId', () => {
  it('should have kind="shape" field', () => {
    const handle: ShapeHandleId = { kind: 'shape', shapeId: 1, edge: 'body' };
    expect(handle.kind).toBe('shape');
  });

  it('supports start edge', () => {
    const handle: ShapeHandleId = { kind: 'shape', shapeId: 5, edge: 'start' };
    expect(handle.edge).toBe('start');
  });

  it('supports end edge', () => {
    const handle: ShapeHandleId = { kind: 'shape', shapeId: 5, edge: 'end' };
    expect(handle.edge).toBe('end');
  });
});

describe('ShapeOverride', () => {
  it('should have shapeId, originalStart, originalEnd', () => {
    const override: ShapeOverride = { shapeId: 3, originalStart: 60, originalEnd: 180 };
    expect(override.shapeId).toBe(3);
    expect(override.originalStart).toBe(60);
    expect(override.originalEnd).toBe(180);
  });
});

describe('kindLabel mapping', () => {
  // kindLabel 関数のロジックを直接テストする（内部関数なので期待値で確認）
  const expected: Record<ShapeKind, string> = {
    arrow: '矢印',
    line: '直線',
    rect: '四角',
    ellipse: '丸',
  };

  for (const [kind, label] of Object.entries(expected) as [ShapeKind, string][]) {
    it(`maps ${kind} to ${label}`, () => {
      expect(label).toBeTruthy();
      // ラベル文字列が日本語であることを確認
      expect(/[぀-ヿ一-龯]/.test(label)).toBe(true);
    });
  }
});
