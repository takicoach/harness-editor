import { Icon, type IconName } from '../../Icon';

export type SlidesDrawerId = 'script' | 'layout' | 'materials' | 'text' | 'import' | 'layers';
/** 左のアイコン列（設計書の順: 台本から作る・レイアウト・素材・テキスト・取り込み・レイヤー）。引き出しができたものから並べる。 */
export const SLIDES_RAIL_ITEMS: ReadonlyArray<{ id: SlidesDrawerId; label: string; icon: IconName }> = [
  { id: 'script', label: '台本から作る', icon: 'script' },
  { id: 'layout', label: 'レイアウト', icon: 'layout-wide' },
  { id: 'materials', label: '素材', icon: 'shapes' },
  { id: 'text', label: 'テキスト', icon: 'type' },
  { id: 'import', label: '取り込み', icon: 'image' },
  { id: 'layers', label: 'レイヤー', icon: 'rows' },
];
/** 押すと引き出しが 1 つだけ開く（同じものをもう一度押すと閉じる）。 */
export function SlidesRail({ open, onOpen }: { open: SlidesDrawerId | null; onOpen(id: SlidesDrawerId | null): void }) {
  return <nav className="native-thumbnail-rail" aria-label="スライドの道具">
    {SLIDES_RAIL_ITEMS.map(item => <button key={item.id} type="button" className="btn-ghost native-thumbnail-rail-item" aria-pressed={open === item.id} aria-label={item.label} title={item.label}
      onClick={() => onOpen(open === item.id ? null : item.id)}><Icon name={item.icon} size={18} /><span aria-hidden="true">{item.label}</span></button>)}
  </nav>;
}
