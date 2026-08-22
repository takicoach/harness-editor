import type { EditorTelop } from '../../core/types';
import { telopsAtFrame } from '../../core/segmentOps';
import { telopBoxRect, type Rect } from './overlayGeometry';

/**
 * 現在の原本フレームで可視のテロップを、表示 box 矩形付きで入力順に返す。
 * プレビュー上クリック選択のヒット領域描画に使う（z 上位＝配列の後ろは DOM 重なり順で表現）。
 *
 * @param bottomOffset TELOP_CONFIG.bottomOffset（px）。当たり判定の枠アンカーを実描画位置へ
 *   合わせる（省略・null なら標準値）。詳細は {@link telopBoxRect}。
 */
export function visibleTelopBoxes(
  telops: EditorTelop[],
  originalFrame: number,
  content: Rect,
  compW: number,
  compH: number,
  bottomOffset?: number | null,
): { id: number; rect: Rect }[] {
  return telopsAtFrame(telops, originalFrame).map((t) => ({
    id: t.id,
    rect: telopBoxRect(
      content,
      t.position ?? { x: 0, y: 0 },
      t.scale ?? 1,
      compW,
      compH,
      bottomOffset,
    ),
  }));
}
