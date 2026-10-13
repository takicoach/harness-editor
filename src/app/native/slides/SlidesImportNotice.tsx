import { useCallback, useEffect, useState } from 'react';
import type { SlideImportRecord } from '../../../core/slides/videoImport';
import { fetchJson, putJsonPost } from '../../fetchJson';
import type { NativeSession } from '../api';
import './slides.css';

export interface SlidesImportNoticeProps {
  projectId: string; frame: number; busy: boolean;
  read(): NativeSession | null; accept(value: NativeSession): void;
}
/**
 * 動画の画面に出す、スライドから届いた画像の案内。「末尾に置く」「再生位置に置く」で、`/api/slides-imports/place` が
 * 素材の登録と新しいトラックへの並べを 1 つの型付きの操作（batch）として動画の編集状態に入れ（元に戻せる）、置いた記録を残す。
 * 動画の保存中枢には触れず、返ってきた編集状態を受け取るだけ。
 */
export function SlidesImportNotice({ projectId, frame, busy, read, accept }: SlidesImportNoticeProps) {
  const [imports, setImports] = useState<SlideImportRecord[]>([]), [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const [working, setWorking] = useState(false), [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const body = await fetchJson<{ imports: SlideImportRecord[] }>(`/api/slides-imports?${new URLSearchParams({ id: projectId })}`); setImports(body.imports.filter(item => !item.placed)); }
    catch { /* 届いた画像の一覧が読めなくても、動画の編集は止めない */ }
  }, [projectId]);
  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);
  const record = imports.find(item => !later.has(item.importId));
  if (!record) return null;
  const place = async (where: 'end' | 'playhead') => {
    setWorking(true); setError(null);
    try {
      const current = read();
      if (!current) throw new Error('動画の編集データがありません');
      const at = where === 'end' ? current.document.sequenceEndFrame : Math.max(0, Math.round(frame));
      const placed = await putJsonPost<{ record: SlideImportRecord; state: NativeSession }>(`/api/slides-imports/place?${new URLSearchParams({ id: projectId })}`,
        { importId: record.importId, sessionId: current.sessionId, expectedRevision: current.document.revision, executionId: crypto.randomUUID(), at });
      accept(placed.state);
      setImports(list => list.filter(item => item.importId !== record.importId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWorking(false); }
  };
  return <div className="native-notice native-slides-import-notice" role="status">
    <span>スライド「{record.slides.projectId}」から {record.pages.length} ページの画像が届いています（スライドの版 {record.slides.revision}）。置くと新しいトラック「スライド」に 1 枚 5 秒で並びます。</span>
    <span className="native-slides-row">
      <button type="button" className="btn-primary" disabled={busy || working} onClick={() => void place('end')}>末尾に置く</button>
      <button type="button" className="btn-secondary" disabled={busy || working} onClick={() => void place('playhead')}>再生位置に置く</button>
      <button type="button" className="btn-ghost" disabled={working} onClick={() => setLater(previous => new Set([...previous, record.importId]))}>あとで</button>
    </span>
    {error && <span className="native-slides-dialog-error" role="alert">{error}</span>}
  </div>;
}
