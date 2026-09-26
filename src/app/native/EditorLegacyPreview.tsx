import { forwardRef, useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorPlaybackController, type EditorPlaybackConnection, type EditorPlaybackRef } from '../preview/editorPlayback';
import type { RenderedSceneGeometry } from '../../preview/native/renderGeometry';
import { audioPlanIdentity } from '../../preview/native/audioPlanIdentity';
import { previewFailure } from '../../preview/native/previewError';
import { LegacyPreview, type LegacyPreviewProps } from './LegacyPreview';
import type { NativePreviewHandle } from './NativePreview';
import type { LegacyMeasurementReader } from '../../preview/native/legacyMeasurement';

export interface EditorLegacyPreviewHandle extends EditorPlaybackRef {
  /** The matching geometry is installed synchronously before frameupdate. */
  getGeometry(): RenderedSceneGeometry | null;
  measureLegacy: LegacyMeasurementReader;
}
type Props = Omit<LegacyPreviewProps, 'onRendered' | 'onPlaybackChanged' | 'onEnded'>;
interface ResumeIntent { projectId:string; context:string; documentId:string; revision:number }
interface PendingSeek { frame: number; resolve(): void; reject(error: unknown): void }
interface Slot { connection: EditorPlaybackConnection | null; geometry: RenderedSceneGeometry | null; drawn: boolean; pending: PendingSeek | null }

/** The stable editor facade outlives native iframe/ref replacements. Revision,
 * lease and project identity determine ownership; React ref refreshes do not. */
