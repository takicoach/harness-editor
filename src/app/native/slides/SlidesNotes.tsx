import { useCallback, useEffect, useRef, useState } from 'react';
import { SLIDES_MAX_NOTES_CHARS, type SlidePage } from '../../../core/slides/model';
import type { SlidesSessionHook } from './useSlidesSession';

const KEY = 'slides-notes-open';
export function readNotesOpen(): boolean { try { return localStorage.getItem(KEY) !== '0'; } catch { return true; } }
export function writeNotesOpen(open: boolean): void { try { localStorage.setItem(KEY, open ? '1' : '0'); } catch { /* 保存できなくても動く */ } }
/** キャンバスの下の「話すメモ」。止まって 1 秒・欄を離れた・保存の前に確定する（日本語の変換中は確定しない）。 */
export function SlidesNotes({ page, session, flushers, open, onOpen }: { page: SlidePage; session: SlidesSessionHook; flushers: Set<() => Promise<boolean>>; open: boolean; onOpen(open: boolean): void }) {
  const [draft, setDraftState] = useState(page.notes), draftRef = useRef(page.notes), committed = useRef(page.notes), composing = useRef(false);
  const setDraft = (value: string) => { draftRef.current = value; setDraftState(value); };
  // ページが替わったら、そのページのメモにする。
  useEffect(() => { setDraft(page.notes); committed.current = page.notes; }, [page.id]);
  // 確定した値が届いたとき、まだ確定していない入力が無ければ合わせる（入力中の文字は上書きしない）。
  useEffect(() => { if (draftRef.current === committed.current) setDraft(page.notes); committed.current = page.notes; }, [page.notes]);
  const commit = useCallback(async (): Promise<boolean> => {
    const value = draftRef.current;
    if (value === committed.current) return true;
    const ok = await session.execute({ type: 'set-notes', pageId: page.id, notes: value });
    if (ok) committed.current = value;
    return ok;
  }, [session.execute, page.id]);
  useEffect(() => { flushers.add(commit); return () => { flushers.delete(commit); }; }, [flushers, commit]);
  useEffect(() => {
    if (draft === committed.current || composing.current) return;
    const timer = setTimeout(() => void commit(), 1000);
    return () => clearTimeout(timer);
  }, [draft, commit]);
  return <section className="native-slides-notes" data-open={open ? 'true' : 'false'}>
    <header className="native-slides-row">
      <button type="button" className="native-toggle" aria-pressed={open} aria-expanded={open} onClick={() => { onOpen(!open); writeNotesOpen(!open); }}>話すメモ</button>
      {open && <span className="native-slides-notes-count">{draft.length} / {SLIDES_MAX_NOTES_CHARS}</span>}
    </header>
    {open && <textarea className="native-slides-notes-input" aria-label="話すメモ" value={draft} maxLength={SLIDES_MAX_NOTES_CHARS} placeholder="このページで話すことを書きます（PDF のメモ付きにも入ります）"
      onChange={event => setDraft(event.target.value)} onBlur={() => void commit()}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />}
  </section>;
}
