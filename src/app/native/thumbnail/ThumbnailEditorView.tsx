import { useEffect, useState } from 'react';
import type { SequenceDocument } from '../../../core/sequence/model';
import type { ThumbnailDocument } from '../../../core/thumbnail/model';
import { Icon } from '../../Icon';
import { ThumbnailAiPanel, ThumbnailAiShortcut } from './ThumbnailAiPanel';
import { ThumbnailContextBar } from './ThumbnailContextBar';
import { thumbnailRequest } from './thumbnailApi';
import { ThumbnailDrawer } from './ThumbnailDrawer';
import { ThumbnailKnobsPanel } from './ThumbnailKnobsPanel';
import { ThumbnailPages } from './ThumbnailPages';
import { readPhoneOpen, writePhoneOpen } from './ThumbnailPhonePreview';
import { ThumbnailStage } from './ThumbnailStage';
import { ThumbnailRail, type ThumbnailDrawerId } from './ThumbnailRail';
import { useCanvasKeys } from './useCanvasKeys';
import { useThumbnailAi } from './useThumbnailAi';
import { useThumbnailEditor } from './useThumbnailEditor';
import type { ThumbnailExportHook } from './useThumbnailExport';
import { useThumbnailPreviews } from './useThumbnailPreviews';
import type { ThumbnailSessionHook } from './useThumbnailSession';

export interface ThumbnailEditorViewProps {
  projectId: string; session: ThumbnailSessionHook; document: ThumbnailDocument; videoDocument: SequenceDocument; exporter: ThumbnailExportHook;
  pageId: string | null; onPage(pageId: string): void; onToast(message: string): void; flushers: Set<() => Promise<boolean>>;
  /** 右端の AI の列を開く（「AI に頼む」欄から）。 */
  onOpenAi(): void;
}
/** A 案: 左（アイコン列＋引き出し）・中央（キャンバス）・右（つまみ）・下（案）。 */
export function ThumbnailEditorView({ projectId, session, document, videoDocument, exporter, pageId, onPage, onToast, flushers, onOpenAi }: ThumbnailEditorViewProps) {
  const [drawer, setDrawer] = useState<ThumbnailDrawerId | null>('text'), [knobsOpen, setKnobsOpen] = useState(true);
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(() => new Set());
  // スマホでの見え方の小窓の開閉（閉じたことは覚える）。下の帯の「スマホでの見え方」でも開け閉めする。
  const [phoneOpen, setPhoneOpen] = useState(readPhoneOpen), changePhone = (open: boolean) => { setPhoneOpen(open); writePhoneOpen(open); };
  const current = pageId && document.pages.some(page => page.id === pageId) ? pageId : document.pages[0]!.id;
  const editor = useThumbnailEditor({ projectId, session, document, pageId: current, onPage, toast: onToast, unavailableAssetIds: unavailable, flushers, openKnobs: () => setKnobsOpen(true) });
  const previews = useThumbnailPreviews(projectId, session);
  // 「AI に頼む」の状態の照会と欄の開閉は、つまみを畳んでも続くようにここで持つ。
  const ai = useThumbnailAi(projectId), [aiOpen, setAiOpen] = useState(false);
  useCanvasKeys(editor);
  useEffect(() => { if (current !== pageId) onPage(current); }, [current, pageId, onPage]);
  // 素材が無い・中身が変わったかを確かめる（コマなら「元の動画が見つかりません」を出す）。
  const sessionId = session.state?.sessionId, assetKey = document.assets.map(asset => asset.id).join(',');
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void thumbnailRequest<{ unavailable: string[] }>(projectId, '/assets/check', { sessionId }).then(result => { if (alive) setUnavailable(new Set(result.unavailable)); }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId, sessionId, assetKey]);
  return <section className="native-thumbnail" data-drawer={drawer ? 'open' : 'closed'} data-knobs={knobsOpen ? 'open' : 'closed'}>
    <ThumbnailRail open={drawer} onOpen={setDrawer} />
    <ThumbnailDrawer open={drawer} editor={editor} videoDocument={videoDocument} onClose={() => setDrawer(null)} />
    <section className="native-thumbnail-stage" aria-label="キャンバス"><ThumbnailContextBar editor={editor} /><ThumbnailStage editor={editor} previews={previews} phoneOpen={phoneOpen} onPhone={changePhone} /></section>
    <ThumbnailKnobsPanel editor={editor} open={knobsOpen} onOpen={setKnobsOpen} top={<ThumbnailAiPanel editor={editor} ai={ai} open={aiOpen} onOpenChange={setAiOpen} onOpenAi={onOpenAi} />}
      closedTop={<ThumbnailAiShortcut ai={ai} onAsk={() => { setKnobsOpen(true); setAiOpen(true); }} />} />
    <ThumbnailPages editor={editor} exporter={exporter} previews={previews} phoneOpen={phoneOpen} onPhone={changePhone} />
    {(session.notice || session.error) && <div className="native-notice native-thumbnail-notice" role="alert"><span>{session.notice ?? session.error}</span>
      <button type="button" className="btn-ghost native-header-icon" aria-label="サムネの通知を閉じる" onClick={() => { session.clearNotice(); session.clearError(); }}><Icon name="x" /></button></div>}
  </section>;
}
