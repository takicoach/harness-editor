import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SlideLayoutId } from '../../../core/slides/model';
import type { SlidesExportFormat } from '../../../server/slides/exports';
import { SlidesAiPanel } from './SlidesAiPanel';
import { SlidesDrawer, type SlidesDrawerContext } from './SlidesDrawer';
import { SlidesEditorBody } from './SlidesEditorBody';
import { SlidesEmptyBody } from './SlidesEmptyBody';
import { SlidesExportDialog } from './SlidesExportDialog';
import { SlidesHeader } from './SlidesHeader';
import { readNotesOpen, SlidesNotes } from './SlidesNotes';
import { SlidesPageInfo } from './SlidesPageInfo';
import { SlidesPageStrip } from './SlidesPageStrip';
import { SlidesPastePanel } from './SlidesPastePanel';
import type { SlidesAiAccess, SlidesRequestIntent } from './requestIntent';
import { SlidesRail, type SlidesDrawerId } from './SlidesRail';
import { SlidesVideoImportDialog } from './SlidesVideoImportDialog';
import { useSlidesAgent } from './useSlidesAgent';
import { useSlidesExport } from './useSlidesExport';
import { useSlidesPreviews } from './useSlidesPreviews';
import type { SlidesSessionHook } from './useSlidesSession';
import type { AiScreen } from '../../../shared/aiFocus';
import { useAiFocus } from '../../useAiFocus';

