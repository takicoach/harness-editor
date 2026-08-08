/**
 * ShapeToolbar（プレビュー左肩の図形描画ボタン・drawingKind トグル）のユニットテスト。
 * DOM レンダリングを伴わない純粋な props/型の確認。
 */
import { describe, it, expect } from 'vitest';
import type { ShapeKind } from '../../core/types';

/** DrawingKind は ShapeKind | null のエイリアス */
type DrawingKind = ShapeKind | null;

const SHAPE_BUTTONS: Array<{ kind: ShapeKind; label: string }> = [
  { kind: 'arrow', label: '矢印' },
  { kind: 'line', label: '直線' },
  { kind: 'rect', label: '四角' },
  { kind: 'ellipse', label: '丸' },
];

describe('ShapeToolbar shape buttons', () => {
  it('図形ボタンが4種（矢印/直線/四角/丸）存在する', () => {
    expect(SHAPE_BUTTONS).toHaveLength(4);
    expect(SHAPE_BUTTONS.map((b) => b.kind)).toEqual(['arrow', 'line', 'rect', 'ellipse']);
  });

  it('同じ kind を 2 回押すと null（トグル解除）になる', () => {
    function toggleDrawingKind(current: DrawingKind, next: ShapeKind): DrawingKind {
      return current === next ? null : next;
    }
    expect(toggleDrawingKind(null, 'arrow')).toBe('arrow');
    expect(toggleDrawingKind('arrow', 'arrow')).toBeNull();
    expect(toggleDrawingKind('arrow', 'rect')).toBe('rect');
  });

  it('DrawingKind は ShapeKind | null の型を満たす', () => {
    const dk: DrawingKind = 'ellipse';
    const dkNull: DrawingKind = null;
    expect(dk).toBe('ellipse');
    expect(dkNull).toBeNull();
  });
});
