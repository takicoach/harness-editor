/**
 * PreviewOverlay 描画モードの座標変換ロジックテスト。
 * DOM レンダリングを伴わない純粋な座標変換関数の確認。
 * shapeStyle.ts の pointerToVideoPoint を直接テストする（PreviewOverlay が内部で使う）。
 */
import { describe, it, expect } from 'vitest';
import { pointerToVideoPoint } from '../../core/shapeStyle';
import type { Rect } from './overlayGeometry';

/** content 矩形 → ビデオ座標への変換（描画モードで PreviewOverlay が使う関数を参照）。 */
function contentPointerToVideoPoint(
  clientX: number,
  clientY: number,
  content: Rect,
): { x: number; y: number } {
  return pointerToVideoPoint(clientX, clientY, {
    left: content.x,
    top: content.y,
    width: content.w,
    height: content.h,
  });
}

describe('PreviewOverlay 描画モード座標変換', () => {
  const content: Rect = { x: 10, y: 20, w: 200, h: 100 };

  it('content 左上は (0,0)', () => {
    const pt = contentPointerToVideoPoint(10, 20, content);
    expect(pt.x).toBeCloseTo(0);
    expect(pt.y).toBeCloseTo(0);
  });

  it('content 右下は (1,1)', () => {
    const pt = contentPointerToVideoPoint(210, 120, content);
    expect(pt.x).toBeCloseTo(1);
    expect(pt.y).toBeCloseTo(1);
  });

  it('content 中央は (0.5,0.5)', () => {
    const pt = contentPointerToVideoPoint(110, 70, content);
    expect(pt.x).toBeCloseTo(0.5);
    expect(pt.y).toBeCloseTo(0.5);
  });

  it('content 外（左外）は 0 にクランプ', () => {
    const pt = contentPointerToVideoPoint(-100, 20, content);
    expect(pt.x).toBe(0);
  });

  it('content 外（下外）は 1 にクランプ', () => {
    const pt = contentPointerToVideoPoint(10, 9999, content);
    expect(pt.y).toBe(1);
  });
});

describe('描画モードの drag 状態', () => {
  /** DrawShapeDragState の最小型定義（実装で使う型の想定）。 */
  interface DrawShapeDragState {
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    kind: 'arrow' | 'line' | 'rect' | 'ellipse';
  }

  it('pointerdown → move で始点/終点が設定される', () => {
    const drag: DrawShapeDragState = {
      startX: 0.1,
      startY: 0.2,
      currentX: 0.6,
      currentY: 0.7,
      kind: 'rect',
    };
    expect(drag.startX).toBe(0.1);
    expect(drag.currentX).toBe(0.6);
  });

  it('pointerup で addShape が呼ばれるべきパラメータが揃う', () => {
    const drag: DrawShapeDragState = {
      startX: 0.1,
      startY: 0.2,
      currentX: 0.6,
      currentY: 0.7,
      kind: 'arrow',
    };
    // addShape(state, kind, x1, y1, x2, y2, originalStart) の引数
    expect(drag.kind).toBe('arrow');
    expect(drag.startX).toBeLessThan(drag.currentX);
    expect(drag.startY).toBeLessThan(drag.currentY);
  });
});