export interface SlidesWorkspaceProps { projectId: string; session: SlidesSessionHook; flushers: Set<() => Promise<boolean>>; onSave(): Promise<boolean>; onHome(): void }
/** スライドの画面: ヘッダー・左（アイコン列＋引き出し）・中央（キャンバス）・右（つまみ）・下（話すメモ・ページの帯）。 */
export function SlidesWorkspace({ projectId, session, flushers, onSave, onHome }: SlidesWorkspaceProps) {
  const [drawer, setDrawer] = useState<SlidesDrawerId | null>(null), [knobsOpen, setKnobsOpen] = useState(true);
  const [pageId, setPageId] = useState<string | null>(null), [toast, setToast] = useState<string | null>(null);
  const [paste, setPaste] = useState<SlidesRequestIntent | null>(null);
  const [aiOpen, setAiOpen] = useState(false), agent = useSlidesAgent(projectId, session);
  const slidesState = session.state;
  const aiScreen = useMemo<AiScreen | null>(() => slidesState ? { projectId, projectName: projectId.slice(0, 200), mode: 'slides',
    target: { kind: 'slides', documentId: slidesState.document.id, sessionId: slidesState.sessionId, revision: slidesState.document.revision },
    playheadSec: null, selection: pageId ? [pageId] : [], materials: `${slidesState.document.pages.length} ページ・台本 ${slidesState.document.script.paragraphs.length} 段落` } : null,
  [projectId, slidesState, pageId]);
  const aiFocus = useAiFocus(aiScreen);
  /** 台本の引き出しの「AI に頼む」。押したら右に AI の欄を出す（つながっていなければ欄が案内する）。 */
  const ai = useMemo<SlidesAiAccess>(() => ({ connected: agent.connected, busy: agent.busy, send: async intent => { setAiOpen(true); await agent.send(intent); } }), [agent.connected, agent.busy, agent.send]);
  const aiPanel = aiOpen ? <SlidesAiPanel agent={agent} session={session} focus={aiFocus} onPaste={setPaste} onToast={setToast} onClose={() => setAiOpen(false)} /> : null;
  const [exportOpen, setExportOpen] = useState<SlidesExportFormat | null>(null), exporter = useSlidesExport(projectId, session);
  /** 書き出しの前に、入力途中の話すメモなどを確定する。 */
  const flushAll = useCallback(async () => { for (const flush of flushers) if (!await flush()) return false; return true; }, [flushers]);
  const [videoImportOpen, setVideoImportOpen] = useState(false);
  const [grid, setGrid] = useState(false), previews = useSlidesPreviews(projectId, session);
  const [notesOpen, setNotesOpen] = useState(readNotesOpen);
  const state = session.state, document = state?.document;
  const current = document && pageId && document.pages.some(page => page.id === pageId) ? pageId : document?.pages[0]?.id ?? null;
  const currentPage = document?.pages.find(page => page.id === current);
  useEffect(() => { if (current !== pageId) setPageId(current); }, [current, pageId]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 4000); return () => clearTimeout(timer); }, [toast]);
  const addPage = useCallback(async (layout: SlideLayoutId, index?: number) => {
    const id = `p-${crypto.randomUUID()}`;
    if (await session.execute({ type: 'add-page', pageId: id, layout, ...(index === undefined ? {} : { index }) })) setPageId(id);
  }, [session.execute]);
  /** AI（または貼り付け）に頼む。AI がつながっていれば AI へ、いなければ貼り付けの画面を開く。 */
  const request = useCallback((intent: SlidesRequestIntent) => { if (agent.connected === true) { if (!agent.busy) void ai.send(intent); } else setPaste(intent); }, [agent.connected, ai]);
  const context: SlidesDrawerContext | null = document ? { projectId, session, document, pageId: current, onPage: setPageId, onToast: setToast, addPage, paste: setPaste, ai } : null;
  return <>
    <SlidesHeader name={projectId} dirty={!!state?.dirty} busy={session.busy} canUndo={!!state?.canUndo} canRedo={!!state?.canRedo}
      onHome={onHome} onUndo={() => void session.execute({ type: 'undo' })} onRedo={() => void session.execute({ type: 'redo' })} onSave={() => void onSave()} onAi={() => setAiOpen(open => !open)} aiOpen={aiOpen} onPdf={() => setExportOpen('pdf')} onExport={() => setExportOpen('png')} />
    <section className="native-thumbnail native-slides" data-drawer={drawer ? 'open' : 'closed'} data-knobs={knobsOpen ? 'open' : 'closed'} data-ai={aiOpen ? 'open' : undefined} aria-busy={!document}>
      {document && context && <>
        <SlidesRail open={drawer} onOpen={setDrawer} />
        {current
          ? <SlidesEditorBody key={current} projectId={projectId} session={session} document={document} pageId={current} drawer={drawer} onDrawer={setDrawer}
              knobsOpen={knobsOpen} onKnobs={setKnobsOpen} flushers={flushers} onToast={setToast} drawerContext={context}
              pageInfo={currentPage && <SlidesPageInfo document={document} page={currentPage} session={session} aiBusy={agent.connected === true && agent.busy} onRequest={request} onLayout={() => setDrawer('layout')} onToast={setToast} />} aside={aiPanel} />
          : <>
              <SlidesDrawer open={drawer} onClose={() => setDrawer(null)} editor={null} context={context} />
              <SlidesEmptyBody disabled={session.busy} onAddPage={() => void addPage('cover')} onScript={() => setDrawer('script')} />
              {aiPanel}
            </>}
        {currentPage && <SlidesNotes key={currentPage.id} page={currentPage} session={session} flushers={flushers} open={notesOpen} onOpen={setNotesOpen} />}
        <SlidesPageStrip projectId={projectId} session={session} document={document} pageId={current} onPage={setPageId} previews={previews} grid={grid} onGrid={setGrid}
          onAddPage={() => void addPage('points', current ? document.pages.findIndex(page => page.id === current) + 1 : undefined)} />
        {/* ここにページの帯と話すメモを足す */}
      </>}
    </section>
    {paste && <SlidesPastePanel key={JSON.stringify(paste)} projectId={projectId} session={session} intent={paste} onClose={() => setPaste(null)} onToast={setToast} />}
    {exportOpen && document && <SlidesExportDialog key={exportOpen} projectId={projectId} exporter={exporter} initial={exportOpen} pages={document.pages.length}
      onFlush={flushAll} onClose={() => setExportOpen(null)} onVideoImport={() => { setExportOpen(null); setVideoImportOpen(true); }} />}
    {videoImportOpen && document && <SlidesVideoImportDialog projectId={projectId} session={session} document={document} pageId={current} onSave={onSave} onClose={() => setVideoImportOpen(false)} />}
    {/* ここにダイアログを足す */}
    {toast && <div className="native-notice native-slides-notice" role="status"><span>{toast}</span></div>}
    {(session.notice || session.error) && <div className="native-notice native-slides-notice" role="alert"><span>{session.notice ?? session.error}</span>
      <button type="button" className="btn-ghost" onClick={() => { session.clearNotice(); session.clearError(); }}>閉じる</button></div>}
  </>;
}
