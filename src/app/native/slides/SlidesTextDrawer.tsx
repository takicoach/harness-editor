import { resolveSlideTheme } from '../../../core/slides/themes';
import type { ThumbnailEditor } from '../thumbnail/useThumbnailEditor';
import type { SlidesDrawerContext } from './SlidesDrawer';
import { slidesTextLayer, type SlidesTextKind } from './slidesLayerFactory';

const ITEMS: ReadonlyArray<{ kind: SlidesTextKind; label: string }> = [{ kind: 'heading', label: '見出しを足す' }, { kind: 'body', label: '本文を足す' }, { kind: 'bullets', label: '箇条書きを足す' }];
export function SlidesTextDrawer({ editor, context }: { editor: ThumbnailEditor; context: SlidesDrawerContext }) {
  const theme = resolveSlideTheme(context.document.theme);
  return <div className="native-thumbnail-drawer-list">
    {ITEMS.map(item => <button key={item.kind} type="button" className="btn-secondary native-thumbnail-wide" disabled={editor.disabled}
      onClick={() => void editor.addLayer(slidesTextLayer(editor.newLayerId(), item.kind, theme))}>{item.label}</button>)}
    <p className="native-thumbnail-note">文字はキャンバス上でダブルクリックすると、その場で直せます（日本語入力に対応）。数字や比較の目印も、文字と図形で作ると後から直せます。</p>
  </div>;
}
