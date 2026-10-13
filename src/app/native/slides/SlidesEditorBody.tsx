import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SlideDocument } from '../../../core/slides/model';
import { slidePageAsThumbnail } from '../../../core/slides/pageView';
import { useCanvasKeys } from '../thumbnail/useCanvasKeys';
import { useThumbnailEditor } from '../thumbnail/useThumbnailEditor';
import { SlidesDrawer, type SlidesDrawerContext } from './SlidesDrawer';
import { SlidesKnobsPanel } from './SlidesKnobsPanel';
import type { SlidesDrawerId } from './SlidesRail';
import { SlidesStage } from './SlidesStage';
import { slidesRequest } from './slidesApi';
import { useThumbnailSessionView } from './thumbnailAdapter';
import type { SlidesSessionHook } from './useSlidesSession';

export interface SlidesEditorBodyProps {
  projectId: string; session: SlidesSessionHook; document: SlideDocument; pageId: string;
  drawer: SlidesDrawerId | null; onDrawer(id: SlidesDrawerId | null): void; knobsOpen: boolean; onKnobs(open: boolean): void;
  flushers: Set<() => Promise<boolean>>; onToast(message: string): void; drawerContext: SlidesDrawerContext;
  /** 右のつまみの下に出すページの情報。 */
  pageInfo?: ReactNode;
  /** 渡したときは右のつまみの左隣に並べて出す（AI の作業）。つまみ（置き換え案の採用・捨てる）は隠さない。 */
  aside?: ReactNode;
}
/** ページがあるときの本体（引き出し・キャンバス・右）。フックはここに集める（ページが無いときはこの部品を出さない）。 */
export function SlidesEditorBody({ projectId, session, document, pageId, drawer, onDrawer, knobsOpen, onKnobs, flushers, onToast, drawerContext, pageInfo, aside }: SlidesEditorBodyProps) {
  const view = useMemo(() => slidePageAsThumbnail(document, pageId), [document, pageId]);
  const thumbnailSession = useThumbnailSessionView(session, pageId, onToast);
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(() => new Set());
  const editor = useThumbnailEditor({ projectId, session: thumbnailSession, document: view, pageId, onPage: () => undefined, toast: onToast,
    unavailableAssetIds: unavailable, flushers, openKnobs: () => onKnobs(true) });
  useCanvasKeys(editor);
  // 画像のファイルが無い・中身が変わったかを確かめる（無い画像は描かずに知らせる）。
  const sessionId = session.state?.sessionId, assetKey = document.assets.map(asset => asset.id).join(',');
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void slidesRequest<{ unavailable: string[] }>(projectId, '/assets/check', { sessionId }).then(result => { if (alive) setUnavailable(new Set(result.unavailable)); }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId, sessionId, assetKey]);
  return <>
    <SlidesDrawer open={drawer} onClose={() => onDrawer(null)} editor={editor} context={drawerContext} />
    <SlidesStage editor={editor} />
    {aside}
    <SlidesKnobsPanel editor={editor} open={knobsOpen} onOpen={onKnobs}>{pageInfo}</SlidesKnobsPanel>
  </>;
}