export const EditorLegacyPreview = forwardRef<EditorLegacyPreviewHandle, Props>(function EditorLegacyPreview({ preview, onError, ...props }, ref) {
  const native = useRef<NativePreviewHandle>(null), errorRef = useRef(onError); errorRef.current = onError;
  const [controller] = useState(() => new EditorPlaybackController(error => errorRef.current?.(previewFailure(error))));
  const ready = preview.status === 'ready' ? preview : null;
  const soundIdentity = useMemo(() => ready ? audioPlanIdentity(ready.document) : null, [ready?.document]);
  const slot = useMemo<Slot>(() => ({connection:null,geometry:null,drawn:false,pending:null}), [ready?.projectId,ready?.legacyContext,ready?.document.id,ready?.document.revision]);
  const activeSlot = useRef(slot), deferredFrame = useRef<number | null>(null);
  const resumeIntent = useRef<ResumeIntent | null>(null);
  const incoming = useRef<{ready: typeof ready; soundIdentity: string | null} | null>(null);
  const handoff = useRef<{owner:ResumeIntent; drawn:boolean} | null>(null);
  // Insertion effects describe committed work before layout cleanups run. An
  // abandoned render cannot authorize skipping the transport's unmount cleanup.
  useInsertionEffect(() => {
    incoming.current = {ready,soundIdentity};
    return () => { incoming.current = null; };
  }, [ready,soundIdentity]);
  const sameOwner = (intent: ResumeIntent) => ready && intent.projectId === ready.projectId && intent.context === ready.legacyContext && intent.documentId === ready.document.id;

  useLayoutEffect(() => {
    activeSlot.current = slot;
    if (!ready) { resumeIntent.current = null; handoff.current = null; return; }
    if (resumeIntent.current && (!sameOwner(resumeIntent.current) || resumeIntent.current.revision >= ready.document.revision)) resumeIntent.current = null;
    const transfer = handoff.current; handoff.current = null;
    const preservePlayback = !!(transfer && sameOwner(transfer.owner) && transfer.owner.revision === ready.document.revision);
    // The existing native plan has the same audio clock/duration. It can accept
    // an explicit seek immediately while the new visual revision is drawing.
    slot.drawn = preservePlayback && transfer!.drawn;
    const connection = controller.connect({
      frame: () => slot.geometry?.frame,
      durationFrames: () => ready.document.sequenceEndFrame,
      seek: frame => {
        if (slot.drawn && native.current) return native.current.seek(frame);
        slot.pending?.resolve();
        return new Promise<void>((resolve, reject) => { slot.pending = {frame, resolve, reject}; });
      },
      setPlaybackRate: rate => native.current?.setPlaybackRate(rate),
      isPlaybackPending: () => resumeIntent.current !== null || (native.current?.isPlaybackPending() ?? false),
      // NativePreview reports its own structured failure; avoid reporting it
      // again through the rejected imperative promise.
      play: () => native.current?.play().catch(() => undefined),
      pause: () => native.current?.pause(),
    }, {preservePlayback});
    slot.connection = connection;
    if (deferredFrame.current !== null) {
      const frame = deferredFrame.current; deferredFrame.current = null; controller.seekTo(frame);
    }
    return () => {
      // Cleanup runs for the committed incoming render. A different lease/doc or
      // unmount publishes a genuine stop instead of exposing a pending restart.
      const committed = incoming.current, next = committed?.ready;
      const transfers = next && next.projectId === ready.projectId && next.legacyContext === ready.legacyContext
        && next.document.id === ready.document.id && next.document.revision > ready.document.revision;
      const keepClock = !!transfers && soundIdentity === committed?.soundIdentity;
      handoff.current = keepClock ? {owner:{projectId:next!.projectId,context:next!.legacyContext,documentId:next!.document.id,revision:next!.document.revision},drawn:slot.drawn} : null;
      if (!keepClock) resumeIntent.current = transfers && (controller.isPlaying() || controller.isPlaybackPending?.())
        ? {projectId:ready.projectId,context:ready.legacyContext,documentId:ready.document.id,revision:ready.document.revision} : null;
      if (slot.pending) { deferredFrame.current = slot.pending.frame; slot.pending.resolve(); slot.pending = null; }
      slot.connection = null; slot.geometry = null; slot.drawn = false;
      if (!keepClock) connection.disconnect();
    };
  }, [controller,slot]);
  useImperativeHandle(ref, () => ({
    getCurrentFrame: () => controller.getCurrentFrame(),
    seekTo: frame => {
      if (!Number.isFinite(frame)) throw new Error('再生位置が不正です');
      resumeIntent.current = null;
      if (!activeSlot.current.connection) deferredFrame.current = frame;
      else controller.seekTo(frame);
    },
    seekBy: delta => {
      if (!Number.isFinite(delta)) throw new Error('移動量が不正です');
      resumeIntent.current = null;
      if (!activeSlot.current.connection) deferredFrame.current = (deferredFrame.current ?? controller.getCurrentFrame()) + delta;
      else controller.seekBy(delta);
    },
    setPlaybackRate: rate => controller.setPlaybackRate?.(rate),
    isPlaybackPending: () => resumeIntent.current !== null || controller.isPlaybackPending(),
    play: () => controller.play(), pause: () => { resumeIntent.current = null; controller.pause(); }, isPlaying: () => controller.isPlaying(),
    addEventListener: controller.addEventListener.bind(controller), removeEventListener: controller.removeEventListener.bind(controller),
    getGeometry: () => activeSlot.current.geometry,
    measureLegacy: (kind, id) => activeSlot.current.geometry ? native.current?.measureLegacy(kind, id) ?? null : null,
  }), [controller]);
  return <LegacyPreview {...props} preview={preview} ref={native}
    onRendered={(frame,geometry) => {
      if (activeSlot.current !== slot || !slot.connection) return;
      // A seek in the layout/passive-effect gap can still use the prior plan.
      // Retiring callbacks alone cannot validate metadata sent to a new callback.
      if (geometry && (geometry.documentId !== ready?.document.id || geometry.revision !== ready.document.revision || geometry.frame !== frame)) return;
      slot.drawn = true;
      const pending = slot.pending; slot.pending = null;
      if (pending && pending.frame !== frame) {
        // The first draw proves that this document's passive preparation is done.
        // Apply the latest queued input before publishing its restored position.
        void native.current!.seek(pending.frame).then(pending.resolve, pending.reject);
        return;
      }
      slot.geometry = geometry;
      const intent = resumeIntent.current;
      slot.connection.frameRendered(frame); pending?.resolve();
      if (intent) queueMicrotask(() => {
        // Frame subscribers may pause/seek/replace the document synchronously.
        // Let Native publish this draw before beginning its new audio preparation.
        if (activeSlot.current !== slot || !slot.connection || resumeIntent.current !== intent || !sameOwner(intent)) return;
        resumeIntent.current = null; controller.play();
      });
    }}
    onPlaybackChanged={playing => slot.connection?.playbackChanged(playing)} onEnded={() => slot.connection?.ended()}
    onError={failure => { if (activeSlot.current !== slot) return; resumeIntent.current = null; if (slot.connection) slot.connection.failed(failure); else errorRef.current?.(failure); }} />;
});
