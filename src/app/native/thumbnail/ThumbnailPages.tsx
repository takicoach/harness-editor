import { useState } from 'react';
import { nextPageName, THUMBNAIL_MAX_PAGES, thumbnailMainPageId, type ThumbnailPage } from '../../../core/thumbnail/model';
import { Icon } from '../../Icon';
import type { ThumbnailExportHook } from './useThumbnailExport';
import type { ThumbnailPreviewImages } from './useThumbnailPreviews';
import type { ThumbnailEditor } from './useThumbnailEditor';

const ZOOMS = [25, 50, 75, 100, 150, 200] as const;
function PageName({ editor, page }: { editor: ThumbnailEditor; page: ThumbnailPage }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(page.name);
  const finish = (commit: boolean) => {
    setEditing(false);
    const name = draft.trim().slice(0, 40);
    if (commit && name && name !== page.name) void editor.execute({ type: 'rename-page', pageId: page.id, name }); else setDraft(page.name);
  };
  if (editing) return <input className="native-thumbnail-page-input" aria-label="案の名前" value={draft} autoFocus onChange={event => setDraft(event.target.value)} onBlur={() => finish(true)}
    onKeyDown={event => { event.stopPropagation(); if (event.nativeEvent.isComposing) return; if (event.key === 'Enter') finish(true); else if (event.key === 'Escape') finish(false); }} />;
  return <span className="native-thumbnail-page-name" title="ダブルクリックで名前を変える" onDoubleClick={() => { if (!editor.disabled) { setDraft(page.name); setEditing(true); } }}>{page.name}</span>;
}
/**
 * 案の一覧（最大 3。複製で増やす。YouTube の「テストと比較」の候補）、メインの案の印と切り替え、＋案を追加、すべての案を書き出す、
 * スマホでの見え方の開け閉め、表示倍率、全体表示。
 */
export function ThumbnailPages({ editor, exporter, previews, phoneOpen, onPhone }: {
  editor: ThumbnailEditor; exporter: ThumbnailExportHook; previews: ThumbnailPreviewImages; phoneOpen: boolean; onPhone(open: boolean): void;
}) {
  const { document } = editor, full = document.pages.length >= THUMBNAIL_MAX_PAGES, [dragged, setDragged] = useState<string | null>(null), mainId = thumbnailMainPageId(document);
  const add = async (duplicate: boolean) => {
    const pageId = `page-${crypto.randomUUID()}`;
    if (await editor.execute({ type: 'add-page', pageId, name: nextPageName(document), ...(duplicate ? { duplicateOf: editor.pageId } : {}) })) editor.selectPage(pageId);
  };
  return <footer className="native-thumbnail-bottom">
    <ol className="native-thumbnail-pages" aria-label="案">
      {document.pages.map((item, index) => <li key={item.id} className="native-thumbnail-page" data-current={item.id === editor.pageId ? 'true' : undefined} draggable={!editor.disabled}
        onDragStart={event => { setDragged(item.id); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={event => event.preventDefault()}
        onDrop={event => { event.preventDefault(); if (dragged && dragged !== item.id) void editor.execute({ type: 'reorder-page', pageId: dragged, index }); setDragged(null); }}>
        <button type="button" className="btn-ghost native-thumbnail-page-pick" aria-pressed={item.id === editor.pageId} aria-label={`${item.name}を開く`} onClick={() => editor.selectPage(item.id)}
          style={{ aspectRatio: `${document.canvas.width} / ${document.canvas.height}` }}>
          {previews.url(item.id) ? <img src={previews.url(item.id)!} alt="" /> : <span className="native-thumbnail-page-empty" aria-hidden="true" />}
        </button>
        <div className="native-thumbnail-page-foot"><PageName editor={editor} page={item} />
          <button type="button" className="btn-ghost native-header-icon" aria-label={`${item.name}を削除`} title={`${item.name}を削除`} disabled={document.pages.length <= 1 || editor.disabled}
            onClick={() => void editor.execute({ type: 'delete-page', pageId: item.id })}><Icon name="trash" /></button></div>
        <div className="native-thumbnail-page-role">{item.id === mainId
          ? <span className="native-thumbnail-page-main" title="書き出すと「案件名 サムネ」になり、プロジェクトのカードの画像になります">メイン</span>
          : <button type="button" className="btn-ghost native-thumbnail-page-set-main" aria-label={`${item.name}をメインにする`} disabled={editor.disabled}
            title="この案をメインにします（書き出しの名前とプロジェクトのカードの画像に使います）" onClick={() => void editor.execute({ type: 'set-main-page', pageId: item.id })}>メインにする</button>}</div>
      </li>)}
    </ol>
    <div className="native-thumbnail-page-actions">
      <button type="button" className="btn-tonal" disabled={full || editor.disabled} title={full ? '案は 3 つまでです' : '今の案を複製して増やします'} onClick={() => void add(true)}>＋ 案を追加</button>
      <button type="button" className="btn-ghost" disabled={full || editor.disabled} onClick={() => void add(false)}>空の案</button>
      <button type="button" className="btn-secondary" disabled={exporter.running || editor.disabled} title="案ごとに 1 枚ずつ PNG で書き出します（同じ名前は上書き）"
        onClick={() => void exporter.startAll()}>すべての案を書き出す</button>
    </div>
    <div className="native-thumbnail-view-actions">
      <button type="button" className="native-toggle native-thumbnail-phone-toggle" aria-pressed={phoneOpen} title={phoneOpen ? 'スマホでの見え方を閉じる' : 'スマホでの見え方を出す'}
        onClick={() => onPhone(!phoneOpen)}>スマホでの見え方</button>
      <div className="native-thumbnail-zoom" role="group" aria-label="表示倍率">
        <button type="button" className="native-toggle" aria-pressed={editor.zoom === 'fit'} onClick={() => editor.setZoom('fit')}>全体表示</button>
        <select aria-label="倍率" value={editor.zoom === 'fit' ? '' : String(Math.round(editor.zoom * 100))} onChange={event => editor.setZoom(Number(event.target.value) / 100)}>
          <option value="" disabled>{Math.round(editor.scale * 100)}%</option>
          {ZOOMS.map(zoom => <option key={zoom} value={zoom}>{zoom}%</option>)}
        </select>
      </div>
    </div>
  </footer>;
}
