import type { SequenceDocument } from '../../../core/sequence/model';
import { Icon } from '../../Icon';
import { ThumbnailImport } from './ThumbnailImport';
import { ThumbnailLayers } from './ThumbnailLayers';
import { ThumbnailMaterials } from './ThumbnailMaterials';
import type { ThumbnailDrawerId } from './ThumbnailRail';
import { ThumbnailTemplates } from './ThumbnailTemplates';
import { ThumbnailTextDrawer } from './ThumbnailTextDrawer';
import type { ThumbnailEditor } from './useThumbnailEditor';

const TITLE: Record<ThumbnailDrawerId, string> = { templates: 'テンプレ', materials: '素材', text: 'テキスト', import: '取り込み', ai: 'AI で作る', layers: 'レイヤー' };
export function ThumbnailDrawer({ open, editor, videoDocument, onClose }: { open: ThumbnailDrawerId | null; editor: ThumbnailEditor; videoDocument: SequenceDocument; onClose(): void }) {
  if (!open) return null;
  return <aside className="native-thumbnail-drawer" aria-label={TITLE[open]}>
    <header className="native-thumbnail-drawer-head"><strong>{TITLE[open]}</strong>
      <button type="button" className="btn-ghost native-header-icon" aria-label="引き出しを閉じる" title="引き出しを閉じる" onClick={onClose}><Icon name="x" /></button></header>
    {open === 'templates' && <ThumbnailTemplates editor={editor} />}
    {open === 'materials' && <ThumbnailMaterials editor={editor} videoDocument={videoDocument} />}
    {open === 'text' && <ThumbnailTextDrawer editor={editor} />}
    {open === 'import' && <ThumbnailImport editor={editor} />}
    {open === 'ai' && <p className="native-thumbnail-note">AI で素材を作る機能は準備中です。いまは「取り込み」の画像と、動画のコマを使ってください。案の作成や手直しは右の「AI に頼む」から頼めます。</p>}
    {open === 'layers' && <ThumbnailLayers editor={editor} />}
  </aside>;
}
