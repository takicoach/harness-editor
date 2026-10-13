import { useRef, useState } from 'react';
import { TaskProgress } from '../../components/TaskProgress';
import { hasPhoto, imageLayerOf } from './layerFactory';
import type { ThumbnailEditor } from './useThumbnailEditor';

/** 画像ファイルを開く、またはドロップする。最初の 1 枚は背景の写真（最背面・全面）、2 枚目からは画像素材。 */
export function ThumbnailImport({ editor }: { editor: ThumbnailEditor }) {
  const input = useRef<HTMLInputElement>(null), [dragging, setDragging] = useState(false), [busy, setBusy] = useState(false);
  const take = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const assetId = await editor.session.uploadImage(file);
      if (!assetId) return;
      const photo = !hasPhoto(editor.page);
      await editor.addLayer(imageLayerOf(editor.newLayerId(), file.name, assetId, photo ? 'photo' : 'element'), photo ? 0 : undefined);
    } finally { setBusy(false); }
  };
  return <div className="native-thumbnail-drop" data-dragging={dragging ? 'true' : undefined}
    onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
    onDrop={event => { event.preventDefault(); setDragging(false); void take(event.dataTransfer.files); }}>
    <p className="native-thumbnail-note">画像ファイル（PNG・JPEG・WebP など）をここへドロップ</p>
    <button type="button" className="btn-tonal" disabled={editor.disabled || busy} onClick={() => input.current?.click()}>画像を開く</button>
    <input ref={input} type="file" hidden aria-label="取り込む画像" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp"
      onChange={event => { void take(event.target.files); event.target.value = ''; }} />
    {busy && <TaskProgress label="取り込んでいます…" compact />}
  </div>;
}
