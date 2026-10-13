import { boxCorners, midpoint } from './canvasMath';
import type { ThumbnailEditor } from './useThumbnailEditor';

const CORNERS = ['corner-tl', 'corner-tr', 'corner-br', 'corner-bl'] as const;
/** 1 つだけ選んでいるときのハンドル。四隅＝縦横比を保って拡縮（文字は大きさが連動）、文字の左右＝文字枠の幅。 */
export function ThumbnailHandles({ editor }: { editor: ThumbnailEditor }) {
  const layer = editor.selected.length === 1 ? editor.page.layers.find(item => item.id === editor.selected[0]) : undefined;
  const box = layer ? editor.boxes.get(layer.id) : undefined;
  if (!layer || !box || layer.content.kind === 'gradient' || editor.editingText) return null;
  if (layer.locked) {
    const corner = boxCorners(box)[0]!;
    return <span className="native-thumbnail-lock-badge" style={{ left: corner.x * editor.scale, top: corner.y * editor.scale }}>ロック中</span>;
  }
  const corners = boxCorners(box), scale = editor.scale;
  const sides = layer.content.kind === 'text' ? [{ name: 'side-left', at: midpoint(corners[0]!, corners[3]!) }, { name: 'side-right', at: midpoint(corners[1]!, corners[2]!) }] : [];
  // 回転ハンドルは上辺の中央から、箱の外向きに画面で 28px 離して置く。
  const top = midpoint(corners[0]!, corners[1]!), angle = box.rotation * Math.PI / 180, reach = 28 / scale;
  // 上辺が画面の上端に近い（表示領域の余白 24px に食い込む）ときは、つまみを箱の内側へ逃がして掴めるようにする（小メニューと同じ考え方）。
  const inward = top.y * scale < 36 ? -1 : 1;
  const rotate = { x: top.x + Math.sin(angle) * reach * inward, y: top.y - Math.cos(angle) * reach * inward };
  return <>
    {corners.map((point, index) => <span key={CORNERS[index]} className="native-thumbnail-handle" data-handle={CORNERS[index]} aria-hidden="true" style={{ left: point.x * scale, top: point.y * scale }} />)}
    {sides.map(side => <span key={side.name} className="native-thumbnail-handle native-thumbnail-handle-side" data-handle={side.name} aria-hidden="true"
      style={{ left: side.at.x * scale, top: side.at.y * scale, transform: `translate(-50%, -50%) rotate(${box.rotation}deg)` }} />)}
    <span className="native-thumbnail-handle native-thumbnail-handle-rotate" data-handle="rotate" aria-hidden="true" title="回転（Shift で 15° 刻み）" style={{ left: rotate.x * scale, top: rotate.y * scale }} />
  </>;
}
