import type { SlideDocument, SlideLayoutId } from '../../../core/slides/model';
import { Icon } from '../../Icon';
import { SlidesImport } from './SlidesImport';
import { SlidesLayoutDrawer } from './SlidesLayoutDrawer';
import { SlidesMaterials } from './SlidesMaterials';
import { SlidesScriptDrawer } from './SlidesScriptDrawer';
import { SlidesTextDrawer } from './SlidesTextDrawer';
import type { SlidesAiAccess, SlidesRequestIntent } from './requestIntent';
import { ThumbnailLayers } from '../thumbnail/ThumbnailLayers';
import type { ThumbnailEditor } from '../thumbnail/useThumbnailEditor';
import type { SlidesDrawerId } from './SlidesRail';
import type { SlidesSessionHook } from './useSlidesSession';

export interface SlidesDrawerContext {
  projectId: string; session: SlidesSessionHook; document: SlideDocument; pageId: string | null;
  onPage(pageId: string): void; onToast(message: string): void; addPage(layout: SlideLayoutId, index?: number): Promise<void>;
  /** 貼り付けの経路（B10 でつなぐ）。 */
  paste?: (intent: SlidesRequestIntent) => void;
  /** AI の経路（B12 でつなぐ）。 */
  ai?: SlidesAiAccess;
}
const TITLE: Record<SlidesDrawerId, string> = { script: '台本から作る', layout: 'レイアウト', materials: '素材', text: 'テキスト', import: '取り込み', layers: 'レイヤー' };
/** 左の引き出し（1 つだけ開く）。キャンバスの部品を使う引き出しは、ページがあるとき（editor があるとき）だけ中身を出す。 */
export function SlidesDrawer({ open, onClose, editor, context }: { open: SlidesDrawerId | null; onClose(): void; editor: ThumbnailEditor | null; context: SlidesDrawerContext }) {
  if (!open) return null;
  const needsPage = <p className="native-thumbnail-note">先にページを足してください（下の「＋」か「台本から作る」）。</p>;
  return <aside className="native-thumbnail-drawer" data-wide={open === 'script' ? 'true' : undefined} aria-label={TITLE[open]}>
    <header className="native-thumbnail-drawer-head"><strong>{TITLE[open]}</strong>
      <button type="button" className="btn-ghost native-header-icon" aria-label="引き出しを閉じる" title="引き出しを閉じる" onClick={onClose}><Icon name="x" /></button></header>
    {open === 'layers' && (editor ? <ThumbnailLayers editor={editor} /> : needsPage)}
    {open === 'layout' && <SlidesLayoutDrawer context={context} />}
    {open === 'materials' && (editor ? <SlidesMaterials editor={editor} context={context} /> : needsPage)}
    {open === 'text' && (editor ? <SlidesTextDrawer editor={editor} context={context} /> : needsPage)}
    {open === 'import' && (editor ? <SlidesImport editor={editor} context={context} /> : needsPage)}
    {open === 'script' && <SlidesScriptDrawer context={context} />}
    {/* ここに引き出しの中身を足す */}
  </aside>;
}
