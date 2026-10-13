import { useRef, useState } from 'react';
import { SLIDE_LAYOUTS } from '../../../core/slides/layouts';
import { TaskProgress } from '../../components/TaskProgress';
import { imageLayerOf } from '../thumbnail/layerFactory';
import type { ThumbnailEditor } from '../thumbnail/useThumbnailEditor';
import type { SlidesDrawerContext } from './SlidesDrawer';

/** 画像ファイルを開く・ドロップする。今のページに画像枠があれば枠へ入れ、無ければ挿絵として中央に置く。差し替えはキャンバスで画像を選んで「置き換え」。 */
export function SlidesImport({ editor, context }: { editor: ThumbnailEditor; context: SlidesDrawerContext }) {
  const input = useRef<HTMLInputElement>(null), [dragging, setDragging] = useState(false), [busy, setBusy] = useState(false);
  const page = context.document.pages.find(item => item.id === context.pageId), slot = page ? SLIDE_LAYOUTS[page.layout].imageSlots[0] : undefined;
  const take = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const assetId = await context.session.uploadImage(file);
      if (!assetId) return;
      if (page && slot) await context.session.execute({ type: 'fill-image-slot', pageId: page.id, slot, assetId });
      else await editor.addLayer(imageLayerOf(editor.newLayerId(), file.name, assetId, 'element'));
    } finally { setBusy(false); }
  };
  return <div className="native-thumbnail-drop" data-dragging={dragging ? 'true' : undefined}
    onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
    onDrop={event => { event.preventDefault(); setDragging(false); void take(event.dataTransfer.files); }}>
    <p className="native-thumbnail-note">{slot ? 'このページの画像枠に入ります。' : 'このページには画像枠が無いので、挿絵として中央に置きます。'}画像ファイル（PNG・JPEG・WebP など）をここへドロップ</p>
    <button type="button" className="btn-tonal" disabled={editor.disabled || busy} onClick={() => input.current?.click()}>画像を開く</button>
    <input ref={input} type="file" hidden aria-label="取り込む画像" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp"
      onChange={event => { void take(event.target.files); event.target.value = ''; }} />
    {busy && <TaskProgress label="取り込んでいます…" compact />}
  </div>;
}
