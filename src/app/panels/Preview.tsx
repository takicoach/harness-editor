import { forwardRef, useCallback, useMemo, useRef, useState } from 'react';
import type { EditorPlaybackRef } from '../preview/editorPlayback';
import type { EditorProject } from '../../core/types';
import type { PlaybackModel } from '../../preview/playbackModel';
import { toEditorProject, type EditState } from '../edit/editState';
import { PreviewOverlay, type DrawingKind } from '../preview/PreviewOverlay';
import type { SnapPref } from '../useSnapPref';
import { ShapeToolbar } from '../preview/ShapeToolbar';
import { PlayheadInput } from '../preview/PlayheadInput';
import { PlayerErrorBoundary, PreviewCrashPanel } from '../preview/PlayerErrorBoundary';
import { EditorLegacyPreview, type EditorLegacyPreviewHandle } from '../native/EditorLegacyPreview';
import { useLegacyPreview } from '../native/useLegacyPreview';
import type { NativePreviewFailure } from '../../preview/native/previewError';
import '../native/native.css';

interface PreviewProps {
  model: PlaybackModel;
  project: EditorProject;
  projectId: string;
  hasVideo: boolean;
  seLibrary: string[];
  imageLibrary: string[];
  videoLibrary: string[];
  bgmLibrary: string[];
  assetVersions?: Record<string, string>;
  state: EditState;
  onLive: (next: EditState) => void;
  onEdit: (next: EditState) => void;
  drawingKind?: DrawingKind;
  onDrawingKindChange: (v: DrawingKind) => void;
  reloadKey?: number;
  onReloadPreview: () => void;
  playbackRate?: number;
  cutsBypassed?: boolean;
  showEditOverlay?: boolean;
  snapPref?: SnapPref;
}

const NO_CUTS: EditorProject['cutRegions'] = [], NO_ORDER: NonNullable<EditorProject['cutOrder']> = [];
const NO_TRANSITIONS: NonNullable<EditorProject['sceneTransitions']> = [], NO_SPEEDS: NonNullable<EditorProject['segmentSpeeds']> = {};
const available = <T extends {file:string}>(items: T[], library: string[]): T[] => items.every(item => library.includes(item.file)) ? items : items.filter(item => library.includes(item.file));

/** Display-only projection: session data and missing references stay editable and
 * saveable. Match the old preview's missing-asset and source-clock policies. */
export function projectPreviewInput(project: EditorProject, state: EditState, cutsBypassed: boolean,
  libraries: Pick<PreviewProps, 'seLibrary' | 'imageLibrary' | 'videoLibrary' | 'bgmLibrary'>): EditorProject {
  const live = toEditorProject(state, project);
  return {...live,
    se: available(live.se, libraries.seLibrary), images: available(live.images, libraries.imageLibrary),
    videoInserts: available(live.videoInserts ?? [], libraries.videoLibrary), bgm: available(live.bgm ?? [], libraries.bgmLibrary),
    ...(cutsBypassed ? {cutRegions:NO_CUTS,cutOrder:NO_ORDER,sceneTransitions:NO_TRANSITIONS,mainSpeed:1,segmentSpeeds:NO_SPEEDS} : {}),
  };
}

