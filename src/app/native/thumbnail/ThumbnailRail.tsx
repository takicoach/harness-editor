import { Icon, type IconName } from '../../Icon';

export type ThumbnailDrawerId = 'templates' | 'materials' | 'text' | 'import' | 'ai' | 'layers';
const ITEMS: ReadonlyArray<{ id: ThumbnailDrawerId; label: string; icon: IconName }> = [
  { id: 'templates', label: 'テンプレ', icon: 'layout-wide' },
  { id: 'materials', label: '素材', icon: 'shapes' },
  { id: 'text', label: 'テキスト', icon: 'type' },
  { id: 'import', label: '取り込み', icon: 'image' },
  { id: 'ai', label: 'AIで作る', icon: 'sparkles' },
  { id: 'layers', label: 'レイヤー', icon: 'rows' },
];
/** 左のアイコン列。押すと引き出しが 1 つだけ開く（同じものをもう一度押すと閉じる）。 */
export function ThumbnailRail({ open, onOpen }: { open: ThumbnailDrawerId | null; onOpen(id: ThumbnailDrawerId | null): void }) {
  return <nav className="native-thumbnail-rail" aria-label="サムネの道具">
    {ITEMS.map(item => <button key={item.id} type="button" className="btn-ghost native-thumbnail-rail-item" aria-pressed={open === item.id} aria-label={item.label} title={item.label}
      onClick={() => onOpen(open === item.id ? null : item.id)}><Icon name={item.icon} size={18} /><span aria-hidden="true">{item.label}</span></button>)}
  </nav>;
}
