import { useCallback, useState } from 'react';
import type { StageReserve } from './canvasMath';
import { ThumbnailCanvas } from './ThumbnailCanvas';
import { ThumbnailOverlay } from './ThumbnailOverlay';
import { ThumbnailPhonePreview } from './ThumbnailPhonePreview';
import type { ThumbnailEditor } from './useThumbnailEditor';
import type { ThumbnailPreviewImages } from './useThumbnailPreviews';

/** 中央の中身。キャンバスと重ね表示（選択・ハンドル・その場編集・小メニュー）、右下にスマホでの見え方の小窓（キャンバスとは重ねない）。 */
export function ThumbnailStage({ editor, previews, phoneOpen, onPhone }: { editor: ThumbnailEditor; previews: ThumbnailPreviewImages; phoneOpen: boolean; onPhone(open: boolean): void }) {
  const [reserve, setReserve] = useState<StageReserve | null>(null);
  const report = useCallback((next: StageReserve | null) => setReserve(previous =>
    previous && next && previous.width === next.width && previous.height === next.height ? previous : next), []);
  return <>
    <ThumbnailCanvas editor={editor} reserve={phoneOpen ? reserve : null}><ThumbnailOverlay editor={editor} /></ThumbnailCanvas>
    {phoneOpen && <ThumbnailPhonePreview editor={editor} previews={previews} onClose={() => onPhone(false)} onSize={report} />}
  </>;
}
