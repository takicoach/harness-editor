import { SlidesContextBar } from './SlidesContextBar';
import { ThumbnailOverlay } from '../thumbnail/ThumbnailOverlay';
import type { ThumbnailEditor } from '../thumbnail/useThumbnailEditor';
import { SlidesCanvas } from './SlidesCanvas';

/** 中央: 選んだ物の道具の帯・キャンバス・重ね表示（選択・ハンドル・その場の文字編集・小メニュー）。 */
export function SlidesStage({ editor }: { editor: ThumbnailEditor }) {
  return <section className="native-thumbnail-stage" aria-label="キャンバス">
    <SlidesContextBar editor={editor} />
    <SlidesCanvas editor={editor}><ThumbnailOverlay editor={editor} /></SlidesCanvas>
  </section>;
}
