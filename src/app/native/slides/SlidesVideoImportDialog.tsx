import { useEffect, useState } from 'react';
import type { SlideDocument } from '../../../core/slides/model';
import type { SlideImportRecord } from '../../../core/slides/videoImport';
import type { ProjectSummary } from '../../../shared/types';
import { fetchJson } from '../../fetchJson';
import { Icon } from '../../Icon';
import { pageStripItems } from './pageStrip';
import { slidesRequest } from './slidesApi';
import type { SlidesSessionHook } from './useSlidesSession';

/** 動画案件への取り込み（スライド側）。選んだページを、保存した確定版の画像として動画案件の素材に届ける。置くのは動画の画面で選ぶ。 */
export function SlidesVideoImportDialog({ projectId, session, document, pageId, onSave, onClose }: {
  projectId: string; session: SlidesSessionHook; document: SlideDocument; pageId: string | null; onSave(): Promise<boolean>; onClose(): void;
}) {
  const [videos, setVideos] = useState<ProjectSummary[] | null>(null), [video, setVideo] = useState(''), [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(document.pages.map(page => page.id)));
  const [busy, setBusy] = useState(false), [done, setDone] = useState<SlideImportRecord | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchJson<{ projects: ProjectSummary[] }>('/api/projects', { signal: controller.signal })
      .then(body => { setVideos(body.projects); setVideo(current => current || body.projects[0]?.id || ''); })
      .catch(cause => { if (!controller.signal.aborted) setError(`動画案件の一覧を読み込めませんでした（${cause instanceof Error ? cause.message : String(cause)}）`); });
    return () => controller.abort();
  }, []);
  const items = pageStripItems(document), ordered = document.pages.filter(page => selected.has(page.id)).map(page => page.id);
  const toggle = (id: string) => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const start = async () => {
    setBusy(true); setError(null); setDone(null);
    try {
      if (session.readCurrent()?.dirty && !await onSave()) throw new Error('保存できなかったので、取り込みを止めました');
      const current = session.readCurrent();
      if (!current) throw new Error('スライドの編集データがありません');
      setDone(await slidesRequest<SlideImportRecord>(projectId, '/video-import', { sessionId: current.sessionId, videoProjectId: video, pageIds: ordered }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const name = videos?.find(item => item.id === video)?.name ?? video;
  return <div className="native-slides-dialog" role="dialog" aria-label="動画案件に取り込む">
    <header className="native-slides-dialog-head"><strong>動画案件に取り込む</strong>
      <button type="button" className="btn-ghost native-header-icon" aria-label="閉じる" title="閉じる" onClick={onClose}><Icon name="x" /></button></header>
    <p className="native-thumbnail-note">選んだページを、今の確定版（保存した内容）の画像として動画案件の素材に入れます。あとでスライドを直しても、取り込んだ画像は変わりません。動画の画面で「末尾に置く」か「再生位置に置く」を選ぶと、新しいトラック「スライド」に 1 枚 5 秒で並びます（長さは動画側で直します）。</p>
    <label className="native-slides-field"><span>取り込み先の動画案件</span>
      <select className="native-thumbnail-select" aria-label="取り込み先の動画案件" value={video} disabled={busy || !videos?.length} onChange={event => setVideo(event.target.value)}>
        {videos?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
    {videos && !videos.length && <p className="native-thumbnail-note">動画案件がありません。ホームで動画案件を作ってから取り込んでください。</p>}
    <div className="native-slides-row">
      <button type="button" className="btn-ghost" disabled={busy} onClick={() => setSelected(new Set(document.pages.map(page => page.id)))}>すべて選ぶ</button>
      <button type="button" className="btn-ghost" disabled={busy || !pageId} onClick={() => setSelected(new Set(pageId ? [pageId] : []))}>今のページだけ</button>
    </div>
    <ul className="native-slides-import-pages" aria-label="取り込むページ">
      {items.map(item => <li key={item.pageId}><label><input type="checkbox" checked={selected.has(item.pageId)} disabled={busy} onChange={() => toggle(item.pageId)} />{item.number}. {item.title || item.layoutName}</label></li>)}
    </ul>
    <div className="native-slides-row">
      <button type="button" className="btn-primary" disabled={busy || !video || !ordered.length} onClick={() => void start()}>{ordered.length} ページを取り込む</button>
    </div>
    {done && <p className="native-slides-export-status" data-phase="complete" role="status">動画案件「{name}」に {done.pages.length} ページの画像を届けました（スライドの版 {done.slides.revision}）。動画の画面を開くと、置き場所を選べます。</p>}
    {error && <p className="native-slides-dialog-error" role="alert">{error}</p>}
  </div>;
}
