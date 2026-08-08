import type { ShapeKind } from '../../core/types';
import type { DrawingKind } from './PreviewOverlay';

const TOOLS: Array<{ kind: ShapeKind; label: string; d: string }> = [
  { kind: 'arrow', label: '矢印', d: 'M4 20L20 4M20 4h-7M20 4v7' },
  { kind: 'line', label: '直線', d: 'M4 20L20 4' },
  { kind: 'rect', label: '四角', d: 'M4 6h16v12H4z' },
  { kind: 'ellipse', label: '丸', d: 'M12 4a8 6 0 1 0 0 12 8 6 0 0 0 0-12z' },
];

interface ShapeToolbarProps {
  /**
   * 現状は常に true で呼ばれる: Preview はプロジェクトが開いている時（open.status==='ready'）
   * しかマウントされないため、未選択の disabled 状態は構造的に到達しない。
   * Preview を無条件レンダーするよう変えた場合は、この props に実状態を配線し直すこと。
   */
  active: boolean;
  drawingKind: DrawingKind;
  onDrawingKindChange: (v: DrawingKind) => void;
}

/** プレビュー左肩の図形描画ツール（矢印/直線/四角/丸）。選択中はアクセント塗り。 */
export function ShapeToolbar({ active, drawingKind, onDrawingKindChange }: ShapeToolbarProps) {
  return (
    <div className="pv-shapes" role="group" aria-label="図形を描く">
      <span className="pv-shapes-label" aria-hidden="true">図形</span>
      {TOOLS.map((t) => (
        <button
          key={t.kind}
          type="button"
          className={'pv-shape-btn' + (drawingKind === t.kind ? ' active' : '')}
          data-kind={t.kind}
          title={`${t.label}を描画（クリックで解除）`}
          aria-pressed={drawingKind === t.kind}
          disabled={!active}
          onClick={() => onDrawingKindChange(drawingKind === t.kind ? null : t.kind)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d={t.d} />
          </svg>
        </button>
      ))}
    </div>
  );
}
