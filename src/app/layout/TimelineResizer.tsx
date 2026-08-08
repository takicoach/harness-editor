import { useTimelineHeight } from './useTimelineHeight';

/** タイムライン枠の上端に重なる水平リサイズハンドル。ドラッグで高さ調整、ダブルクリックでリセット。 */
export function TimelineResizer() {
  const { onResizeStart, onReset } = useTimelineHeight();
  return (
    <div
      className="tl-resizer"
      role="separator"
      aria-orientation="horizontal"
      title="ドラッグでタイムラインの高さを調整（ダブルクリックでリセット）"
      onPointerDown={onResizeStart}
      onDoubleClick={onReset}
    />
  );
}
