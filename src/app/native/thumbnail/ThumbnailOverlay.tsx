import { useRef } from 'react';
import { ThumbnailGuides } from './ThumbnailGuides';
import { ThumbnailHandles } from './ThumbnailHandles';
import { ThumbnailSelection } from './ThumbnailSelection';
import { ThumbnailMiniMenu } from './ThumbnailMiniMenu';
import { ThumbnailTextEditor } from './ThumbnailTextEditor';
import { useCanvasGestures } from './useCanvasGestures';
import type { ThumbnailEditor } from './useThumbnailEditor';

/** キャンバスの上の重ね表示。iframe は操作を受けないので、選択・移動・ハンドルはここで受ける。 */
export function ThumbnailOverlay({ editor }: { editor: ThumbnailEditor }) {
  const surface = useRef<HTMLDivElement>(null), gestures = useCanvasGestures(editor, surface);
  return <div ref={surface} className="native-thumbnail-overlay" onPointerDown={gestures.onPointerDown} onDoubleClick={gestures.onDoubleClick}>
    <ThumbnailSelection editor={editor} />
    <ThumbnailHandles editor={editor} />
    <ThumbnailGuides guides={gestures.guides} scale={editor.scale} canvas={editor.document.canvas} />
    <ThumbnailTextEditor editor={editor} />
    <ThumbnailMiniMenu editor={editor} />
  </div>;
}
