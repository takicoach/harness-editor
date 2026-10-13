import type { ThumbnailCanvas } from '../../../core/thumbnail/model';

/** 吸着した線（キャンバス全体を通す）。 */
export function ThumbnailGuides({ guides, scale, canvas }: { guides: { x: number[]; y: number[] }; scale: number; canvas: ThumbnailCanvas }) {
  return <>
    {guides.x.map(x => <span key={`x-${x}`} className="native-thumbnail-guide" aria-hidden="true" style={{ left: x * scale, top: 0, width: 1, height: canvas.height * scale }} />)}
    {guides.y.map(y => <span key={`y-${y}`} className="native-thumbnail-guide" aria-hidden="true" style={{ left: 0, top: y * scale, width: canvas.width * scale, height: 1 }} />)}
  </>;
}
