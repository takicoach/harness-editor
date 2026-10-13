import { useState } from 'react';
import type { SlideDocument } from '../../../core/slides/model';
import { Icon } from '../../Icon';
import { BADGE_LABELS, pageStripItems } from './pageStrip';
import type { SlidesPreviewImages } from './useSlidesPreviews';
import type { SlidesSessionHook } from './useSlidesSession';

export interface SlidesPageStripProps {
  projectId: string; session: SlidesSessionHook; document: SlideDocument; pageId: string | null; onPage(pageId: string): void;
  previews: SlidesPreviewImages; grid: boolean; onGrid(open: boolean): void; onAddPage(): void;
}
/** 下のページの帯（縮小・番号・レイアウト名・印・＋・複製・削除・ドラッグで並べ替え）と、全ページを並べる格子表示。 */
export function SlidesPageStrip({ session, document, pageId, onPage, previews, grid, onGrid, onAddPage }: SlidesPageStripProps) {
  const [dragged, setDragged] = useState<string | null>(null), items = pageStripItems(document), index = document.pages.findIndex(page => page.id === pageId);
  const reorder = (id: string, to: number) => { if (document.pages.findIndex(page => page.id === id) !== to) void session.execute({ type: 'reorder-page', pageId: id, index: to }); };
  const duplicate = async () => {
    if (!pageId) return;
    const id = `p-${crypto.randomUUID()}`;
    if (await session.execute({ type: 'duplicate-page', pageId, newPageId: id })) onPage(id);
  };
  const remove = async () => {
    if (!pageId) return;
    const next = document.pages[index + 1] ?? document.pages[index - 1];
    if (await session.execute({ type: 'delete-pages', pageIds: [pageId] }) && next) onPage(next.id);
  };
  const list = <ol className={grid ? 'native-slides-grid' : 'native-slides-pages'} aria-label={grid ? '全ページ' : 'ページ'}>
    {items.map((item, at) => <li key={item.pageId} className="native-slides-page" data-current={item.pageId === pageId ? 'true' : undefined} draggable={!session.busy}
      onDragStart={event => { setDragged(item.pageId); event.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={event => event.preventDefault()}
      onDrop={event => { event.preventDefault(); if (dragged) reorder(dragged, at); setDragged(null); }}>
      <button type="button" className="btn-ghost native-slides-page-pick" aria-label={`${item.number} ページ（${item.layoutName}）`} aria-pressed={item.pageId === pageId} title={item.title}
        onClick={() => { onPage(item.pageId); if (grid) onGrid(false); }}>
        {previews.url(item.pageId) ? <img src={previews.url(item.pageId)!} alt="" /> : <span className="native-slides-page-empty" data-failed={previews.failure(item.pageId) ? 'true' : undefined} />}
      </button>
      {previews.failure(item.pageId) && !previews.url(item.pageId) && <button type="button" className="btn-ghost native-slides-page-retry" title={previews.failure(item.pageId)!} onClick={previews.retry}>撮り直す</button>}
      <span className="native-slides-page-foot"><span className="native-slides-page-number">{item.number}</span><span className="native-slides-page-layout">{item.layoutName}</span>
        {item.badges.map(badge => <span key={badge} className="native-slides-badge" data-badge={badge}>{BADGE_LABELS[badge]}</span>)}</span>
    </li>)}
  </ol>;
  return <section className="native-slides-strip" aria-label="ページの帯">
    <div className="native-slides-strip-actions">
      <button type="button" className="btn-ghost native-header-icon" aria-label="ページを足す" title="ページを足す（今のページの後ろ）" disabled={session.busy} onClick={onAddPage}><Icon name="plus" /></button>
      <button type="button" className="btn-ghost" disabled={!pageId || session.busy} onClick={() => void duplicate()}>複製</button>
      <button type="button" className="btn-ghost" disabled={!pageId || session.busy} onClick={() => void remove()}>削除</button>
      <button type="button" className="native-toggle" aria-pressed={grid} onClick={() => onGrid(!grid)}>全ページを並べる</button>
    </div>
    {grid ? <div className="native-slides-grid-sheet" role="dialog" aria-label="全ページを並べる">
      <header className="native-slides-row"><strong>全ページ（{items.length}）</strong>
        <button type="button" className="btn-ghost native-header-icon" aria-label="格子表示を閉じる" title="閉じる" onClick={() => onGrid(false)}><Icon name="x" /></button></header>
      {list}<p className="native-thumbnail-note">ドラッグで並べ替え、クリックでそのページへ移ります。</p>
    </div> : list}
  </section>;
}