/** Keep the existing editing controls around the application-owned renderer. */
export const Preview = forwardRef<EditorPlaybackRef, PreviewProps>(function Preview(
  {model, project, projectId, hasVideo, seLibrary, imageLibrary, videoLibrary, bgmLibrary, assetVersions,
    state, onLive, onEdit, drawingKind, onDrawingKindChange, reloadKey = 0, onReloadPreview, playbackRate = 1,
    cutsBypassed = false, showEditOverlay = true, snapPref}, ref,
) {
  const playerRef = useRef<EditorLegacyPreviewHandle | null>(null);
  const attachPlayer = useCallback((player: EditorLegacyPreviewHandle | null) => {
    playerRef.current = player;
    if (typeof ref === 'function') ref(player); else if (ref) ref.current = player;
  }, [ref]);
  const projected = useMemo(() => projectPreviewInput(project, state, cutsBypassed, {seLibrary,imageLibrary,videoLibrary,bgmLibrary}),
    [project,state,cutsBypassed,seLibrary,imageLibrary,videoLibrary,bgmLibrary]);
  // Selection/tab changes replace EditState but not any of the projected fields.
  // Preserve that identity so they cannot create a renderer revision or stop play.
  const stable = useRef(projected);
  const sameField = (a: unknown, b: unknown) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => value === b[i]));
  if ((Object.keys(projected) as (keyof EditorProject)[]).some(key => !sameField(projected[key], stable.current[key]))) stable.current = projected;
  const draftProject = stable.current;
  const resourceRevision = `${reloadKey}:${JSON.stringify(assetVersions ?? {})}`;
  const preview = useLegacyPreview(projectId, draftProject, resourceRevision);
  const [position, setPosition] = useState({frame:0});
  const [failure, setFailure] = useState<{project:EditorProject;reload:number;error:NativePreviewFailure} | null>(null);
  const crashed = failure?.project === draftProject && failure.reload === reloadKey;
  const onError = useCallback((error: NativePreviewFailure) => {
    setFailure({project:draftProject,reload:reloadKey,error});
    const exit = document.exitFullscreen?.bind(document);
    if (document.fullscreenElement && exit) void Promise.resolve(exit()).catch(error => console.warn('プレビューの全画面解除に失敗しました', error));
  }, [draftProject,reloadKey]);
  const onFrame = useCallback((frame: number) => { setPosition({frame}); setFailure(null); }, []);
  const readNativeMeasurement = useCallback<EditorLegacyPreviewHandle['measureLegacy']>((kind,id) =>
    preview.status === 'ready' && !crashed ? playerRef.current?.measureLegacy(kind,id) ?? null : null, [preview.status,crashed]);
  const canManipulate = showEditOverlay && preview.status === 'ready' && !crashed;

  return <div className="pv pv-native" data-main-video-available={hasVideo}>
    <div className="pv-stage">
      <PlayerErrorBoundary resetKey={reloadKey} onReload={onReloadPreview}>
        <EditorLegacyPreview ref={attachPlayer} preview={preview} initialFrame={position.frame} onFrame={onFrame} bypassLut={false}
          playbackRate={playbackRate} onError={onError}/>
      </PlayerErrorBoundary>
      {/* Keep the gesture owner mounted so pointerup can commit an in-progress edit.
          Missing measurements make its existing surface inert and invisible. */}
      {showEditOverlay && <PreviewOverlay compWidth={model.width} compHeight={model.height} state={state}
        onLive={onLive} onEdit={onEdit} playerRef={playerRef} readNativeMeasurement={readNativeMeasurement}
        drawingKind={drawingKind} telopBottomOffset={model.telopBottomOffset} mainSpeed={model.mainSpeed}
        speedSegments={model.speedSegments} playbackOverlaps={model.playbackOverlaps} fps={model.fps}
        cutsBypassed={cutsBypassed} snapPref={snapPref}/>}
      {canManipulate && <ShapeToolbar active drawingKind={drawingKind ?? null} onDrawingKindChange={onDrawingKindChange}/>}
      {crashed && preview.status === 'ready' && <PreviewCrashPanel onReload={onReloadPreview}/>}
    </div>
    <div className="pv-foot">
      <PlayheadInput playerRef={playerRef} fps={model.fps} durationInFrames={model.durationInFrames}
        sourceMode={cutsBypassed} disabled={crashed || preview.status !== 'ready'}/>
      <span className="pv-foot-info"><span>{model.width}×{model.height}</span></span>
      <button type="button" className="pv-reload-btn" title="プレビューが黒くなった・止まった時に（編集内容は失われません）"
        aria-label="プレビューを再読み込み" onClick={onReloadPreview}>⟳ 再読み込み</button>
    </div>
  </div>;
});
