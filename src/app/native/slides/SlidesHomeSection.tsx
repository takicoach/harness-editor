import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../Icon';
import { createSlides, listSlides, type SlidesProjectSummary } from './slidesApi';
import './slides.css';

/** スライドの画面へ全ページ遷移する（テストでは差し替える）。 */
export function openSlidesPage(id: string): void { location.assign(`/?${new URLSearchParams({ slides: id })}`); }
/** ホームの「スライド」の欄。動画の案件とは別に並べ、ここから作って開く。 */
export function SlidesHomeSection({ open = openSlidesPage }: { open?: (id: string) => void }) {
  const [items, setItems] = useState<SlidesProjectSummary[] | null>(null), [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false), [name, setName] = useState(''), [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try { setItems(await listSlides()); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const create = async () => {
    setBusy(true);
    try { open((await createSlides(name.trim())).id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section className="slides-home" aria-label="スライド">
    <header className="slides-home-head">
      <h2>スライド</h2><span className="slides-home-count">{items ? `${items.length} 件` : ''}</span>
      <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>＋ スライドを作る</button>
    </header>
    {creating && <form className="slides-home-create" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label className="slides-home-label">スライドの名前
        <input className="slides-home-input" value={name} autoFocus maxLength={80} onChange={event => setName(event.target.value)} /></label>
      <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>作る</button>
      <button type="button" className="btn btn-ghost" onClick={() => { setCreating(false); setName(''); }}>やめる</button>
    </form>}
    {error && <p className="slides-home-error" role="alert">{error}</p>}
    {items && !items.length && !creating && <p className="slides-home-empty">台本からセミナー用のスライドを作れます。「＋ スライドを作る」から始めてください。</p>}
    {items && items.length > 0 && <ul className="slides-home-list">{items.map(item => <li key={item.id}>
      <button type="button" className="btn btn-secondary slides-home-card" aria-label={`${item.name}を開く`} onClick={() => open(item.id)}>
        <Icon name="layout-wide" size={28} /><strong>{item.name}</strong>
        <span>{item.status === 'broken' ? '壊れたファイルを保全しています（開いて直せます）' : `${item.pages} ページ`}</span>
      </button>
    </li>)}</ul>}
  </section>;
}
