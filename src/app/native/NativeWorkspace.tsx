import {loadTrackHeight,saveTrackHeight,MIN_TRACK_HEIGHT,MAX_TRACK_HEIGHT} from './trackHeight';
import {NativeLibraryDrop} from './NativeLibraryDrop';
import {NativeSilenceCutPanel} from './NativeSilenceCutPanel';
import {splitVideoFiles} from './videoFiles';
import {createMediaKind} from '../../shared/createMedia';
import type {SilenceRange} from '../../shared/silenceCut';
import {desktopFilePath} from './fileReference';
import {createWithDurations} from './importSeconds';
import {referenceUnavailable,useNativeReferenceStatus} from './useNativeReferenceStatus';
import {usePanelResize} from './usePanelResize';
import {NativeSwitch} from './NativeSwitch';
import type {SequenceDocument} from '../../core/sequence/model';
import {cutInclusivePreview} from './cutInclusivePreview';
import {finishDisplayPoint,finishLiveToDisplay} from './finishDisplayMap';
import {NativeProxyBanner} from './NativeProxyBanner';
import {useNotificationHistory} from './useNotificationHistory';
import {NativeNotifications} from './NativeNotifications';
import {NativeLearningReview} from './NativeLearningReview';
import {useLearningDiff} from '../useLearningDiff';
import {nativeCutRateWarning} from './notificationHistory';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type {NativeNavigation} from './useNativeNavigation';
import { Icon } from '../Icon';
import { configureUiSound, uiSound } from './uiSound';
import { NativeHeader, type NativeMode } from './NativeHeader';
import {MediaPicker} from '../panels/MediaPicker';
import {useNativeFileReference} from './useNativeFileReference';
import type {ClipVisual,SequenceAsset} from '../../core/sequence/model';
import {loadPanelLayout,savePanelLayout} from '../layout/layoutPreset';
import { useTheme } from '../layout/useTheme';
import { useAutoSave } from '../useAutoSave';
import { hasExplicitAutoSavePref, loadAutoSaveEnabled, saveAutoSaveEnabled } from '../layout/autoSavePref';
import {loadWaveformPref,saveWaveformPref} from '../layout/waveformPref';
import { parseAutoSaveDelayOverride } from '../edit/autoSave';
import { isModalOpen,isAgentEditBlocked } from '../isModalOpen';
import { sequenceEditorRevision } from '../../core/sequence/editorCommands';
import { useNativeSession } from './useNativeSession';
import { useNativeEditorBridge } from './useNativeEditorBridge';
import { useEditorAgentConnection } from '../useEditorAgentConnection';
import { AgentActivityDialog } from '../panels/AgentActivityDialog';
import { footerHints, matchShortcut } from './shortcuts';
import { NativeToast } from './NativeToast';
import { NativeShortcutsDialog } from './NativeShortcutsDialog';
import { loadEditorPrefs, saveEditorPrefs, type EditorPrefs } from '../layout/editorPrefs';
import { NativeSettings } from './NativeSettings';
import { HelpModal } from '../help/HelpModal';
import { TutorialOverlay } from '../tutorial/TutorialOverlay';
import { useNativeTutorial } from '../tutorial/useNativeTutorial';
import { telopRemovalCommand, type NativeTelopRecord } from '../tutorial/nativeTutorialFlow';
import type { NativeStepPrep } from '../tutorial/nativeTutorialSteps';
import {AiTerminal} from '../panels/AiTerminal';
import {NativeProjectList} from './NativeProjectList';
import {NativeAiBand} from './NativeAiBand';
import {NativeAddBar} from './NativeAddBar';
import {NativeColumnRail} from './NativeColumnRail';
import { NativeSegmented } from './NativeSegmented';
import {TaskProgress,type TransferProgress} from '../components/TaskProgress';
import { NativePreview, type NativePreviewHandle, type NativeVisualPreview } from './NativePreview';
import {fitPanelGains,isNarrow,rightColumnWidth,timelineBottom,toolbarFit,TOOLBAR_FIT_INITIAL,type ToolbarFit} from './layoutBudget';
import {NativeViewMenu} from './NativeViewMenu';
import type { ShapeData } from './shapeDraft';
import type { ShapeKind } from '../../core/types';
import { shuttleKeyDown, shuttleKeyUp, shuttleBlur, type ShuttleKeyState } from './shuttleKeys';
import {useCutSourcePreview} from './useCutSourcePreview';
import {useTrialSwap} from './useTrialSwap';
import {trialSelectable,trialUsage,type TrialEndMode} from '../../core/sequence/trialSwap';
import { NativeTimeline, type NativeRange, type NativeTool,type NativeTimelineHandle } from './NativeTimeline';
import {clipSeekTarget} from './clipSeek';
import { NativeInspector, type NativeInspectorHandle } from './NativeInspector';
import {sceneFadeInsertionIndex,type SceneFadeTarget} from '../../core/sequence/sceneFadeEdits';
import {transitionJoinsForUi} from '../../core/sequence/transitions';
import { NativeExportControl } from './NativeExportControl';
import { NativeThumbnailWorkspace, type ThumbnailWorkspaceHandle } from './thumbnail/NativeThumbnailWorkspace';
import { useThumbnailSession } from './thumbnail/useThumbnailSession';
import { useAiFocus } from '../useAiFocus';
import { nativeAiScreen } from './aiScreen';
import { ThumbnailExportControl } from './thumbnail/ThumbnailExportControl';
import { useThumbnailExport } from './thumbnail/useThumbnailExport';
import { NativeScriptPanel, type NativeScriptHandle } from './NativeScriptPanel';
import { NativeTranscribeControl } from './NativeTranscribeControl';
import { NativeCaptionPanel, type NativeCaptionHandle } from './NativeCaptionPanel';
import { NativeCutPanel, type NativeCutHandle } from './NativeCutPanel';
import type { NativeCommand, NativeSession } from './api';
import { abandonImportItems,cancelImportBatch,NativeApiError,nativeRequest,retryOnce,uploadImportItem } from './api';
import {IMPORT_REASON,type ImportBatchView} from '../../shared/importBatches';
import { assetUsage } from './assetUsage';
import { useAssetAudition } from './useAssetAudition';
import { clipEnd, sourceTimeAt, DEFAULT_TEXT_APPEARANCE, type SequenceClip, type SequenceTrack } from '../../core/sequence/model';
import { rational, timeNumber, compareTime } from '../../core/sequence/time';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import { buildMediaPlacement, buildLibraryPlacement, findLibraryTarget } from './library/placement';
import { NativeLibraryPanel } from './library/NativeLibraryPanel';
import { libraryFileUrl, saveToLibrary, useLibraryListing } from './library/libraryApi';
import { NativeLibrarySaveDialog } from './library/NativeLibrarySaveDialog';
import { speechSelectionRange } from '../../core/sequence/sourceSelection';
import { sequenceAssetUrl } from '../../preview/native/sceneRenderer';
import { readNativeView, writeNativeView } from './viewState';
import { isEscape } from './keyboard';
import { followsPlayhead, pickSpeechOccurrence } from './speechOccurrence';
import './native.css';
import './native-polish.css';
import {MATERIAL_TAB_EMPTY,materialTabItems,materialTabOf} from './materialTab';
import {useImportBatches} from './useImportBatches';
import {NativeImportBatches} from './NativeImportBatches';
import {useMediaCopyJobs} from './useMediaCopyJobs';
import {NativeCopyDestinationDialog} from './NativeCopyDestinationDialog';
import {NativeCopyProgress,copySettledMessage} from './NativeCopyProgress';
import {cancelMediaCopy,copyErrorMessage,decideImportBatch,dismissMediaCopy,startMediaCopy,type CopyTargets} from './mediaCopyApi';
import {noteAskedBatch,useSlowMediaAdvice,wasAskedBatch} from './useSlowMediaAdvice';
import {NativeSlowMediaAdvice} from './NativeSlowMediaAdvice';
import './native-restoration.css';
import './native-studio.css';
import { SlidesImportNotice } from './slides/SlidesImportNotice';

const newId = () => crypto.randomUUID();
/** 確定した束のうち、映像が無いため一覧に登録だけした素材の知らせ（無ければ null）。 */
function audioOnlyNotice(batch:ImportBatchView):string|null{
  const names=batch.items.filter(item=>item.phase==='ready'&&item.audioOnly).map(item=>`「${item.name}」`);
  return names.length?`${names.join('')}は映像が無いため、メインには並べず素材の一覧に追加しました。`:null;
}
/** 試し中に止めた編集を試みたときの知らせ（設計 §3-8）。 */
const TRIAL_LOCKED='試し表示中は編集できません。採用するか戻してから操作してください';
/** 描画で置いた図形の初期色。shapeStyle の DEFAULT_SHAPE_COLOR（赤）ではなく、従来の追加と同じ白のまま
 *  （色は T19 のプロパティで選ぶ。既存の実出力監査が図形の可視画素を白で数えている）。 */
const NEW_SHAPE_COLOR = '#ffffff';
/** 秒を「分:秒.十分の一」で表示する（868.9 秒 → 14:28.9）。 */
const formatSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
// I-2: NativeSegmented の items はモジュール定数で渡す（NativeHeader の MODES と同形）。
// JSX 内のインライン配列だと再生中の毎フレーム再レンダーで参照が変わり、observer 再生成と強制リフローを招く。
const LEFT_TABS = [
  {value:'projects',label:'プロジェクト',controls:'native-panel-projects'},
  {value:'materials',label:'素材',controls:'native-panel-materials'},
] as const;
const MATERIAL_SOURCES = [
  {value:'project',label:'この案件'},
  {value:'library',label:'素材置場'},
] as const;
const MATERIAL_SOURCE_KEY='harness.native.materialSource';
const readMaterialSource=():'project'|'library'=>{try{return localStorage.getItem(MATERIAL_SOURCE_KEY)==='library'?'library':'project';}catch{return 'project';}};
const DOCK_TABS = [
  {value:'transcript',label:'字幕一覧',controls:'native-panel-transcript'},
  {value:'script',label:'台本',controls:'native-panel-transcript'},
  {value:'properties',label:'調整',controls:'native-panel-properties'},
] as const;
/** 畳んだカラムのレールに出すタブ（R2-F2 A）。押すとそのタブでカラムが開く。 */
const LEFT_RAIL_ITEMS = [
  {value:'projects',label:'プロジェクト',icon:'folder'},
  {value:'materials',label:'素材',icon:'film'},
] as const;
const RIGHT_RAIL_ITEMS = [
  {value:'transcript',label:'字幕一覧',icon:'captions'},
  {value:'script',label:'台本',icon:'script'},
  {value:'properties',label:'調整',icon:'sliders'},
  {value:'ai',label:'AI で編集する',icon:'sparkles'},
] as const;
const TOOL_ITEMS = [
  { value: 'select', label: <><Icon name="cursor" /><span className="native-sr-only">選択</span></>, shortcut: 'V', tip: '選択 V' },
  { value: 'razor', label: <><Icon name="scissors" /><span className="native-sr-only">分割</span></>, shortcut: 'C', tip: '分割 C' },
  { value: 'range', label: <><Icon name="pen" /><span className="native-sr-only">なぞってカット</span></>, shortcut: 'B', tip: 'なぞってカット B' },
] as const;
// 「ゴミ箱へ移す」（DELETE /api/material）の対象を割り出すための prefix → kind 対応。
// materialRelPath（src/server/uploadMaterial.ts）の subdir と一致させる。
// より深い prefix を先に（public/ は video の受け皿として最後）。
const MATERIAL_KINDS: Array<[string, 'se' | 'image' | 'bgm' | 'video']> = [['public/se/', 'se'], ['public/images/', 'image'], ['public/BGM/', 'bgm'], ['public/', 'video']];
export function NativeWorkspace({ projectId, navigation, onReload }: { projectId: string; navigation?: NativeNavigation; onReload?():void }) {
  const fileReference=useNativeFileReference(),importPending=useRef(false),importOwner=useRef({}),importReads=useRef(new AbortController());
  // 案件を離れたら持ち主を替え、その案件のために始めた長さの先読みを止める。
  useEffect(()=>()=>{importOwner.current={};importReads.current.abort();importReads.current=new AbortController();},[projectId]);
  const timeline=useRef<NativeTimelineHandle>(null),[boundaryWorking,setBoundaryWorking]=useState(false);
  const [panelLayouts,setPanelLayouts]=useState(()=>({edit:loadPanelLayout('edit'),finish:loadPanelLayout('finish')}));
  const cutPanel=useRef<NativeCutHandle>(null),[cutWorking,setCutWorking]=useState(false),[activeCutId,setActiveCutId]=useState<string|null>(()=>readNativeView(projectId).activeCutId??null);
  const [cutRestoreSelected,setCutRestoreSelected]=useState(false);
  const [cutPanelOpen,setCutPanelOpen]=useState(false);
  const cutSnapshot=useRef<{documentId:string;ids:Set<string>;groups:string[][]}|null>(null);
  const captionPanel=useRef<NativeCaptionHandle>(null),[captionDraft,setCaptionDraft]=useState(false);
  const scriptPanel=useRef<NativeScriptHandle>(null),[scriptDraft,setScriptDraft]=useState(false);
  const inspector=useRef<NativeInspectorHandle>(null),[inspectorDraft,setInspectorDraft]=useState(false);
  const inspectorSaving=useRef(0);
  const player = useRef<NativePreviewHandle>(null),[manipulationBusy,setManipulationBusy]=useState(false);
  const [timelineDragging,setTimelineDragging]=useState(false);
  const [silenceOpen,setSilenceOpen]=useState(false),[silenceBusy,setSilenceBusy]=useState(false),[silenceCandidates,setSilenceCandidates]=useState<SilenceRange[]>([]);
  const [silencePreview,setSilencePreview]=useState<{document:SequenceDocument;start:number;end:number}|null>(null);
  const silenceStarted=useRef(false),silenceButton=useRef<HTMLButtonElement>(null);
  // 最初のプレビューの絵が出るまでコマ絵を取りに行かない（設計 §2-1「取得の開始」: 切り出しが最初の絵と CPU を取り合う）。失敗したら待たない。
  const [firstPicture,setFirstPicture]=useState(false);
  const silenceReturnFocus=useRef(false);
  useEffect(()=>{if(!silenceOpen&&silenceReturnFocus.current){silenceReturnFocus.current=false;silenceButton.current?.focus();}},[silenceOpen]);
  const deferExternal = scriptDraft||inspectorDraft||captionDraft||manipulationBusy||timelineDragging||cutWorking||boundaryWorking||silenceOpen;
  const aiModeRef = useRef<'video' | 'thumbnail'>('video');
  const nativeSession = useNativeSession(projectId,deferExternal), agent = useNativeEditorBridge(projectId,nativeSession,deferExternal);
  const [preparingSave,setPreparingSave]=useState(false),viewSave=useRef<Promise<boolean>|null>(null),saveEpoch=useRef(0);
  useEffect(()=>{saveEpoch.current++;viewSave.current=null;setPreparingSave(false);return()=>{saveEpoch.current++;};},[projectId]);
  const save=useCallback(()=>{
    if(viewSave.current)return viewSave.current;
    const generation=saveEpoch.current;
    setPreparingSave(true);
    const task=(async()=>{
      try{
        // Saving cancels a drag in progress. Start that now, before the pointer can be released
        // and commit it; timeline first, then the preview, as the flushes below await them.
        const gestures=[timeline.current?.flush(),player.current?.flushManipulation()];
        void Promise.allSettled(gestures);
        // Let React paint the save indicator before committing pending field edits.
        await new Promise<void>(resolve=>setTimeout(resolve,0));
        for(const flush of [()=>gestures[0],()=>gestures[1],()=>inspector.current?.flush(),()=>scriptPanel.current?.flush(),()=>captionPanel.current?.flush(),()=>cutPanel.current?.flush()]){
          if(generation!==saveEpoch.current||await flush()===false)return false;
        }
        if(generation!==saveEpoch.current)return false;
        const saved=await nativeSession.save();if(saved&&generation===saveEpoch.current){agent.resumeAutoSave();uiSound('success');}return saved;
      }finally{if(generation===saveEpoch.current)setPreparingSave(false);}
    })();
    viewSave.current=task;void task.finally(()=>{if(viewSave.current===task)viewSave.current=null;});return task;
  },[nativeSession.save]);
  // 試し表示はここ（session.busy）に入れない。保存・自動保存・AI 編集の受け取りは試し中も止めないため（設計 §3-8）。編集操作は下の editLocked で止める。
  const workBusy=nativeSession.busy||agent.busy||cutWorking||boundaryWorking||silenceBusy;
  const session={...nativeSession,save,busy:workBusy||!!silencePreview}, doc = session.state?.document, theme = useTheme();
  const notifications=useNotificationHistory(projectId),[notificationsOpen,setNotificationsOpen]=useState(false);
  // 書き出し後の学習ループ（OSS 0.3.1 の差分レビューの移植）。書き出しが「実行中→完了」に変わった時だけ開く。
  // 開くのはジョブごとに1回。書き出し部品が作り直されて同じ完了がもう一度届いても、閉じた後に開き直さない。
  const learning=useLearningDiff(),learningJobs=useRef(new Set<string>());
  const openLearning=useCallback((job:{id:string})=>{if(learningJobs.current.has(job.id))return;learningJobs.current.add(job.id);learning.open(projectId,job.id);},[learning.open,projectId]);
  const cutRateWarning=useMemo(()=>doc?nativeCutRateWarning(doc):null,[doc]);
  useEffect(()=>{if(cutRateWarning)notifications.add({severity:'warning',source:'カット率',message:cutRateWarning,revision:doc?.revision});},[cutRateWarning,notifications.add]);
  useEffect(()=>{if(session.state?.historyError)notifications.add({severity:'warning',source:'作業履歴',message:session.state.historyError,revision:doc?.revision});},[session.state?.historyError,notifications.add]);
  useEffect(()=>{if(session.error)notifications.add({severity:'error',source:'編集・保存',message:session.error,revision:doc?.revision});},[session.error,notifications.add]);
  useEffect(()=>{if(session.state?.externalChange)notifications.add({severity:'warning',source:'外部変更',message:session.state.externalChange.summary,revision:doc?.revision});},[session.state?.externalChange?.contentHash,notifications.add]);
  useEffect(()=>{
    const error=(event:ErrorEvent)=>notifications.add({severity:'error',source:'画面',message:event.message});
    const rejected=(event:PromiseRejectionEvent)=>notifications.add({severity:'error',source:'非同期処理',message:event.reason instanceof Error?event.reason.message:String(event.reason)});
    window.addEventListener('error',error);window.addEventListener('unhandledrejection',rejected);
    return()=>{window.removeEventListener('error',error);window.removeEventListener('unhandledrejection',rejected);};
  },[notifications.add]);
  const [activityOpen,setActivityOpen]=useState(()=>new URLSearchParams(location.search).get('agentActivity')==='review');
  const connection=useEditorAgentConnection(agent.bridge,projectId,operation=>{
    agent.release();if(operation.phase==='saved')setToast('AIの編集内容を保存しました。「AIの作業」で確認できます。');else setNotice('AIの作業結果を確認してください。');
  },!session.loading && !!session.error && !doc);
  useEffect(()=>{if(connection.error){agent.pauseAutoSave();setNotice(`${connection.error} 自動保存を一時停止しました。内容を確認して手動で保存してください。`);}},[connection.error]);
  const [autoSave, setAutoSave] = useState(loadAutoSaveEnabled);
  const [waveform,setWaveform]=useState(loadWaveformPref);
  const [trackHeight,setTrackHeight]=useState(loadTrackHeight);
  useEffect(() => {
    if (hasExplicitAutoSavePref()) return;
    const controller = new AbortController();
    void fetch('/api/config', { signal: controller.signal }).then(response => response.ok ? response.json() : null).then(body => {
      if (!controller.signal.aborted && !hasExplicitAutoSavePref() && body?.autoSaveDefaultEnabled === false) setAutoSave(false);
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);
  useAutoSave({ enabled: autoSave && !session.state?.externalChange && !scriptDraft && !inspectorDraft && !captionDraft && !manipulationBusy && !cutWorking && !boundaryWorking && !agent.autoSavePaused && connection.connection==='connected' && !connection.needsReview,
    dirty: session.state?.dirty ?? false, saveStatus: session.busy ? 'saving' : session.error ? 'error' : 'idle',
    state: doc, save: session.save, delayMs: parseAutoSaveDelayOverride(location.search) ?? undefined });
  const [initialView] = useState(() => readNativeView(projectId));
  const [mode, setMode] = useState(initialView.mode), [tab, setTab] = useState(initialView.tab);
  // サムネは動画のモード（確認・編集・仕上げ）とは別の画面。動画の mode は保ったまま重ねて開く。
  // 開いていたかは覚えない（案件は常に動画のモードで始める）。サムネの文書を読む・作るのは、切り替えた後で動画の文書が読み込み済みの時だけ。
  const [thumbnailOpen, setThumbnailOpen] = useState(false), [thumbnailPageId, setThumbnailPageId] = useState<string | null>(null);
  const thumbnail = useThumbnailSession(projectId, thumbnailOpen, !!doc), thumbnailWorkspace = useRef<ThumbnailWorkspaceHandle>(null);
  aiModeRef.current = thumbnailOpen ? 'thumbnail' : 'video';
  const flushThumbnail = useCallback(async () => !thumbnailWorkspace.current || await thumbnailWorkspace.current.flush(), []);
  const saveThumbnail = useCallback(async () => await flushThumbnail() && await thumbnail.save(), [flushThumbnail, thumbnail.save]);
  // サムネの自動保存（動画と同じ「操作が落ち着いたら」。トグルは動画と共通）。
  useAutoSave({ enabled: autoSave && !!thumbnail.state && !thumbnail.state.externalChange, dirty: thumbnail.state?.dirty ?? false,
    saveStatus: thumbnail.busy ? 'saving' : thumbnail.error ? 'error' : 'idle', state: thumbnail.state?.document, save: saveThumbnail,
    delayMs: parseAutoSaveDelayOverride(location.search) ?? undefined });
  /** 「再生位置に置く」の強調。画面状態だけで `viewState` には保存しない（C）。
   *  setter は C で足す（noUnusedLocals があるため、使う側が来るまで読み取りだけを置く）。 */
  const [placeHighlight,setPlaceHighlight]=useState<'video'|'image'|'bgm'|'se'|null>(null);
  const [rightTab,setRightTab]=useState<'transcript'|'script'|'properties'|'ai'>('properties');
  const [leftTab,setLeftTab]=useState<'projects'|'materials'>('projects');
  const [playing,setPlaying]=useState(false);
  const [switchingProject,setSwitchingProject]=useState(false),switchPending=useRef(false);
  const kHeld=useRef<ShuttleKeyState>({kHeld:false});
  const [finishTool,setFinishTool]=useState<'all'|'captions'|'color'|'audio'|'layout'|'fades'>('all');
  const [transfer,setTransfer]=useState<(TransferProgress&{name:string})|null>(null);
  const musicInput=useRef<HTMLInputElement>(null),audioRole=useRef<'music'|'effect'>('music');
  const [sceneFadeTarget,setSceneFadeTarget]=useState<SceneFadeTarget>({kind:'head'});
  const [transitionJoinKey,setTransitionJoinKey]=useState('');
  const [sceneFadeSwitching,setSceneFadeSwitching]=useState(false),sceneFadeSwitchPending=useRef(false);
  // 図形ツールバー。null＝閉じている、{kind:null}＝開いているがツール未選択。
  const [shapeTools,setShapeTools]=useState<{kind:ShapeKind|null}|null>(null);
  useEffect(()=>{setShapeTools(null);},[projectId,mode]);
  const prepareViewInputs=async()=>{
    if(player.current&&!await player.current.flushManipulation())return false;
    if(inspector.current&&!await inspector.current.flush())return false;
    if(scriptPanel.current&&!await scriptPanel.current.flush())return false;
    return !captionPanel.current||await captionPanel.current.flush();
  };
  const flushViewInputs=async()=>{
    if(timeline.current&&!await timeline.current.flush())return false;
    if(!await prepareViewInputs())return false;
    if(cutPanel.current&&!await cutPanel.current.flush())return false;
    return true;
  };
  const changeTab=async(next:typeof tab)=>{if(await flushViewInputs()){setPlaceHighlight(null);setTab(next);}};
  const changeMode=async(next:typeof mode)=>{if(silenceBusy)return;if(await flushViewInputs()){if(silenceOpen)closeSilence();cutSource.stop();setMode(next);}};
  const changeWorkspaceMode=async(next:NativeMode)=>{
    if(next==='thumbnail'){
      if(!doc||thumbnailOpen||silenceBusy||exportBusy)return;
      if(await flushViewInputs()){if(silenceOpen)closeSilence();cutSource.stop();player.current?.pause();setThumbnailOpen(true);}
      return;
    }
    if(thumbnailOpen){if(!await flushThumbnail())return;setThumbnailOpen(false);}
    await changeMode(next);
  };
  /** AI から戻る先。既定は「調整」。 */
  const lastDockTab=useRef<'transcript'|'script'|'properties'>('properties');
  const changeRightTab=async(next:typeof rightTab)=>{if(silenceBusy)return;if(await flushViewInputs()){if(next!==rightTab&&silenceOpen)closeSilence();if(next!=='ai')lastDockTab.current=next;setRightTab(next);setRightHidden(false);}};
  const openCut=async(id:string)=>{if(await flushViewInputs()){player.current?.pause();setActiveCutId(id);setCutPanelOpen(true);setRightTab('transcript');setRightHidden(false);}};
  const switchProject=async(id:string)=>{
    if(switchPending.current||session.busy||agent.busy||id===projectId)return;
    switchPending.current=true;setSwitchingProject(true);player.current?.pause();
    try {
      if(navigation){await navigation.navigate(id);return;}
      if(doc&&!await session.save())return;
      if(!await saveThumbnailForLeave())return;
      writeNativeView(projectId,view.current);
      tutorial.beforeNavigate(id);
      window.location.assign(`/?${new URLSearchParams({project:id})}`);
    } finally {switchPending.current=false;setSwitchingProject(false);}
  };
  const selectSceneFade=async(target:SceneFadeTarget)=>{
    if(sceneFadeSwitchPending.current)return false;
    sceneFadeSwitchPending.current=true;
    try{
      // All entry points commit the owned field before disabling it; preserve
      // the existing manipulation/Inspector/script flush order afterwards.
      inspector.current?.blurDraft();setSceneFadeSwitching(true);
      player.current?.pause();
      if(!await flushViewInputs())return false;
      setSceneFadeTarget(target);selectLiveClips(target.kind==='clip'?[target.clipId]:[]);setMode('finish');return true;
    }finally{sceneFadeSwitchPending.current=false;setSceneFadeSwitching(false);}
  };
  // 転換のつなぎ目は文書から導く。消えたつなぎ目を選んだままにしない。
  useEffect(()=>{
    if(!doc)return;
    const keys=transitionJoinsForUi(doc).map(join=>join.joinKey);
    setTransitionJoinKey(current=>keys.includes(current)?current:keys[0]??'');
  },[doc?.id,doc?.revision]);
  const [selected, setSelected] = useState<string[]>(initialView.selected), [range, setRange] = useState<NativeRange | null>(null), [frame, setFrame] = useState(initialView.frame);
  // Live selection and saved-band selection share one editing focus. A saved
  // activeCutId may remain a navigation hint, but never overrides a newer target.
  const selectLiveClips=(ids:string[])=>{setSelected(ids);setRange(null);setActiveCutId(null);setCutRestoreSelected(false);};
  const selectLiveRange=(next:NativeRange|null)=>{setRange(next);if(next){setSelected([]);setActiveCutId(null);setCutRestoreSelected(false);}};
  const [tool, setTool] = useState<NativeTool>('select'), [zoom, setZoom] = useState(initialView.zoom), [snap, setSnap] = useState(()=>loadEditorPrefs().snapDefault), [bypassLut, setBypass] = useState(false);
  const [rippleOn, setRipple] = useState(initialView.ripple);
  const [minZoom, setMinZoom] = useState(0.01);
  const [left, setLeft] = useState(initialView.left), [right, setRight] = useState(initialView.right), [bottom, setBottom] = useState(initialView.bottom);
  const [leftHidden, setLeftHidden] = useState(initialView.leftHidden), [rightHidden, setRightHidden] = useState(initialView.rightHidden), [assetPreview, setAssetPreview] = useState<string | null>(null);
  const minLeft=mode==='review'?300:190,minRight=mode==='finish'?340:240;
  const leftSize=Math.max(minLeft,left),rightSize=Math.max(minRight,right);
  const [inspectorOpen, setInspectorOpen] = useState(initialView.inspectorOpen);
  const [bottomAuto, setBottomAuto] = useState(initialView.bottomAuto), [leftPinned, setLeftPinned] = useState(false), [shellSize, setShellSize] = useState({ width: 0, height: 0 });
  // 要素は文書取得後にマウントされることがあるので、useEffect([]) ではなく callback ref で購読する（Codex 指摘 8）。
  const shellObserver = useRef<ResizeObserver | null>(null);
  const shell = useCallback((host: HTMLElement | null) => {
    shellObserver.current?.disconnect(); shellObserver.current = null;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => { const rect = entries[0]?.contentRect; if (!rect) return; const next = { width: Math.round(rect.width), height: Math.round(rect.height) }; setShellSize(size => size.width === next.width && size.height === next.height ? size : next); });
    observer.observe(host); shellObserver.current = observer;
  }, []);
  const [toolbarFitState, setToolbarFit] = useState<ToolbarFit>(TOOLBAR_FIT_INITIAL);
  const toolbarNarrow = toolbarFitState.compact;
  // ツールバーは文書取得後にマウントされるので callback ref で購読する（useEffect([]) だと初回に host が無く二度と付かない）。
  // I-7: 幅の固定閾値ではなく実測（scrollWidth > clientWidth）で退避を決める。モードでボタン数が違うため。
  const toolbarObserver = useRef<ResizeObserver | null>(null), toolbarHost = useRef<HTMLDivElement | null>(null);
  // M-6': DOM は observer / effect の本体で 1 度だけ読む（更新関数の中で読むと StrictMode の二重呼び出しで 2 回走る）。
  const measureToolbar = useCallback(() => {
    const host = toolbarHost.current; if (!host) return;
    const measure = { scrollWidth: host.scrollWidth, clientWidth: host.clientWidth };
    setToolbarFit(current => toolbarFit(current, measure));
  }, []);
  const toolbar = useCallback((host: HTMLDivElement | null) => {
    toolbarObserver.current?.disconnect(); toolbarObserver.current = null;
    toolbarHost.current = host;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measureToolbar());
    observer.observe(host); toolbarObserver.current = observer;
  }, [measureToolbar]);
  const narrow = isNarrow(shellSize.width);
  /** F1: 1200px 未満は左カラムを自動でレールに畳む。ユーザーがその幅で開いた（leftPinned）ならそのまま。 */
  const leftCollapsed = leftHidden || (narrow && !leftPinned);
  /**
   * I-5: 左カラムを開く唯一の入口。1200px 未満では `leftHidden=false` だけでは開かない
   * （`narrow && !leftPinned` で畳まれたまま）ので、その幅では「ユーザーが開いた」印も立てる。
   * 素の `setLeftHidden(false)` を残さないこと（片側だけ立てる穴の再発防止）。
   */
  const openLeft = (tab?: typeof leftTab) => { setLeftHidden(false); if (narrow) setLeftPinned(true); if (tab) setLeftTab(tab); };
  const effectiveRight = rightColumnWidth(shellSize.width, rightSize);
  const effectiveBottom = timelineBottom({ windowHeight: shellSize.height || window.innerHeight, bottom: bottomAuto ? null : bottom });
  const view = useRef(initialView); view.current = { mode,tab,selected,activeCutId,frame,zoom,left,right,bottom,bottomAuto,inspectorOpen,leftHidden,rightHidden,ripple:rippleOn };
  useImperativeHandle(navigation?.beforeLeave,()=>async nextProjectId=>{
    if(session.busy||silenceBusy)return false;
    player.current?.pause();
    // Failed loads and projects awaiting migration have no editing session to save.
    // Loaded documents must still flush drafts and successfully save before leaving.
    if(doc&&!await session.save())return false;
    if(!await saveThumbnailForLeave())return false;
    writeNativeView(projectId,view.current);
    if(nextProjectId)tutorial.beforeNavigate(nextProjectId);
    return true;
  });
  useEffect(() => {
    const saveView = () => writeNativeView(projectId,view.current);
    window.addEventListener('pagehide',saveView); return () => { saveView(); window.removeEventListener('pagehide',saveView); };
  }, [projectId]);
  useEffect(() => {
    const timer = setTimeout(() => writeNativeView(projectId,view.current),250); return () => clearTimeout(timer);
  }, [projectId,mode,tab,selected,activeCutId,frame,zoom,left,right,bottom,bottomAuto,inspectorOpen,leftHidden,rightHidden,rippleOn]);
  const [sourceOpen, setSourceOpen] = useState(false);
  const audition = useAssetAudition();
  const [materialSource,setMaterialSourceState]=useState<'project'|'library'>(readMaterialSource);
  const library = useLibraryListing(leftTab==='materials'&&materialSource==='library');
  const [librarySave,setLibrarySave]=useState<{asset:SequenceAsset;kind:'se'|'bgm'|'image'}|null>(null);
  const setMaterialSource=(value:'project'|'library')=>{setMaterialSourceState(value);try{localStorage.setItem(MATERIAL_SOURCE_KEY,value);}catch{/* 記憶できなくても切り替えは有効 */}};
  // 案件から外した素材（file はまだ残っている）。doc.assets から消えた後もゴミ箱ボタンへ辿れるよう別枠で持つ。
  const [removedAssets, setRemovedAssets] = useState<SequenceAsset[]>([]);
  useEffect(() => { setRemovedAssets([]); audition.stop(); }, [projectId, audition.stop]);
  const [notice, setNotice] = useState<string | null>(null), [legacyChanged, setLegacyChanged] = useState(false), [speechId, setSpeechId] = useState('');
  useEffect(()=>{if(notice)notifications.add({severity:'info',source:'編集画面',message:notice,revision:doc?.revision});},[notice,notifications.add]);
  const [exportBusy,setExportBusy]=useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false), [toast, setToastState] = useState<{ id: number; message: string } | null>(null);
  // M-3: 同一文言を続けて出してもタイマーが数え直されるよう、毎回新しい id を振る。
  const toastId = useRef(0);
  const setToast = useCallback((message: string | null) => { setToastState(message === null ? null : { id: ++toastId.current, message }); }, []);
  // サムネの書き出しはサムネ画面の外で見張る（書き出し中に動画のモードへ戻っても、終わったら知らせる）。
  const thumbnailExport = useThumbnailExport({ projectId, session: thumbnail, flush: flushThumbnail, onToast: setToast });
  /** 画面を離れる前にサムネの入力を確定して保存する。失敗したら編集を残して離れない（受け入れ 11）。 */
  const saveThumbnailForLeave=async()=>{
    if(!thumbnail.readCurrent())return true;
    if(await saveThumbnail())return true;
    setNotice('サムネを保存できなかったため、移動を止めました。サムネの編集はそのまま残っています。');
    return false;
  };
  const [prefs,setPrefsState]=useState(loadEditorPrefs),[settingsOpen,setSettingsOpen]=useState(false);
  // 設定から現行UIのヘルプ（チュートリアル図鑑）を開く。
  const [helpOpen,setHelpOpen]=useState(false);
  const setPrefs=(next:EditorPrefs)=>{setPrefsState(next);saveEditorPrefs(next);};
  useEffect(()=>{document.documentElement.toggleAttribute('data-reduce-motion',prefs.reduceMotion);return()=>document.documentElement.removeAttribute('data-reduce-motion');},[prefs.reduceMotion]);
  useEffect(()=>{configureUiSound(prefs.sound);},[prefs.sound]);
  const cutSource=useCutSourcePreview({projectId,sessionId:session.state?.sessionId,document:doc??null,mode,activeCutId,player,prepare:flushViewInputs,readDocument:()=>nativeSession.readCurrent()?.document??null,onError:setNotice,onProgramFrame:setFrame});
  const [inclusive,setInclusive]=useState<(ReturnType<typeof cutInclusivePreview>&{source:SequenceDocument;sessionId:string;initialFrame:number})|null>(null);
  const [inclusiveFrame,setInclusiveFrame]=useState(0);
  const inclusiveActive=inclusive&&inclusive.source.id===doc?.id&&inclusive.source.revision===doc?.revision&&inclusive.sessionId===session.state?.sessionId&&mode==='finish'?inclusive:null;
  useEffect(()=>{if(inclusive&&!inclusiveActive)setInclusive(null);},[inclusive,inclusiveActive]);
  // 素材・BGM の試し差し替え。案件・セッション・文書 id・版が変わればフックが解除して知らせる。
  const trialSwap=useTrialSwap({current:{projectId,sessionId:session.state?.sessionId,document:doc},executeAt:nativeSession.executeAt,refresh:nativeSession.refreshStatus,onNotice:message=>{player.current?.pause();setNotice(message);}});
  const trial=trialSwap.trial,editLocked=session.busy||!!trial;
  const imports=useImportBatches(projectId,{ready:!!doc&&!trial&&!switchingProject,confirm:(batchId,skipFailed)=>nativeSession.confirmImport(batchId,skipFailed),
    onPlaced:batch=>{const message=audioOnlyNotice(batch);if(message)setNotice(message);}});
  const importFramesNow=useMemo(()=>doc?imports.frames(doc):[],[doc,imports.frames]),importUnplaced=useMemo(()=>doc?imports.unplaced(doc):[],[doc,imports.unplaced]);
  const cancelImport=(batchId:string)=>{void imports.cancel(batchId).then(message=>{if(message)setNotice(message);});};
  // 開いた時に確定を促す（設計 §1）: 案件を開いて最初に一覧が届いた時、促す束（素材の欄に出す「準備済み・未配置」・失敗を含む束・確定の印があるのに文書に無い束）が
  // あれば、左の欄を素材タブへ1回だけ切り替える。以後（利用者がタブを選んだ後・開いている間に来た束）は切り替えない。自動確定の束（自分・ホーム・AI）は pending に入らない。
  const importPromptDecided=useRef<string|null>(null);
  // 開いた時の案内（遅い媒体）も同じ規則で、最初に案内が届いた時に1回だけ素材タブへ切り替える（2026-10-06 決定）。利用者がタブを選んだ後は切り替えない。
  // 案内は裏の照合が速さを測ってから届くので、取り込みの一覧（開いてすぐ届く）とは別に決める。
  const slowAdvicePrompted=useRef<string|null>(null);
  const chooseLeftTab=(tab:typeof leftTab)=>{importPromptDecided.current=projectId;slowAdvicePrompted.current=projectId;setLeftTab(tab);};
  useEffect(()=>{importPromptDecided.current=null;slowAdvicePrompted.current=null;},[projectId]);   // 別の案件から戻った時も、開き直しとして判断し直す
  useEffect(()=>{
    if(!doc||switchingProject||!imports.listed||importPromptDecided.current===projectId)return;
    importPromptDecided.current=projectId;if(imports.pending.length||importUnplaced.length)setLeftTab('materials');
  },[doc,switchingProject,imports.listed,imports.pending,importUnplaced,projectId]);
  /** プレビューが読み込めなかった試し用文書。作り直す（候補・終わり方・始め直し）と別物になり、採用の無効も解ける。 */
  const [trialFailed,setTrialFailed]=useState<SequenceDocument|null>(null);
  const trialStartMode=useRef(mode);
  // 終了の条件（設計 §3-9）: 使用箇所の外のクリップを選ぶ・設定欄の別タブへ移る・編集モードを切り替える。採用中は採用の完了に任せる。
  // 選択が空になるだけでは終えない（タイムラインの空き部分を押して再生位置を動かしても試しは続き、帯の採用・戻すで抜ける）。
  // 続けるかどうかは、節の表示・開始の受付と同じ述語（trialSelectable）で決める。
  useEffect(()=>{
    if(!trial||trial.adopting||!doc)return;
    if(rightTab!=='properties'||mode!==trialStartMode.current||!trialSelectable(doc,selected,trial.result.clipIds)){player.current?.pause();trialSwap.revert();}
  },[trial,doc,selected,rightTab,mode,trialSwap.revert]);
  // 試せなかった理由は、選択が変わったら消す。
  const selectionKey=selected.join('\n');
  useEffect(()=>{trialSwap.clearError();},[selectionKey,trialSwap.clearError]);
  /**
   * I'-2: 再測定の契機を「箱の変化」（ResizeObserver）だけにすると、箱は同じで**中身だけが増える**
   * 状態変化で退避が発火しない。仕上げでカットを選ぶと「選択範囲を戻す」が現れて必要幅が約 110px
   * 増えるので、ツールバーの中身を決める state を依存にして同じ判定を回す。
   * `toolbarFitState.compact` も依存に入れる（退避・復帰の直後に、減った／戻った中身で測り直す）。
   * M-1: `zoom.toFixed(2)` の桁数が変わる（例: "1.00×"→"10.00×"）とズーム欄の幅が変わり必要幅も
   * 動くので、桁数が変わった時だけ再測定する（値そのものではなく `.length` を依存にして、
   * 小数第2位の変化のたびには測り直さない）。
   */
  useLayoutEffect(()=>{measureToolbar();},
    [measureToolbar,mode,cutRestoreSelected,range,selected.length,!!inclusiveActive,toolbarFitState.compact,zoom.toFixed(2).length]);
  const inclusivePoint=inclusiveActive?finishDisplayPoint(inclusiveActive.map,inclusiveFrame,'after'):null;
  const inclusiveMarker=inclusivePoint?.kind==='archived'?{entryId:inclusivePoint.entryId,localFrame:inclusivePoint.localFrame}:undefined;
  const toggleInclusive=async()=>{
    if(inclusiveActive){player.current?.pause();setInclusive(null);return;}
    if(!await flushViewInputs())return;
    const current=nativeSession.readCurrent();if(!current)return;
    try{
      const preview=cutInclusivePreview(current.document),at=finishLiveToDisplay(preview.map,frame,'before')??0;
      cutSource.stop();setInclusiveFrame(at);setInclusive({...preview,source:current.document,sessionId:current.sessionId,initialFrame:at});
    }catch(error){setNotice(error instanceof Error?error.message:String(error));}
  };
  /** 試しの切り替えの前に再生を止め、プレイヤーの実際の位置を次の表示へ引き継ぐ（設計 §3-3）。 */
  const holdTrialFrame=()=>{const at=player.current?.frame()??frame;player.current?.pause();setFrame(at);};
  /** 開始の処理中か。並んだ開始は後の方を捨てて知らせる（前の開始の確定を待つ間に2本目が走ると、同じ基準から別の試しが2つ作られる。設計 §5）。 */
  const trialStarting=useRef(false);
  const startTrial=async(clipId:string,assetId:string)=>{
    if(trialStarting.current){setNotice('操作が終わってから試してください');return;}
    trialStarting.current=true;
    try{await startTrialNow(clipId,assetId);}finally{trialStarting.current=false;}
  };
  const startTrialNow=async(clipId:string,assetId:string)=>{
    if(!await flushViewInputs())return;
    if(manipulationBusy||workBusy||preparingSave){setNotice('操作が終わってから試してください');return;}
    const current=nativeSession.readCurrent();if(!current)return;
    // 確認表示中のプレイヤーは本編と別の位置で動いているので、そのときは本編の位置（frame）から始める。
    const at=inclusiveActive||cutSource.active||silencePreview?frame:player.current?.frame()??frame;
    setInclusive(null);cutSource.stop();setSilencePreview(null);setInspectorVisual(null);player.current?.pause();
    // 初回の開始時だけ、再生位置が使用箇所の外なら使用箇所の先頭へ移す。自動では再生しない。
    const usage=trialUsage(current.document,clipId),inside=usage.some(clip=>at>=clip.startFrame&&at<clipEnd(clip));
    trialStartMode.current=mode;
    if(trialSwap.start({projectId,sessionId:current.sessionId,document:current.document},clipId,assetId))setFrame(inside||!usage[0]?at:usage[0].startFrame);
  };
  const chooseTrial=(assetId:string)=>{if(!trial||trial.adopting)return;holdTrialFrame();trialSwap.choose(assetId);};
  const trialEndMode=(next:TrialEndMode)=>{if(!trial||trial.adopting)return;holdTrialFrame();trialSwap.setEndMode(next);};
  const revertTrial=()=>{if(!trial||trial.adopting)return;holdTrialFrame();trialSwap.revert();};
  const adoptTrial=()=>{if(!trial||trial.adopting)return;holdTrialFrame();void trialSwap.adopt();};
  const seekProgram=(at:number)=>{
    if(inclusiveActive){void player.current?.seek(finishLiveToDisplay(inclusiveActive.map,at,'after')??at);return;}
    cutSource.seekProgram(at);
  };
  const previewFrame=(at:number)=>{
    if(silencePreview){if(at>=silencePreview.end)player.current?.pause();return;}
    if(!inclusiveActive){cutSource.onFrame(at);return;}
    setInclusiveFrame(at);
    const point=finishDisplayPoint(inclusiveActive.map,at,'after');
    if(point?.kind==='live')setFrame(point.frame);
    else if(point){const block=inclusiveActive.map.blocks.find(b=>b.kind==='archived'&&b.entryId===point.entryId);if(block?.kind==='archived')setFrame(block.atFrame);}
  };
  /**
   * 「詰める」を今この操作に適用してよいか。トグルの disabled と NativeTimeline へ渡す値を
   * 同じ 1 式から出す（最終広域レビュー I-2）。確認モード・カット確認中はトグルが無効なのに
   * 挙動だけ ON のままだと、元素材を見比べている最中の端ドラッグが全トラックを詰めてしまう。
   * 記憶する値（`rippleOn`）とは分ける — 確認を抜ければ元の ON/OFF に戻る。
   */
  const rippleUsable=mode!=='review'&&!cutSource.active&&!inclusiveActive&&!silencePreview&&!trial;
  const showSilencePreview=(document:SequenceDocument|null,start=0,end=0)=>{player.current?.pause();silenceStarted.current=false;setSilencePreview(document?{document,start,end}:null);};
  const closeSilence=()=>{showSilencePreview(null);silenceReturnFocus.current=true;setSilenceOpen(false);};
  const fileInput = useRef<HTMLInputElement>(null), lutInput = useRef<HTMLInputElement>(null);
  const [referencePicker,setReferencePicker]=useState<SequenceAsset|'add'|null>(null),[mediaGeneration,setMediaGeneration]=useState(0);
  const referenceStatuses=useNativeReferenceStatus(projectId,doc?.assets,mediaGeneration,()=>setMediaGeneration(value=>value+1));
  // 照合中（checking）はエラーではないのでバナーに入れない（素材行に「確認中」だけ出す）。
  const unavailableReferences=(doc?.assets??[]).filter(asset=>referenceUnavailable(referenceStatuses[asset.id]));
  // 速いドライブへのコピー（設計 §6）。この画面で見ていた作業が終わったら知らせる。
  // 裏で接続が変わった素材は、作業の終わりにまとめて1回読み直す（プレビュー・タイムラインを作り直す）。再生中なら止まってから（再生を途中で切らない）。
  const [copyReload,setCopyReload]=useState<string|null>(null);
  const copyJobs=useMediaCopyJobs(projectId,()=>setCopyReload(projectId),job=>setToast(copySettledMessage(job)));
  useEffect(()=>{if(copyReload===null||playing)return;setCopyReload(null);if(copyReload===projectId)setMediaGeneration(value=>value+1);},[copyReload,playing,projectId]);
  // コピー先を選ぶ対象は選んだ時の案件と組で持つ（案件を切り替えたら、前の案件の対象で候補を調べない）
  const [copyRequest,setCopyRequest]=useState<{projectId:string;targets:CopyTargets}|null>(null);
  const copyTargets=copyRequest?.projectId===projectId?copyRequest.targets:null;
  const setCopyTargets=(targets:CopyTargets|null)=>setCopyRequest(targets&&{projectId,targets});
  // 開いた時の案内（設計 §1・§2）。このエディターがコピー中の素材と、今の文書に無い素材は出さない。
  // 追加時に「今回はこのまま」を選んだ素材は、この画面を閉じるまで開いた時の案内にも出さない（このページで判断待ちとして見た束の項目の選択だけを素材 ID へ引き継ぐ）。
  const slowAdvice=useSlowMediaAdvice(projectId,referenceStatuses,!!doc&&!switchingProject);
  const visibleAdvice=useMemo(()=>{
    const advice=slowAdvice.advice,targets=(advice?.targets??[]).filter(target=>!copyJobs.activeAssetIds.has(target.assetId)&&!!doc?.assets.some(asset=>asset.id===target.assetId));
    return advice&&targets.length?{...advice,targets,totalBytes:targets.reduce((sum,target)=>sum+target.sizeBytes,0),totalSeconds:targets.reduce((sum,target)=>sum+target.seconds,0)}:null;
  },[slowAdvice.advice,copyJobs.activeAssetIds,doc?.assets]);
  useEffect(()=>{
    if(!visibleAdvice||switchingProject||slowAdvicePrompted.current===projectId)return;
    slowAdvicePrompted.current=projectId;setLeftTab('materials');
  },[visibleAdvice,switchingProject,projectId]);
  const keepSlowOnce=slowAdvice.keepOnce;
  useEffect(()=>{
    // 引き継ぐのは、このページで判断待ち（decision 付き）として見た束だけ（ディスクに残る前のページの束は引き継がない＝読み直すと再び出る）。
    // 「今後この場所では出さない」はサーバが案内から外すので引き継がない（接続先が変われば再び出る）。切り替えた直後の描画に残る前の案件の束は使わない。
    const mine=imports.all.filter(batch=>batch.projectId===projectId);
    for(const batch of mine)if(batch.decision)noteAskedBatch(batch.projectId,batch.batchId);
    const ids=mine.filter(batch=>wasAskedBatch(batch.projectId,batch.batchId)).flatMap(batch=>batch.items.flatMap(item=>item.choice==='keep-once'&&item.assetId?[item.assetId]:[]));
    if(ids.length)keepSlowOnce(ids);
  },[imports.all,keepSlowOnce,projectId]);
  // 追加時のコピーで終わらなかった項目（残りを中止・失敗・結果不明）。同じ束に判断の案内が再び付いた時、前回のコピーが終わらなかったことを添える。
  const unfinishedCopies=useMemo(()=>new Set(copyJobs.jobs.filter(job=>job.mode==='add'&&job.state!=='running')
    .flatMap(job=>job.items.flatMap(item=>item.batchItem&&item.phase!=='done'?[`${item.batchItem.batchId}:${item.batchItem.itemId}`]:[]))),[copyJobs.jobs]);
  const [inspectorVisual,setInspectorVisual]=useState<(NativeVisualPreview&{projectId:string;sessionId:string;mediaGeneration:number})|null>(null);
  const visualPreview=inspectorVisual&&inspectorVisual.projectId===projectId&&inspectorVisual.sessionId===session.state?.sessionId
    &&inspectorVisual.documentId===doc?.id&&inspectorVisual.revision===doc?.revision&&inspectorVisual.mediaGeneration===mediaGeneration
    &&selected[0]===inspectorVisual.clipId&&rightTab==='properties'&&mode!=='review'&&!cutSource.active?inspectorVisual:null;
  const previewInspectorVisual=(clipId:string,visual:ClipVisual|null)=>{
    const current=nativeSession.readCurrent();
    if(!visual){setInspectorVisual(value=>value?.clipId===clipId?null:value);return;}
    if(!current||!doc||current.sessionId!==session.state?.sessionId||current.document.id!==doc.id||current.document.revision!==doc.revision
      ||agent.busy||cutWorking||boundaryWorking||nativeSession.busy&&inspectorSaving.current===0||selected[0]!==clipId||cutSource.active)return;
    setInspectorVisual({projectId,sessionId:current.sessionId,mediaGeneration,documentId:doc.id,revision:doc.revision,clipId,visual});
  };
  const referenceOwner=useRef({}),referencePending=useRef<object|null>(null);
  const closeReferencePicker=()=>{referenceOwner.current={};setReferencePicker(null);};
  const openReferencePicker=(target:SequenceAsset|'add')=>{referenceOwner.current={};setReferencePicker(target);};
  useEffect(()=>{referenceOwner.current={};return()=>{referenceOwner.current={};};},[projectId]);
  const wordStart = useRef<number | null>(null);
  const resize = usePanelResize();
  useEffect(() => { if (doc) setSelected(ids => ids.filter(id => doc.clips.some(c => c.id === id))); }, [doc?.revision]);
  useEffect(()=>{
    if(!doc)return;
    const ids=new Set(doc.cutArchive?.entries.map(entry=>entry.id)??[]),previous=cutSnapshot.current;
    const added=previous?.documentId===doc.id?[...ids].filter(id=>!previous.ids.has(id)):[];
    cutSnapshot.current={documentId:doc.id,ids,groups:doc.cutArchive?.groups?.map(group=>group.entryIds)??[]};
    setActiveCutId(current=>{
      const retained=current&&ids.has(current)?current:previous?.documentId===doc.id?previous.groups.find(group=>current&&group.includes(current))?.find(id=>ids.has(id)):null;
      return added.at(-1)??retained??null;
    });
  },[doc]);
  useEffect(() => {
    if (!doc) return;
    const controller = new AbortController();
    void nativeRequest<{ status: string }>(projectId, '/legacy-status', undefined, controller.signal).then(value => setLegacyChanged(value.status === 'changed')).catch(() => undefined);
    return () => controller.abort();
  }, [projectId, doc?.id]);
  const inspectorCommand = async (operation: NativeCommand): Promise<boolean> => {
    // 編集操作の共通入口。各入口の止めに漏れがあっても、試し中（最新の状態を ref で読む）は送らずに知らせる（設計 §3-8）。
    if (trialSwap.readTrial()) { setNotice(TRIAL_LOCKED); return false; }
    cutSource.stop(false); setInclusive(null); setNotice(null);
    const ok = await session.execute(operation); if (ok && operation.type !== 'set-track-enabled') setRange(null); return ok;
  };
  const propertyCommand=async(operation:NativeCommand):Promise<boolean>=>{
    inspectorSaving.current++;
    try{return await inspectorCommand(operation);}finally{inspectorSaving.current--;}
  };
  const flushEditInputs = async (): Promise<boolean> => {
    if(timeline.current&&!await timeline.current.flush())return false;
    if(player.current&&!await player.current.flushManipulation())return false;
    if(inspector.current&&!await inspector.current.flush())return false;
    if(captionPanel.current&&!await captionPanel.current.flush())return false;
    return true;
  };
  const command = async (operation: NativeCommand): Promise<boolean> => {
    if(!await flushEditInputs())return false;
    return inspectorCommand(operation);
  };
  const prepareCaption=async()=>{
    player.current?.pause();
    if(player.current&&!await player.current.flushManipulation())return false;
    return !inspector.current||await inspector.current.flush();
  };
  const cut = () => { if (range && range.endFrame > range.startFrame) void command({ type: 'ripple-delete', startFrame: range.startFrame, endFrame: range.endFrame }).then(ok => { if (ok) seekProgram(range.startFrame); }); };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (thumbnailOpen) return; // サムネの操作は NativeThumbnailWorkspace が受ける
      const target = event.target as HTMLElement;
      if (event.defaultPrevented || isModalOpen() || document.querySelector('[role=dialog][aria-modal=true]') || event.isComposing
        || target.closest('input,textarea,select,[contenteditable=true],[role=dialog]')) return;
      const id = matchShortcut(event);
      if (id === null) return;
      if (id === 'help') { event.preventDefault(); setShortcutsOpen(true); return; }
      if (id === 'escape') { setRange(null); setSelected([]); setActiveCutId(null); return; }
      if (id === 'play-toggle') { event.preventDefault(); player.current?.toggle(); return; }
      if (id === 'frame-step') { event.preventDefault(); const delta=(event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1); player.current?.seekBy(delta); return; }
      // I-3: トランスポートの title が約束する Home / End。末尾はボタン（NativePreview の「末尾へ」）と同じ式に揃える。
      if (id === 'jump-edge') { event.preventDefault(); void player.current?.seek(event.key === 'Home' ? 0 : Math.max(0, (inclusiveActive?.document.sequenceEndFrame??doc?.sequenceEndFrame ?? 1) - 1)); return; }
      if (id === 'shuttle') { if (shuttleKeyDown(event, kHeld.current, player.current, prefs.shuttleMax)) return; }
      if (mode === 'review') return;
      if(inclusiveActive){
        if(!session.busy&&id==='delete'&&cutRestoreSelected&&!range&&!selected.length){event.preventDefault();void timeline.current?.restoreCut();}
        return;
      }
      if (session.busy) return;
      if (id === 'save') { event.preventDefault(); void session.save(); }
      // 試し中: 工具・スナップなど内容を変えないキーは通し、編集のキー（詰めるを含む）は止めて知らせる（設計 §3-8）。
      else if (trial && (id === 'undo' || id === 'split' || id === 'delete' || id === 'ripple')) { event.preventDefault(); setNotice(TRIAL_LOCKED); }
      else if (id === 'undo') { event.preventDefault(); void command({ type: event.shiftKey ? 'redo' : 'undo' }); }
      else if (id === 'split' && selected.length) { event.preventDefault(); void command({ type: 'split', clipIds: selected, frame }); }
      else if (id === 'delete') { event.preventDefault(); if (range) cut(); else if (selected.length) void command({ type: 'delete', clipIds: selected }); else if (mode==='finish'&&cutRestoreSelected) void timeline.current?.restoreCut(); }
      else if (id === 'tool-select') setTool('select');
      else if (id === 'tool-razor') setTool('razor');
      else if (id === 'tool-range') setTool('range');
      else if (id === 'snap') setSnap(value => !value);
      // 工具帯のトグルと同じ条件で止める（確認モードは上の早期 return、カット確認中はここ）。
      else if (id === 'ripple') { if (!cutSource.active) setRipple(value => !value); }
    };
    const keyUp=(event:KeyboardEvent)=>{ shuttleKeyUp(event,kHeld.current); };
    const blur=()=>{ shuttleBlur(kHeld.current); };
    window.addEventListener('keydown', key); window.addEventListener('keyup', keyUp); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', keyUp); window.removeEventListener('blur', blur); };
  }, [frame, selected, range, session.busy, trial, session.execute, session.save,mode,cutRestoreSelected,prefs.shuttleMax,doc?.sequenceEndFrame,cutSource.active,inclusiveActive,thumbnailOpen]);
  const startResize = (event: PointerEvent<HTMLDivElement>, axis: 'left' | 'right' | 'bottom') => {
    const start = axis === 'bottom' ? event.clientY : event.clientX;
    const value = axis === 'left' ? leftSize : axis === 'right' ? rightSize : effectiveBottom;
    resize.start(event, move => {
      const delta = (axis === 'bottom' ? move.clientY : move.clientX) - start;
      if (axis === 'left') setLeft(Math.min(420, Math.max(minLeft, value + delta)));
      else if (axis === 'right') setRight(Math.min(460, Math.max(minRight, value - delta)));
      else { setBottomAuto(false); setBottom(Math.min(window.innerHeight * .6, Math.max(170, value - delta))); }
    });
  };
  const resizeProps = (axis: 'left' | 'right' | 'bottom') => ({ role: 'separator', tabIndex: 0, 'aria-label': `${axis === 'left' ? '素材' : axis === 'right' ? '設定' : 'タイムライン'}パネルのサイズ`,
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => startResize(event, axis), onPointerMove: resize.onPointerMove, onLostPointerCapture: resize.onLostPointerCapture,
    onKeyDown: (event: React.KeyboardEvent) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      if (axis === 'left' && leftCollapsed || axis === 'right' && rightHidden) return;
      event.preventDefault();event.stopPropagation(); const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 20 : -20;
      if (axis === 'left') setLeft(Math.max(minLeft, Math.min(420, leftSize + delta)));
      else if (axis === 'right') setRight(Math.max(minRight, Math.min(460, rightSize - delta)));
      // 自動だった時だけ表示値から始め、以後は前の値へ積む。同一描画内に連続で来ても増分を落とさない（M-10）。
      else { const from = bottomAuto ? effectiveBottom : null; setBottomAuto(false); setBottom(value => Math.max(170, Math.min(window.innerHeight * .6, (from ?? value) - delta))); }
    } } });
  const fitPreviewPanels = () => {
    const box=document.querySelector('.native-workspace .native-preview-box');
    const image=document.querySelector('.native-workspace .native-preview-stage');
    if(!box||!image)return;
    // Use only horizontal letterboxing. Never crop or enlarge the image past its available height.
    const space=Math.max(0,box.getBoundingClientRect().width-image.getBoundingClientRect().width-24);
    const gains=fitPanelGains({space,narrow,leftCollapsed,rightHidden,leftSize,rightSize});
    setRight(rightSize+gains.right);setLeft(leftSize+gains.left);
  };
  const addTrack = (kind: 'visual' | 'audio') => { if (doc) void command({ type: 'add-track', track: { id: newId(), name: `${kind === 'visual' ? '映像' : '音声'}${doc.tracks.filter(t => t.kind === kind).length + 1}`, kind, enabled: true },...(kind==='visual'?{index:sceneFadeInsertionIndex(doc)}:{}) }); };
  const insertAsset = (assetId: string, at = frame, targetTrackId?: string,role?:'music'|'effect') => {
    const doc=nativeSession.readCurrent()?.document;
    if (!doc) return;
    if (trial) { setNotice(TRIAL_LOCKED); return; }
    const asset = doc.assets.find(a => a.id === assetId); if (!asset || asset.kind === 'lut' || asset.kind === 'component') return;
    const placed = buildMediaPlacement(doc, asset, at, targetTrackId, role ? { role } : {}, newId);
    if ('error' in placed) { setToast(placed.error); return; }
    void command({ type: 'batch', commands: placed.commands }).then(ok => { if (ok) selectLiveClips([placed.selectId]); });
  };
  /** メインの末尾に順に並べる（設計 §1 ①②）。断られた理由（速度など）はそのまま知らせる。 */
  const appendMain=async(assetIds:string[]):Promise<boolean>=>{
    if(trialSwap.readTrial()){setNotice(TRIAL_LOCKED);return false;}
    const owner=importOwner.current;
    if(!assetIds.length||!await flushViewInputs()||owner!==importOwner.current)return false;
    // 共通の入口（inspectorCommand）と同じ手順: 入力の確定の後に試し中を最新の状態で判定し、送信前にカット元の再生と範囲の印を止める。
    if(trialSwap.readTrial()){setNotice(TRIAL_LOCKED);return false;}
    cutSource.stop(false);setInclusive(null);setNotice(null);
    const result=await session.appendToMain(assetIds);
    // 成功したら範囲の選択を解除する（共通の入口 command と同じ）。断られた時は理由を知らせ、選択は残す。
    if(owner===importOwner.current){if(result.ok)setRange(null);else setNotice(result.message);}
    return result.ok;
  };
  const placingKeys = useRef(new Set<string>());
  const [placingList, setPlacingList] = useState<string[]>([]);
  const placeLibrary = async (key: string, at = frame, trackId?: string) => {
    if (trial) { setNotice(TRIAL_LOCKED); return; }
    if (editLocked || placingKeys.current.has(key)) return;
    const listing = library.listing; if (!listing?.ok) return;
    const target = findLibraryTarget(listing.catalog, key); if (!target) return;
    placingKeys.current.add(key); setPlacingList([...placingKeys.current]);
    try {
      // 共通の入口（command → inspectorCommand）と同じ手順: 入力の確定 → 試し中かの最新判定 → 送信 → 後始末。
      if (!await flushEditInputs()) return;
      if (trialSwap.readTrial()) { setNotice(TRIAL_LOCKED); return; }
      cutSource.stop(false); setInclusive(null); setNotice(null);
      const result = await nativeSession.placeFromLibrary(key, (doc, asset) => buildLibraryPlacement(doc, asset, target, at, trackId, newId), () => trialSwap.readTrial() ? TRIAL_LOCKED : null);
      if (!result.ok) { if (result.message === TRIAL_LOCKED) setNotice(TRIAL_LOCKED); else setToast(result.message); return; }
      setRange(null);
      selectLiveClips([result.selectId]);
      if (target.kind === 'template') { setRightTab('properties'); setRightHidden(false); }
    } finally { placingKeys.current.delete(key); setPlacingList([...placingKeys.current]); }
  };
  const auditionLibrary = (key: string) => {
    const listing = library.listing; if (!listing?.ok) return;
    const item = listing.catalog.media.find(m => m.key === key); if (!item) return;
    player.current?.pause(); audition.toggle(item.key, libraryFileUrl(item.key, 'media'), item.kind === 'bgm' ? 'bgm' : 'se');
  };
  // 「案件から外す」＝ remove-asset（未参照のみ・Undo可・ファイルは残る）。
  // 参照が1件でもあれば送らず、場所を示して拒否する（設計 I）。
  // サーバー側も同じ判定を二重に行うが（remove-asset の実装は sequenceAssetReferences）、
  // command() は内部で失敗を捕まえて false を返すだけで例外を投げないため、
  // ここでの再拒否メッセージはサーバー到達前のプリチェック専用。サーバー拒否時は
  // 既存の通知バー（session.error、対象クリップ名つき）がそのまま表示される。
  const removeAsset = async (assetId: string) => {
    const current = nativeSession.readCurrent()?.document; if (!current) return;
    const usage = assetUsage(current, assetId);
    // R3-M6: 行動指示は参照の種類（place）ごとに assetUsage 側で出し分ける
    // （audio-fix-origin はタイムラインではなく補正の解除を案内する）。
    if (usage.count > 0) { setNotice(`この素材は ${usage.count} 箇所で使われています（${usage.places.join('・')}）。${usage.action}`); return; }
    const removing = current.assets.find(a => a.id === assetId);
    const ok = await command({ type: 'remove-asset', assetId });
    // 外した素材は doc.assets からすぐ消えるため（一覧の行も消える）、ゴミ箱ボタンは
    // 別枠の「外した素材」トレイへ移す。ここで捕まえておかないと二度と辿れない。
    if (ok && removing) { setRemovedAssets(value => [...value.filter(a => a.id !== assetId), removing]); setToast('素材を案件から外しました。ファイルは案件フォルダに残ります。'); }
  };
  // 「ゴミ箱へ移す」＝ 既存 /api/material（ファイル移動・Undo不可・ホーム画面のゴミ箱から復元）。
  // native の管理素材（.harness/assets/…・.harness/references/…）は legacy の素材ライブラリに
  // 載っていないため対象外。public/ 配下の素材にのみ表示・適用する。
  const trashAsset = async (asset: SequenceAsset): Promise<boolean> => {
    const entry = MATERIAL_KINDS.find(([prefix]) => asset.file.startsWith(prefix));
    if (!entry) { setNotice('この素材はエディタの管理領域にあるため、ゴミ箱へは移せません。案件から外すだけで表示されなくなります。ファイルは案件フォルダに残ります。'); return false; }
    const [prefix, kind] = entry;
    const response = await fetch(`/api/material?${new URLSearchParams({ id: projectId, kind, file: asset.file.slice(prefix.length) })}`, { method: 'DELETE' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setNotice(body.error === 'in-use' ? `この素材は ${body.count} 箇所で使われています。先に外してください。`
        : body.error === 'scan-failed' ? '使用状況を確認できなかったため、削除を保留しました。'
        : body.error ?? 'ゴミ箱へ移せませんでした。');
      return false;
    }
    setToast('ファイルをゴミ箱へ移しました。ホーム画面のゴミ箱から戻せます。');
    return true;
  };
  /** チュートリアルの手順に入るとき、対象が見える画面へ整える（既存の入力確定処理を通す）。 */
  const prepareTutorial = async (prep: NativeStepPrep): Promise<void> => {
    if (prep.mode !== undefined && mode !== prep.mode) await changeMode(prep.mode);
    if (prep.left !== undefined) openLeft(prep.left);
    if (prep.right) setRightHidden(false);
  };
  /** 体験で本人が足したテロップ 1 件（と空になったトラック）だけを消す。後続の編集は巻き戻さない。 */
  const removeTutorialTelop = async (record: NativeTelopRecord): Promise<boolean> => {
    const current = nativeSession.readCurrent()?.document;
    if (!current) return false;
    const operation = telopRemovalCommand(current, record);
    if (operation === null) return true;
    const ok = await command(operation);
    if (ok) setSelected(ids => ids.filter(id => id !== record.clipId));
    return ok;
  };
  const tutorial = useNativeTutorial({
    scene: 'edit', projectId, documentId: doc?.id ?? null, hasProjects: true,
    ready: !!doc && !session.loading, loadFailed: !session.loading && !!session.error && !doc,
    dirty: session.state?.dirty ?? false, prepare: prepareTutorial, removeTelop: removeTutorialTelop,
  });
  const addText = () => {
    if (!doc) return;
    const documentId = doc.id;
    const track: SequenceTrack = { id: newId(), kind: 'visual', enabled: true, name: 'テキスト' }, id = newId(), duration = Math.round(timeNumber(doc.fps) * 3);
    void command({ type: 'batch', commands: [{ type: 'add-track', track,index:sceneFadeInsertionIndex(doc) }, { type: 'insert', clips: [{ id, trackId: track.id, name: 'テキスト', startFrame: frame, durationFrames: duration,
      clock: { offset: rational(0), rate: rational(1), duration: rational(duration) }, content: { kind: 'telop', data: { text: 'テキスト', animation: 'none', manual: true, position: { x: 0, y: -.5 } }, appearance: { ...DEFAULT_TEXT_APPEARANCE } }, anchor: { kind: 'timeline' } }] }] })
      .then(ok => { if (ok) {selectLiveClips([id]);setRightTab('properties');setRightHidden(false);tutorial.recordTelopAdded({documentId,clipId:id,trackId:track.id});} });
  };
  const addElement=(kind:'title')=>{
    if(!doc)return;
    const documentId=doc.id;
    const id=newId(),name='タイトル',duration=Math.round(timeNumber(doc.fps)*3);
    const track:SequenceTrack={id:newId(),kind:'visual',enabled:true,name};
    const content:SequenceClip['content']={kind,data:{text:'タイトル'},style:{top:Math.round(doc.resolution.height*.03),left:Math.round(doc.resolution.width*.03),fontSize:Math.round(doc.resolution.height*.04)}};
    void command({type:'batch',commands:[{type:'add-track',track,index:sceneFadeInsertionIndex(doc)},{type:'insert',clips:[{id,trackId:track.id,name,startFrame:frame,durationFrames:duration,
      clock:{offset:rational(0),rate:rational(1),duration:rational(duration)},content,anchor:{kind:'timeline'},
      visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],enter:{kind:'none',frames:0},exit:{kind:'none',frames:0}}}]}]}).then(ok=>{if(ok){selectLiveClips([id]);setRightTab('properties');setRightHidden(false);tutorial.recordTelopAdded({documentId,clipId:id,trackId:track.id});}});
  };
  /** 描画で完成した図形を 1 コマンド（トラック追加＋挿入の batch）で入れる。Undo 1 回で消えるのが根拠。 */
  const insertShape=async(data:ShapeData):Promise<boolean>=>{
    const current=nativeSession.readCurrent()?.document;
    if(!current)return false;
    const id=newId(),duration=Math.round(timeNumber(current.fps)*3);
    const track:SequenceTrack={id:newId(),kind:'visual',enabled:true,name:'図形'};
    const ok=await command({type:'batch',commands:[
      {type:'add-track',track,index:sceneFadeInsertionIndex(current)},
      {type:'insert',clips:[{id,trackId:track.id,name:'図形',startFrame:frame,durationFrames:duration,
        clock:{offset:rational(0),rate:rational(1),duration:rational(duration)},content:{kind:'shape',data},anchor:{kind:'timeline'},
        visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],enter:{kind:'none',frames:0},exit:{kind:'none',frames:0}}}]},
    ]});
    if(ok){selectLiveClips([id]);setRightTab('properties');setRightHidden(false);setShapeTools(null);}
    else setToast('図形を追加できませんでした。もう一度お試しください。');
    return ok;
  };
  const importMedia=async(file:File,copy:boolean,onRegistered?:(assetId:string)=>void,role?:'music'|'effect')=>{
    const owner=importOwner.current,progress=(value:TransferProgress)=>{if(owner===importOwner.current)setTransfer({...value,name:file.name});};
    if(copy||file.name.toLowerCase().endsWith('.cube'))return session.upload(file,progress,onRegistered,role);
    const reference=await fileReference.resolve(file,progress);if(owner!==importOwner.current)return false;return session.reference(reference.path,reference.expectedFingerprint,onRegistered,role);
  };
  /**
   * 動画は取り込みの束へ（設計 §1 ②）。デスクトップ版は実パスでリンク（ブラウザで全体のハッシュをしない）、コピーは画面から束へ送る。
   * コピーに実パスは渡さない（サーバが実パスからコピーすると、許可された場所の外のファイルを「コピーして追加」できなくなるため。今の挙動を変えない）。
   * 長さの先読み（デスクトップ版）は束の作成と並行に行い、読めた分から枠に出す。返す delivered は受け付けた本数（リンクは全部、コピーは送れた本数）。
   */
  const importVideos=async(files:File[],copy:boolean,owner:object):Promise<{delivered:number;failure?:unknown}>=>{
    const paths=files.map(desktopFilePath),desktop=paths.every(Boolean),link=desktop&&!copy;
    const {view,stop}=await createWithDurations(desktop?files:null,()=>imports.start({mode:link?'link':'copy',items:files.map((file,index)=>({key:String(index),name:file.name,...(link?{path:paths[index]}:{})}))}),{signal:importReads.current.signal});
    if(link)return {delivered:files.length};
    // ブラウザ版: 受付順に1本ずつ送る。1本の失敗で残りを止めない（失敗した素材は束の中で失敗にし、残りは並べられる）。
    // 取り消し（合図が止まる）と受け付けの終了（IMPORT_CLOSED）では黙って止める。案件を離れたら残りは送らない。
    const signal=imports.uploadSignal(view.batchId),undelivered:string[]=[];let delivered=0,failure:unknown,closed=false;
    try{
      for(const item of view.items){
        if(closed||signal.aborted||owner!==importOwner.current){undelivered.push(item.itemId);continue;}
        const file=files[Number(item.key)]!;
        try{await uploadImportItem(projectId,view.batchId,item.itemId,file,progress=>{if(owner===importOwner.current)setTransfer({...progress,name:file.name});},signal);delivered++;}
        catch(error){
          undelivered.push(item.itemId);
          if(signal.aborted||error instanceof NativeApiError&&error.code===IMPORT_REASON.closed)closed=true;else failure??=error;
        }
      }
    }finally{imports.releaseUploads(view.batchId);}
    // 1本も送れなかった束は取り消す（並べるものが無い）。一部を送れた束は、送らなかった素材だけを束の中で失敗にし、残りを並べられるようにする。
    // 受け付けを終えた束はサーバが変えない。要求が届かなくても、枠の「取り消す」で束を消せる。
    if(undelivered.length&&!delivered)stop();
    if(undelivered.length)void (delivered?retryOnce(()=>abandonImportItems(projectId,view.batchId,undelivered)):cancelImportBatch(projectId,view.batchId)).catch(()=>undefined);
    return failure===undefined?{delivered}:{delivered,failure};
  };
  const importFiles = async (files: FileList | File[] | null,copy=false,dropped=false):Promise<number> => {
    if(files&&trial){setNotice(TRIAL_LOCKED);return 0;}
    if(!files||editLocked||transfer||importPending.current)return 0;
    const {videos,others}=splitVideoFiles(Array.from(files)),owner=importOwner.current;importPending.current=true;
    let added=0;
    try{if(!await flushViewInputs()||owner!==importOwner.current)return 0;setLeftTab('materials');
      // 一部だけ送れた時も、送れた本数を受領の表示に数えてから理由を出す。
      if(videos.length){const result=await importVideos(videos,copy||dropped&&!videos.every(file=>desktopFilePath(file)),owner);added+=result.delivered;if(result.failure!==undefined)throw result.failure;}
      let last='';for(const file of others){if(owner!==importOwner.current)break;if(!await importMedia(file,copy||(dropped&&!desktopFilePath(file)),id=>{last=id;}))break;added++;}
      if(last&&owner===importOwner.current)revealAsset(last);}
    catch(error){if(owner===importOwner.current)setNotice(error instanceof Error?error.message:'素材を取り込めませんでした。');}
    finally{importPending.current=false;if(owner===importOwner.current)setTransfer(null);}
    return added;
  };
  const pickReference=async(file:{path:string;name:string})=>{
    const target=referencePicker,owner=referenceOwner.current;
    if(!target||editLocked||transfer||referencePending.current===owner)return;
    referencePending.current=owner;
    try{
      if(!await flushViewInputs()||referenceOwner.current!==owner)return;
      setReferencePicker(null);setTransfer({phase:'preparing',name:file.name});player.current?.pause();
      let registered='';
      if(target==='add'&&createMediaKind(file.name)==='video'){
        setLeftTab('materials');
        try{await imports.start({mode:'link',items:[{key:'0',name:file.name,path:file.path}]});}catch(error){if(referenceOwner.current===owner)setNotice(error instanceof Error?error.message:'動画を取り込めませんでした。');}
        return;
      }
      const ok=target==='add'?await session.reference(file.path,undefined,id=>{registered=id;}):await session.reconnect(target.id,file.path);
      if(ok&&referenceOwner.current===owner){setLeftTab('materials');if(registered)revealAsset(registered);if(target!=='add'){setSourceOpen(false);setMediaGeneration(value=>value+1);}}
    }finally{if(referencePending.current===owner)referencePending.current=null;if(referenceOwner.current===owner)setTransfer(null);}
  };
  const addMusic=(role:'music'|'effect')=>{audioRole.current=role;musicInput.current?.click();};
  const importMusic=async(file:File)=>{
    if(importPending.current||editLocked||transfer)return;importPending.current=true;
    const role=audioRole.current,at=frame,owner=importOwner.current;
    let assetId='';
    try{if(!await flushViewInputs()||owner!==importOwner.current)return;const ok=await importMedia(file,false,id=>{assetId=id;},role);if(ok&&assetId&&owner===importOwner.current){insertAsset(assetId,at,undefined,role);revealAsset(assetId);setRightTab('properties');setRightHidden(false);}}
    catch(error){if(owner===importOwner.current)setNotice(error instanceof Error?error.message:'素材を取り込めませんでした。');}
    finally{importPending.current=false;if(owner===importOwner.current)setTransfer(null);}
  };
  const chooseFinish=async(next:typeof finishTool)=>{
    if(!await flushViewInputs())return;
    setFinishTool(next);setRightTab('properties');setRightHidden(false);
    const match=(clip:SequenceClip)=>next==='color'?clip.content.kind==='video':next==='audio'?clip.content.kind==='audio':next==='captions'?['telop','title'].includes(clip.content.kind):next==='layout'?clip.content.kind!=='audio':false;
    const current=doc?.clips.find(c=>selected.includes(c.id)&&match(c))??doc?.clips.find(match);
    if(current)selectLiveClips([current.id]);else if(next!=='all'&&next!=='fades')selectLiveClips([]);else selectLiveClips(selected);
    if(next==='audio'){setLeftTab('materials');setTab('bgm');}
  };
  const speech = doc?.clips.filter(c => c.content.kind === 'audio' && c.content.role === 'speech') ?? [];
  const selectedClip = doc?.clips.find(c => selected.includes(c.id));
  const finishHint=mode!=='finish'?null:finishTool==='color'&&selectedClip?.content.kind!=='video'?'カラーを調整する映像を選んでください。':finishTool==='audio'&&selectedClip?.content.kind!=='audio'?'音声を選ぶか、「＋ BGM」から追加してください。':finishTool==='captions'&&!['telop','title'].includes(selectedClip?.content.kind??'')?'字幕を選ぶか、「＋ テロップ」から追加してください。':null;
  const occurrence = doc ? pickSpeechOccurrence(doc, { speechId, selected, selectedClip, frame }) : undefined;
  // 明示した使用箇所（再生位置に追従しない）。台本の照合先と、文字起こし一覧の選択欄の値（空＝再生位置の原音）に使う。
  const chosenOccurrence = doc ? pickSpeechOccurrence(doc, { speechId, selected, selectedClip }) : undefined, following = !!doc && followsPlayhead(doc);
  // 文字起こし一覧で操作を始めたら、その時の原音に固定する（なぞる途中や生成中に再生位置で別素材へ移らない）。
  const pinOccurrence = () => { if (following && !speechId && occurrence) setSpeechId(occurrence.id); };
  const speechContent = occurrence?.content;
  const transcript = speechContent?.kind === 'audio' ? doc?.transcripts.find(t => t.assetId === speechContent.assetId && t.streamIndex === speechContent.streamIndex) : undefined;
  const words = doc && occurrence ? transcript?.words.filter(w => compareTime(w.end, sourceTimeAt(occurrence, occurrence.startFrame, doc.fps)) > 0 && compareTime(w.start, sourceTimeAt(occurrence, clipEnd(occurrence), doc.fps)) < 0) ?? [] : [];
  const selectWords = (from: number, to: number) => {
    if (!doc || !occurrence || occurrence.content.kind !== 'audio') return;
    pinOccurrence();
    const first = words[Math.min(from, to)]!, last = words[Math.max(from, to)]!, start = sourceTimeAt(occurrence, occurrence.startFrame, doc.fps), end = sourceTimeAt(occurrence, clipEnd(occurrence), doc.fps);
    try {
      const selectedRange = speechSelectionRange(doc, { assetId: occurrence.content.assetId, streamIndex: occurrence.content.streamIndex, occurrenceId: occurrence.id,
        start: compareTime(first.start, start) < 0 ? start : first.start, end: compareTime(last.end, end) > 0 ? end : last.end });
      selectLiveRange({...selectedRange,trackId:occurrence.trackId}); seekProgram(selectedRange.startFrame);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };
  const assets = doc?.assets.filter(a => a.kind !== 'component') ?? [], previewAsset = assets.find(a => a.id === assetPreview);
  // M-b: assetUsage は core の参照走査（O(クリップ数)）を含むため、素材一覧の行数ぶん毎レンダー呼ぶと重い。doc が変わった時だけ作り直す。
  const assetUsages = useMemo(() => new Map(assets.map(asset => [asset.id, doc ? assetUsage(doc, asset.id) : { count: 0, places: [] as string[], action: '' }])), [doc]); // eslint-disable-line react-hooks/exhaustive-deps
  // 件数バッジは doc から導出する（assets は doc 由来）。毎レンダーの再生成を避けるため doc だけを deps にする。
  const materialTabs=useMemo(()=>doc?materialTabItems(doc,doc.assets.filter(a=>a.kind!=='component')):[],[doc]);
  const visibleAssets=doc?assets.filter(asset=>materialTabOf(doc,asset)===tab):[];
  const lutAssets=doc?assets.filter(asset=>materialTabOf(doc,asset)==='lut'):[];
  /** 取り込み終わりに、その素材のタブへ切り替えて行を選び、スクロールで見せる。 */
  const revealAsset=(assetId:string)=>{
    const current=nativeSession.readCurrent()?.document,asset=current?.assets.find(item=>item.id===assetId);
    if(!current||!asset)return;
    const target=materialTabOf(current,asset);
    openLeft('materials');
    // LUT は専用タブを持たず、動画タブの <details> の中に並ぶ。切り替えないと BGM タブ表示中に
    // .cube を入れたとき、選ばれてはいるが行が別タブにあって見えない（M-5）。
    setTab(target==='lut'?'video':target);
    setAssetPreview(assetId);
    requestAnimationFrame(()=>window.document.querySelector(`[data-native-asset-id="${assetId}"]`)?.scrollIntoView({block:'nearest'}));
  };
  // 強調は次の操作（どのボタンの押下でも・タブ切替・Esc・案件切替）で消える。画面状態だけで viewState には保存しない。
  useEffect(()=>{
    if(!placeHighlight)return;
    const clear=()=>setPlaceHighlight(null);
    const key=(event:globalThis.KeyboardEvent)=>{if(isEscape(event))clear();};
    const pointer=()=>clear();
    window.addEventListener('pointerdown',pointer,true);window.addEventListener('keydown',key,true);
    return()=>{window.removeEventListener('pointerdown',pointer,true);window.removeEventListener('keydown',key,true);};
  },[placeHighlight]);
  useEffect(()=>{setPlaceHighlight(null);},[projectId]);
  const assetRow=(asset:SequenceAsset)=>{
    const usage = assetUsages.get(asset.id) ?? { count: 0, places: [] as string[] };
    const audible = asset.kind === 'media' && asset.streams.some(s => s.kind === 'audio');
    const rowTab = doc ? materialTabOf(doc, asset) : null;
    const libKind = rowTab === 'se' || rowTab === 'bgm' || rowTab === 'image' ? rowTab : null;
    return <div key={asset.id} data-native-asset-id={asset.id} className={`native-asset-row ${assetPreview === asset.id ? 'is-selected' : ''}`}>
      <div className="native-asset-head">
      <button className="native-asset" draggable={asset.kind !== 'lut'}
        onDragStart={event => event.dataTransfer.setData('application/x-harness-asset', asset.id)} onClick={() => {selectLiveClips([]);setAssetPreview(asset.id);}} onDoubleClick={() => insertAsset(asset.id)}>
        <span className={`native-asset-type native-asset-${asset.kind}`}>{asset.kind === 'lut' ? 'LUT' : asset.kind === 'image' ? 'IMG' : asset.streams.some(s => s.kind === 'video') ? 'MOV' : 'AUDIO'}</span>
        <span className="native-asset-body"><strong>{asset.name}</strong><small className="native-asset-meta">{asset.kind === 'media' ? formatSeconds(timeNumber(asset.streams[0]!.duration)) : asset.kind === 'lut' ? 'カラー設定' : '画像'}</small>{asset.origin?.kind === 'audio-fix' && <small className="native-asset-fixed">補正済み</small>}</span>
      </button>
      {asset.kind !== 'lut' && <button className="native-asset-place" data-native-highlight={placeHighlight===tab?'on':undefined} aria-label={`${asset.name}を再生位置に置く`} disabled={editLocked} onClick={() => insertAsset(asset.id)}>再生位置に置く</button>}
      </div>
      {/* 試聴・案件から外すと同じ行の流れに並べる（「再生位置に置く」はホバー表示の重ね置きのため、頭の行には足さない）。 */}
      {asset.kind==='media'&&asset.streams.some(s=>s.kind==='video')&&<button className="native-asset-append" aria-label={`${asset.name}をメインの末尾に追加`} disabled={editLocked} onClick={()=>void appendMain([asset.id])}>メインの末尾に追加</button>}
      {audible && <button className="native-asset-audition" aria-label={`${asset.name}を試聴`} aria-pressed={audition.playingId === asset.id} disabled={session.busy}
        onClick={() => { player.current?.pause(); audition.toggle(asset.id, sequenceAssetUrl(projectId, asset.id), asset.file.startsWith('public/BGM/') ? 'bgm' : 'se'); }}>{audition.playingId === asset.id ? '停止' : '試聴'}</button>}
      {libKind&&<button className="native-asset-save" aria-label={`${asset.name}を素材置場に保存`} onClick={() => setLibrarySave({asset,kind:libKind})}>素材置場に保存</button>}
      <button className="native-asset-remove" aria-label={`${asset.name}を案件から外す`} disabled={editLocked} onClick={() => void removeAsset(asset.id)}>案件から外す</button>
      {usage.count > 0 && <span className="native-asset-usage">{usage.count}箇所で使用中</span>}
      {asset.file.startsWith('.harness/references/')&&<span className="native-asset-link" data-unavailable={referenceUnavailable(referenceStatuses[asset.id])?'true':undefined}><Icon name="link" size={12}/>{referenceStatuses[asset.id]?.state==='missing'?'未接続':'リンク素材・コピーなし'}
        {referenceStatuses[asset.id]?.state==='checking'&&<span className="native-asset-link-checking" title={referenceStatuses[asset.id]?.message}>確認中</span>}
        {referenceStatuses[asset.id]?.state==='copying'&&!copyJobs.activeAssetIds.has(asset.id)&&<span className="native-asset-link-checking" title={referenceStatuses[asset.id]?.message}>コピー中</span>}</span>}
      {/* 手でコピーする入口（設計 §1）: 判定に関係なく、リンク素材ならいつでも。このエディターがコピー中の素材は押せない。 */}
      {asset.file.startsWith('.harness/references/')&&<button className="native-asset-copy" aria-label={`${asset.name}を速いドライブへコピー`} disabled={copyJobs.activeAssetIds.has(asset.id)||editLocked||!!transfer}
        onClick={()=>setCopyTargets({assetIds:[asset.id]})}>{copyJobs.activeAssetIds.has(asset.id)?'コピー中':'速いドライブへコピー'}</button>}
    </div>;
  };
  // I2: Undo などで asset が doc.assets へ戻ったら、外した素材トレイから消す（ゴミ箱ボタンが文書参照中のファイルへ到達しないように）。
  const trashableRemovedAssets = useMemo(() => removedAssets.filter(asset =>
    !doc?.assets.some(d => d.id === asset.id) && MATERIAL_KINDS.some(([prefix]) => asset.file.startsWith(prefix))), [removedAssets, doc]);
  const rightContents=doc&&<div className="native-right-content" id="native-panel-transcript" hidden={rightTab!=='transcript'&&rightTab!=='script'}>
        {rightTab==='script' && session.state && <><div className="native-transcript"><label>照合する原音<select aria-label="台本と照合する原音" value={chosenOccurrence?.id??''} onChange={event=>{setSpeechId(event.target.value);selectLiveClips(event.target.value?[event.target.value]:[]);}}>
          <option value="">原音を選択してください</option>{speech.map(c=><option key={c.id} value={c.id}>{c.name} · {(c.startFrame/timeNumber(doc.fps)).toFixed(1)}秒から</option>)}</select></label></div>
          <NativeScriptPanel ref={scriptPanel} projectId={projectId} state={session.state} busy={editLocked} occurrenceId={chosenOccurrence?.id??''}
            adoption={{bridge:{sessionId:agent.bridge.sessionId,read:()=>{const current=nativeSession.readCurrent();return current?{projectId,revision:sequenceEditorRevision(current.sessionId,current.document.revision),dirty:current.dirty,saving:session.busy,humanBusy:isAgentEditBlocked()||scriptDraft}:null;}},onOpenActivity:()=>setActivityOpen(true),connectionReady:connection.connection==='connected'&&!connection.needsReview&&connection.readySnapshot?.projectId===projectId&&connection.readySnapshot.revision===sequenceEditorRevision(session.state.sessionId,doc.revision)}}
            read={nativeSession.readCurrent} execute={command} save={nativeSession.save} onSourcePreview={()=>player.current?.pause()} onDraft={setScriptDraft} /></>}
        {rightTab === 'transcript' && <div className="native-transcript"><label>発話の使用箇所<select aria-label="発話の使用箇所" value={chosenOccurrence?.id ?? ''} onChange={event=>{setSpeechId(event.target.value);selectLiveClips(event.target.value?[event.target.value]:[]);}}><option value="">{following ? '再生位置の原音（自動）' : '原音を選択してください'}</option>{speech.map(c => <option key={c.id} value={c.id}>{c.name} · {(c.startFrame / timeNumber(doc.fps)).toFixed(1)}秒から</option>)}</select></label>
          {occurrence&&speechContent?.kind==='audio'&&session.state&&<NativeTranscribeControl key={`${projectId}:${speechContent.assetId}:${speechContent.streamIndex}`} projectId={projectId} occurrenceId={occurrence.id}
            assetId={speechContent.assetId} streamIndex={speechContent.streamIndex} state={session.state} busy={editLocked} read={nativeSession.readCurrent} accept={nativeSession.accept} onEngage={pinOccurrence} />}
          <p className="native-subtle">ことばをなぞって、カットする範囲を選択</p><div className="native-words">{words.map((word, index) => <button key={word.id} onPointerDown={() => { wordStart.current = index; pinOccurrence(); }} onPointerUp={() => { selectWords(wordStart.current ?? index, index); wordStart.current = null; }} onClick={event => { if (event.detail === 0) selectWords(index, index); }}>{word.text}</button>)}</div>
          <div className="native-library-actions"><button disabled={!range||editLocked} onClick={cut}>選択したことばをカット</button>{range&&<button onClick={()=>setRange(null)}>選択を解除</button>}</div>
          {!words.length && <p className="native-subtle">この使用箇所には文字起こしがありません。</p>}
        </div>}
        {rightTab === 'transcript' && session.state && <><div className="native-library-actions"><button disabled={editLocked} onClick={addText}>＋ 字幕・テロップ</button><button disabled={editLocked} onClick={()=>addElement('title')}>＋ タイトル</button></div>
          {!!doc.cutArchive?.entries.length&&<button disabled={editLocked||!doc.clips.some(c=>c.content.kind==='telop'&&c.content.data.manual!==true)} onClick={()=>{
            const template=doc.clips.find(c=>selected.includes(c.id)&&c.content.kind==='telop'&&c.content.data.manual!==true)??doc.clips.find(c=>c.content.kind==='telop'&&c.content.data.manual!==true);
            if(template)void command({type:'fill-cut-captions',templateClipId:template.id}).then(ok=>{if(ok)setToast('カット区間の発話に字幕を補完しました');});
          }}>カット区間の字幕を補完</button>}
          <NativeCaptionPanel ref={captionPanel} projectId={projectId} state={session.state} read={nativeSession.readCurrent} busy={editLocked||switchingProject} switching={switchingProject}
            frame={frame} playing={playing} selected={selected} onDraft={setCaptionDraft} prepare={prepareCaption} execute={inspectorCommand}
            onCollapse={id=>setSelected(current=>current.filter(value=>value!==id))}
            onSelect={(id,at)=>{
              selectLiveClips([id]);
              // 行の先頭ではなく「字幕が出ているところ」へ送る。共通ガードはタイムラインと同じ。
              const clip=nativeSession.readCurrent()?.document.clips.find(item=>item.id===id);
              if(!clip||playing||activeCutId!==null||cutSource.active){seekProgram(at);return;}
              const target=clipSeekTarget(clip,frame,null);
              if(target.frame!==null)seekProgram(target.frame);
              else if(target.reason)setNotice(target.reason);
            }}
            onStyle={id=>{selectLiveClips([id]);void changeRightTab('properties');}}/>
          {cutPanelOpen&&<button disabled={session.busy} onClick={()=>void flushViewInputs().then(ok=>{if(ok)setCutPanelOpen(false);})}>カットの詳細を閉じる</button>}
          <NativeCutPanel ref={cutPanel} compact={!cutPanelOpen} visible={mode!=='review'&&!rightHidden} projectId={projectId} state={session.state} read={nativeSession.readCurrent} busy={nativeSession.busy||agent.busy||switchingProject}
            onImportLegacyHistory={async()=>{if(timeline.current&&!await timeline.current.flush())return false;return nativeSession.importLegacyCutHistory();}}
            frame={frame} activeId={activeCutId} prepare={prepareViewInputs} execute={inspectorCommand} onWorking={setCutWorking}
            onRestored={at=>{setRange(null);setActiveCutId(null);seekProgram(at);}}/>
        </>}
  </div>;
  const timelineOptions = (<div className="native-timeline-options"><button className="btn-ghost" disabled={editLocked} onClick={() => addTrack('visual')}><Icon name="rows" />＋ 映像トラック</button><button className="btn-ghost" disabled={editLocked} onClick={() => addTrack('audio')}><Icon name="rows" />＋ 音声トラック</button><button className="native-toggle" aria-pressed={waveform==='large'} onClick={()=>{const next=waveform==='large'?'standard':'large';setWaveform(next);saveWaveformPref(next);}}>大きい波形</button><label className="native-track-height-control">高さ<input aria-label="トラックの高さ" title="全トラックの高さを調整" type="range" min={MIN_TRACK_HEIGHT} max={MAX_TRACK_HEIGHT} step="1" value={trackHeight} onChange={event=>{const value=Number(event.target.value);setTrackHeight(value);saveTrackHeight(value);}} /></label><label>ズーム<input aria-label="タイムラインのズーム" type="range" min={minZoom} max="12" step=".01" value={zoom} onChange={event => setZoom(Number(event.target.value))} /><span className="native-zoom-value">{zoom.toFixed(2)}×</span></label><button className="btn-ghost" aria-label="タイムラインを全体表示" title="動画全体が画面に収まる倍率へ戻す" disabled={session.busy} onClick={()=>timeline.current?.fitZoom()}>全体</button></div>);
  // AI タブの土台: 今の状況を送る（AI タブを開くと、この画面が主画面になる）。
  const thumbnailTarget = thumbnail.state ? { documentId: thumbnail.state.document.id, sessionId: thumbnail.state.sessionId, revision: thumbnail.state.document.revision } : null;
  const aiScreen = useMemo(() => nativeAiScreen({ projectId, document: doc ?? null, thumbnailOpen, thumbnail: thumbnailTarget, thumbnailPageId,
    editorSessionId: agent.bridge.sessionId, frame, selected }),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnailTarget は中身の 3 つで比べる
  [projectId, doc, thumbnailOpen, thumbnailTarget?.documentId, thumbnailTarget?.sessionId, thumbnailTarget?.revision, thumbnailPageId, agent.bridge.sessionId, frame, selected]);
  const aiFocus = useAiFocus(aiScreen);
  return <main ref={shell} data-panel-layout={mode==='review'?'standard':panelLayouts[mode]} data-density={prefs.density} data-thumbnail={thumbnailOpen?'true':undefined} {...(timelineDragging?{'data-native-drag':'true'}:{})} className={`native-workspace native-mode-${mode} ${leftCollapsed ? 'native-hide-left' : ''} ${rightHidden ? 'native-hide-right' : ''}`}
    onPointerDownCapture={event=>{
      {const target=event.target as HTMLElement;const control=target.closest<HTMLElement>('button,.native-switch');if(control&&!(control as HTMLButtonElement).disabled)uiSound(control.classList.contains('native-toggle')||control.classList.contains('native-track-toggle')||control.classList.contains('native-switch')?'toggle':'press');}
      const active=document.activeElement,target=event.target as HTMLElement;
      if(!target.closest('[data-native-manipulation]'))player.current?.cancelManipulation();
      if(active instanceof HTMLElement&&active.closest('.native-inspector')&&!target.closest('.native-inspector')) {
        // Save/command buttons flush explicitly on click; keep focus until then so
        // the blur commit cannot disable the button before its click is delivered.
        if(target.closest('button,[role=button],[data-native-script-flush]'))event.preventDefault();else active.blur();
      }
    }}
    onKeyDownCapture={event=>{if(event.key!=='Enter'&&event.key!==' ')return;const target=event.target as HTMLElement;if(target.matches('button:not(:disabled)'))uiSound(target.classList.contains('native-toggle')||target.classList.contains('native-track-toggle')?'toggle':'press');else if(target.matches('.native-switch input:not(:disabled)'))uiSound('toggle');}}
    onClickCapture={event=>{
      const active=document.activeElement;
      const target=event.target as HTMLElement;
      if(active instanceof HTMLElement&&active.closest('.native-inspector')&&!target.closest('.native-inspector,[data-native-script-flush]'))active.blur();
    }}
    style={{ '--native-left': `${leftCollapsed ? 0 : leftSize}px`, '--native-right': `${rightHidden ? 0 : effectiveRight}px`, '--native-bottom': `${effectiveBottom}px` } as CSSProperties}>
    <NativeHeader title={doc?.name ?? projectId}
      saveState={thumbnailOpen
        ? (thumbnail.busy ? 'busy' : thumbnail.state?.dirty ? 'dirty' : thumbnail.state ? 'saved' : 'none')
        : session.busy ? 'busy' : (session.state?.dirty || scriptDraft || inspectorDraft) ? 'dirty' : doc ? 'saved' : 'none'}
      mode={thumbnailOpen ? 'thumbnail' : mode} onMode={value => void changeWorkspaceMode(value)} thumbnailUnavailable={doc ? null : '動画の編集データを読み込んでから使えます'}
      canUndo={thumbnailOpen ? !!thumbnail.state?.canUndo : !!session.state?.canUndo} canRedo={thumbnailOpen ? !!thumbnail.state?.canRedo : !!session.state?.canRedo}
      busy={thumbnailOpen ? thumbnail.busy || !thumbnail.state : editLocked}
      onUndo={() => void (thumbnailOpen ? thumbnail.execute({ type: 'undo' }) : command({ type: 'undo' }))}
      onRedo={() => void (thumbnailOpen ? thumbnail.execute({ type: 'redo' }) : command({ type: 'redo' }))}
      onNotifications={()=>{notifications.markRead();setNotificationsOpen(true);}} notificationsOpen={notificationsOpen} unreadNotifications={notifications.unread}
      onHome={() => { if(session.busy||silenceBusy)return;void (async () => { if(navigation){await navigation.navigate(null);return;}if ((!doc||await session.save())&&await saveThumbnailForLeave()) window.location.assign('/'); })(); }}
      onActivity={() => { connection.clearError(); setActivityOpen(true); if (thumbnailOpen) setNotice('サムネの画面でも、AI が扱うのは動画の編集内容だけです（サムネは対象外）。'); }}
      onSettings={()=>setSettingsOpen(open=>!open)} settingsOpen={settingsOpen} onHelp={()=>setHelpOpen(true)}
      autoSave={autoSave} onAutoSave={value => { setAutoSave(value); saveAutoSaveEnabled(value); }}
      onSave={() => void (thumbnailOpen ? saveThumbnail() : session.save())}
      saveDisabled={thumbnailOpen ? !thumbnail.state || thumbnail.busy : !doc || session.busy || preparingSave}
      saveProgress={thumbnailOpen ? thumbnail.saveProgress : nativeSession.saveProgress??(preparingSave?0:null)}
      exportControl={thumbnailOpen ? <ThumbnailExportControl projectId={projectId} session={thumbnail} exporter={thumbnailExport} pageId={thumbnailPageId} /> : doc && <NativeExportControl key={projectId} projectId={projectId} disabled={session.busy} disabledReason={trial?'試し表示中は書き出せません':undefined} revision={doc.revision} resolution={doc.resolution} save={session.save} onBusyChange={setExportBusy} onComplete={openLearning} />} />
    {doc && !thumbnailOpen && <SlidesImportNotice key={projectId} projectId={projectId} frame={frame} busy={session.busy} read={nativeSession.readCurrent} accept={nativeSession.accept} />}
    {connection.transportError && <div className="native-notice native-connection-notice" role="status"><span>{connection.transportError}{doc && autoSave && !agent.autoSavePaused && !connection.needsReview ? ' 接続が戻るまで自動保存を待機しています。' : ''}</span></div>}
    {!!unavailableReferences.length&&<div className="native-notice native-reference-notice" role="alert">
      <div><strong>{unavailableReferences.some(asset=>referenceStatuses[asset.id]?.state==='missing')?'素材が見つかりません':'素材の接続を確認してください'}（{unavailableReferences.length}件）</strong><p>外付けドライブが接続されているか確認してください。場所が変わった場合はリンクし直せます。編集内容は保持されています。</p></div>
      <div className="native-reference-actions">{unavailableReferences.map(asset=><button key={asset.id} className="btn-ghost" disabled={editLocked||!!transfer} title={referenceStatuses[asset.id]?.message} onClick={()=>openReferencePicker(asset)}>{asset.name}をリンクし直す</button>)}</div>
    </div>}
    {session.state?.externalChange && <div className="native-notice" role="alert"><span>外部で編集データが変更されました。{session.state.externalChange.summary}。
      {session.state.dirty || scriptDraft || inspectorDraft || captionDraft ? '未保存の編集があります。現在の内容は保持しています。' : '再読み込みで保存済みの変更を取り込めます。'}</span>
      <button className="btn-ghost" disabled={session.busy} onClick={() => {
        if (!window.confirm('外部の保存内容を読み込みます。現在の未保存入力とUndo履歴は破棄されます。続けますか？')) return;
        void session.reloadExternal().then(ok=>{if(ok){tutorial.beforeNavigate(projectId);if(onReload)onReload();else window.location.reload();}});
      }}>保存内容を再読み込み</button></div>}
    {(session.error || notice || legacyChanged || connection.needsReview) && <div className="native-notice" role="alert"><span>{session.error ?? notice ?? (connection.needsReview?'AI編集の結果を確認するまで自動保存を停止しています。「AIの作業」で現在の内容を確認してください。':'旧形式のファイルに変更があります。現在の編集には取り込まれていません。')}</span><button className="btn-ghost native-header-icon" aria-label="通知を閉じる" onClick={() => { session.clearError(); setNotice(null); setLegacyChanged(false); }}><Icon name="x" /></button></div>}
    {toast && <NativeToast key={toast.id} id={toast.id} message={toast.message} onClose={() => setToast(null)} />}
    {librarySave && <NativeLibrarySaveDialog assetName={librarySave.asset.name} onClose={() => setLibrarySave(null)} onSave={async (name, desc) => {
      const result = await saveToLibrary({ projectId, assetId: librarySave.asset.id, kind: librarySave.kind, name, desc });
      library.reload();
      setToast([result.created ? '素材置場に保存しました' : '同じ素材が素材置場にあります', result.warning].filter(Boolean).join(' '));
    }} />}
    {shortcutsOpen && <NativeShortcutsDialog onClose={() => setShortcutsOpen(false)} onOpenHelp={() => setHelpOpen(true)} />}
    {settingsOpen && <NativeSettings prefs={prefs} onPrefs={setPrefs} themePreference={theme.preference} onTheme={theme.setPreference} onOpenShortcuts={() => setShortcutsOpen(true)} onOpenHelp={() => setHelpOpen(true)} onClose={() => setSettingsOpen(false)}
      panelLayout={mode==='review'?null:panelLayouts[mode as 'edit'|'finish']}
      onPanelLayout={next=>{setPanelLayouts(previous=>({...previous,[mode]:next}));savePanelLayout(mode as 'edit'|'finish',next);}} />}
    {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} onRestartTutorial={() => { setHelpOpen(false); tutorial.start(); }} />}
    {notificationsOpen && <NativeNotifications projectId={projectId} history={notifications.history} storageError={notifications.storageError} onClear={notifications.clear} onClose={()=>{notifications.markRead();setNotificationsOpen(false);}}/>}
    <NativeLearningReview learning={learning} />
    {activityOpen && <AgentActivityDialog externalHistory projectId={projectId} credentials={connection.credentials} connection={connection.connection}
      connectionError={connection.error??connection.transportError} onClose={()=>setActivityOpen(false)} />}
    <TutorialOverlay tutorial={tutorial} options={tutorial.overlayOptions} />
    <input ref={fileInput} type="file" multiple hidden accept="video/*,audio/*,image/*,.cube" onChange={event => { void importFiles(event.target.files,true); event.target.value = ''; }} />
    {fileReference.picker}
    {referencePicker&&<MediaPicker media="all" title={referencePicker==='add'?'素材を参照して追加':'元の素材に接続し直す'} note={referencePicker==='add'?'元の素材はコピーしません。編集中は保存先のドライブを接続してください。':`「${referencePicker.name}」と同じ内容のファイルを選んでください。カットや字幕はそのまま保持します。`} onPick={file=>void pickReference(file)} onCancel={closeReferencePicker}/>}
    {copyTargets&&<NativeCopyDestinationDialog key={JSON.stringify(copyTargets)} projectId={projectId} targets={copyTargets} onCancel={()=>setCopyTargets(null)}
      onStart={async destination=>{
        if('assetIds' in copyTargets)await startMediaCopy(projectId,copyTargets.assetIds,destination);else await decideImportBatch(projectId,copyTargets.batchId,'copy',destination);
        setCopyTargets(null);setLeftTab('materials');
      }}/>}
    <input ref={lutInput} type="file" hidden accept=".cube" onChange={event => { void importFiles(event.target.files); event.target.value = ''; }} />
    <input ref={musicInput} type="file" hidden aria-label="BGM・効果音ファイル" accept="audio/*,.wav,.mp3,.m4a,.aac,.flac,.ogg" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void importMusic(file);}}/>
    {transfer&&<div className="native-transfer"><TaskProgress label={transfer.phase==='uploading'?'素材をコピーしています':transfer.phase==='checking'?'元の素材を確認しています':'素材を解析しています'} compact value={transfer.total?(transfer.loaded??0)/transfer.total:undefined} detail={transfer.name}/>{transfer.phase==='checking'&&<button onClick={fileReference.cancel}>キャンセル</button>}</div>}
    {!doc ? <div className="native-start"><span className="native-start-label">編集ワークスペース</span><h1>{projectId}</h1>{session.loading ? <TaskProgress label="案件を読み込んでいます…"/> : <p>編集内容と素材を、新しい編集画面へ引き継ぎます。</p>}
      {!session.loading && (session.error ? <button onClick={session.retry}>もう一度読み込む</button> : <><button className="btn-primary" disabled={session.busy} onClick={() => void session.migrate()}>{session.busy ? '素材と編集内容を引き継いでいます…' : '編集を始める'}</button><small>元の編集ファイルはそのまま残ります。</small></>)}
    </div> : <div className="native-main">
      {leftCollapsed&&<NativeColumnRail side="left" items={LEFT_RAIL_ITEMS} onExpand={value=>{if(value){importPromptDecided.current=projectId;slowAdvicePrompted.current=projectId;}openLeft(value?value as typeof leftTab:undefined);}}/>}
      <NativeLibraryDrop key={projectId} disabled={session.busy||!!transfer||switchingProject} onFiles={files=>importFiles(files,false,true)}>
        <div className="native-column-head">
          <NativeSegmented<'projects'|'materials'> className="native-library-tabs native-seg-grow" role="tablist" label="左パネル" items={LEFT_TABS} value={leftTab} onChange={chooseLeftTab}/>
          <button type="button" className="btn-ghost native-header-icon native-column-collapse" aria-expanded={true} aria-label="左パネルを畳む" title="左パネルを畳む" onClick={()=>{setLeftHidden(true);setLeftPinned(false);}}><Icon name="chevron-left" strokeWidth={2.75} />畳む</button>
        </div>
        {leftTab==='projects'&&<div id="native-panel-projects"><NativeProjectList projectId={projectId} disabled={session.busy||switchingProject||agent.busy} onPick={id=>void switchProject(id)}/></div>}
        {switchingProject&&<TaskProgress label="保存して切り替えています…" compact/>}
        <div className="native-material-content" id="native-panel-materials" data-tutorial="materials" hidden={leftTab!=='materials'}>
        {/* 案内・コピーの進み具合・取り込みの束は、置き場の切替より上（素材置場の表示でも見える。判断待ちの束を選ぶ場所が隠れない） */}
        {visibleAdvice&&<NativeSlowMediaAdvice advice={visibleAdvice} disabled={editLocked||!!transfer} onCopy={ids=>setCopyTargets({assetIds:ids})} onKeepOnce={keepSlowOnce}
          onKeepAlways={ids=>slowAdvice.keepAlways(ids).catch(error=>setNotice(copyErrorMessage(error,'「今後この場所では出さない」を記録できませんでした。')))}/>}
        <NativeCopyProgress jobs={copyJobs.jobs} onCancel={jobId=>cancelMediaCopy(projectId,jobId).then(()=>undefined,error=>{setNotice(copyErrorMessage(error,'コピーを中止できませんでした。'));throw error;})}
          onDismiss={jobId=>dismissMediaCopy(projectId,jobId).then(()=>undefined,error=>{
            // 見つからない（二度押し・他の画面で閉じた後）は閉じられたものとして扱う
            if(error instanceof NativeApiError&&error.status===404)return;setNotice(copyErrorMessage(error,'コピーの作業を閉じられませんでした。'));throw error;})}/>
        <NativeImportBatches batches={imports.pending} unplaced={importUnplaced} disabled={editLocked||switchingProject} onConfirm={(batchId,skipFailed)=>{const owner=importOwner.current;void imports.confirm(batchId,skipFailed).then(ok=>{if(ok&&owner===importOwner.current)setRange(null);});}} onCancel={cancelImport}
          onDecide={(batchId,choice)=>{noteAskedBatch(projectId,batchId);return decideImportBatch(projectId,batchId,choice).catch(error=>{setNotice(copyErrorMessage(error,'選んだ扱いを伝えられませんでした。'));throw error;});}}
          onCopyBatch={batchId=>setCopyTargets({batchId})} unfinishedCopies={unfinishedCopies}/>
        <NativeSegmented<'project'|'library'> className="native-material-source native-seg-grow" role="radiogroup" label="素材の置き場" items={MATERIAL_SOURCES} value={materialSource} onChange={setMaterialSource}/>
        {materialSource==='library'?<NativeLibraryPanel listing={library.listing} loading={library.loading} playingKey={audition.playingId}
          onAudition={auditionLibrary} onPlace={key=>void placeLibrary(key)} disabled={editLocked} busyKeys={placingList} onReload={library.reload}/>:<>
        <NativeSegmented className="native-material-tabs native-seg-grow" role="tablist" label="素材の種類" items={materialTabs} value={tab} onChange={value=>void changeTab(value)}/>
        {(tab==='video'||tab==='image')&&<div className="native-library-actions">
          <button className="btn-tonal" disabled={editLocked} onClick={() => openReferencePicker('add')}><Icon name="plus" />素材を追加</button>
          <button className="btn-ghost" disabled={editLocked} onClick={()=>fileInput.current?.click()}>コピーして追加</button>
          </div>}
        {(tab==='bgm'||tab==='se')&&<div className="native-library-actions">
          <button className="btn-tonal" disabled={editLocked} onClick={()=>addMusic(tab==='se'?'effect':'music')}>{tab==='se'?'＋ 効果音を追加':'＋ BGM を追加'}</button>
        </div>}
        {sourceOpen && previewAsset && previewAsset.kind === 'media' && <div className="native-source-preview"><video controls src={sequenceAssetUrl(projectId, previewAsset.id)} onPlay={() => player.current?.pause()} /><button onClick={() => setSourceOpen(false)}>素材プレビューを閉じる</button></div>}
        {placeHighlight===tab&&<p className="native-library-hint" role="status">一覧の「再生位置に置く」で、再生位置に置けます。</p>}
        <div className="native-asset-list">
          {!visibleAssets.length&&!(tab==='video'&&lutAssets.length)&&<p className="native-library-hint">{MATERIAL_TAB_EMPTY[tab]}</p>}
          {visibleAssets.map(assetRow)}
          {tab==='video'&&lutAssets.length>0&&<details open className="native-asset-luts"><summary>カラー設定（LUT）</summary>{lutAssets.map(assetRow)}</details>}
        </div>
        {(tab==='bgm'||tab==='se')&&<><p className="native-library-hint">音声を選んで、音量・ミュート・フェードを調整します。</p>
          <div className="native-caption-list">{doc.clips.filter(c=>c.content.kind==='audio'&&(tab==='se'?c.content.role==='effect':c.content.role!=='effect')).map(c=><button key={c.id} aria-pressed={selected.includes(c.id)} onClick={()=>{void flushViewInputs().then(ok=>{if(ok){selectLiveClips([c.id]);setRightTab('properties');setRightHidden(false);}});}}><small>{c.content.kind==='audio'&&c.content.role==='speech'?'原音':c.content.kind==='audio'&&c.content.role==='music'?'BGM':'効果音'}</small>{c.name}</button>)}</div></>}
        {/* 外した素材は doc.assets から消えるため一覧の行は残らない。ここは file がまだ public/ 配下にある
            ものだけを拾う別枠（.harness 配下の管理素材・参照素材は /api/material の対象外のため出さない）。
            I2: Undo で doc.assets へ戻った asset は trashableRemovedAssets の時点で除かれている
            （このボタンから doc が参照中のファイルをゴミ箱へ送ってしまう事故を防ぐ）。 */}
        {trashableRemovedAssets.length > 0 && <div className="native-asset-removed">
          {/* T28 Minor: 「まだ残っています」と「案件フォルダに残ります」が同じことを二度言っていた。 */}
          <p className="native-library-hint">案件から外した素材（ファイルは案件フォルダに残っています）</p>
          {trashableRemovedAssets.map(asset =>
            <div key={asset.id} className="native-asset-row">
              <span className="native-asset-body"><strong>{asset.name}</strong></span>
              <button className="native-asset-trash" aria-label={`${asset.name}のファイルをゴミ箱へ移す`} disabled={session.busy}
                onClick={() => void trashAsset(asset).then(ok => { if (ok) setRemovedAssets(value => value.filter(a => a.id !== asset.id)); })}>ゴミ箱へ移す</button>
            </div>)}
        </div>}
        <div className="native-library-actions"><button disabled={previewAsset?.kind !== 'media'} onClick={() => setSourceOpen(true)}>素材を確認</button>{previewAsset?.file.startsWith('.harness/references/')&&<button disabled={editLocked} onClick={()=>openReferencePicker(previewAsset)}>リンクし直す</button>}</div>
        <p className="native-library-hint">ドラッグして配置 · ダブルクリックで再生位置に追加</p>
        </>}
        </div>
      </NativeLibraryDrop>
      <div className="native-resizer native-resizer-left" {...resizeProps('left')} />
      <NativePreview sessionId={session.state?.sessionId} addBar={mode==='review'?undefined:(<NativeAddBar vertical disabled={editLocked} onAddText={addText} onAddTitle={()=>addElement('title')} onPickShape={kind=>setShapeTools({kind})}
          onGoMaterials={target=>{openLeft('materials');void changeTab(target).then(()=>setPlaceHighlight(target));}}/>)}
        notice={session.state&&<NativeProxyBanner projectId={projectId} sessionId={session.state.sessionId} revision={session.state.document.revision}
          onReady={()=>{player.current?.pause();setMediaGeneration(value=>value+1);setToast('軽量版でプレビューを読み込みました');}}/>}
        onFitPanels={fitPreviewPanels} key={`${projectId}:${mediaGeneration}:${silencePreview?.document.id??cutSource.active?.serial??'program'}`} projectId={projectId} document={trial?.result.preview??silencePreview?.document??inclusiveActive?.document??cutSource.active?.preview??doc} ref={player} onError={failure=>{if(!firstPicture)setFirstPicture(true);if(trial)setTrialFailed(trial.result.preview);notifications.add({severity:'error',source:'プレビュー',message:failure.message,revision:doc.revision,frame:player.current?.frame()??frame});}} onPlay={()=>{scriptPanel.current?.pauseSource();audition.stop();}} onPlaybackChanged={setPlaying} onFrame={previewFrame} onRendered={()=>{if(!firstPicture)setFirstPicture(true);if(silencePreview&&!silenceStarted.current){silenceStarted.current=true;void player.current?.play().catch(e=>setNotice(String(e)));}}} bypassLut={cutSource.active?false:bypassLut} initialFrame={trial?frame:silencePreview?.start??inclusiveActive?.initialFrame??cutSource.active?.initialFrame??frame} monitor={trial?'プログラム':silencePreview?'変更案':inclusiveActive?'カット込み確認':cutSource.active?'ソース':'プログラム'} onShuttle={key=>player.current?.shuttle(key,false,prefs.shuttleMax)}
        safeArea={prefs.safeArea&&mode!=='review'}
        visualPreview={silencePreview||inclusiveActive||trial?null:visualPreview}
        shapeDraw={mode==='review'||!!silencePreview||cutSource.active||!!inclusiveActive||!!trial||!shapeTools?undefined:{kind:shapeTools.kind,disabled:editLocked||manipulationBusy,color:NEW_SHAPE_COLOR,
          onPick:kind=>setShapeTools({kind}),onComplete:insertShape}}
        monitorControls={trial?<div className="native-cut-source-controls native-trial-controls">
          <span>{`試し表示中：${trial.result.preview.assets.find(asset=>asset.id===trial.assetId)?.name??trial.assetId}。保存されていません`}</span>
          <button disabled={trial.adopting||trialFailed===trial.result.preview} onClick={adoptTrial}>採用</button>
          <button disabled={trial.adopting} onClick={revertTrial}>戻す</button>
        </div>:mode==='finish'&&(inclusiveActive||cutSource.owners.length>0)?<div className="native-cut-source-controls">
          {inclusiveActive&&<span>確認用です。書き出しには含めません。</span>}
          {!!inclusiveActive?.map.unresolved.length&&<button onClick={()=>void openCut(inclusiveActive.map.unresolved[0]!.entryIds[0]!)}
            title="位置や順序が不明なカットは再生に含めていません。詳細から素材を確認し、復元位置を指定できます。">
            位置の確認が必要な{inclusiveActive.map.unresolved.length}区間は再生対象外 · 詳細</button>}
          {!inclusiveActive&&cutSource.owners.length>0&&<><label>確認する素材<select aria-label="カット前を確認する使用箇所" value={cutSource.clipId} disabled={cutSource.pending||session.busy} onChange={event=>cutSource.choose(event.target.value)}><option value="" disabled>使用箇所を選択</option>{cutSource.owners.map((clip,index)=><option key={clip.id} value={clip.id}>{index+1}. {clip.name} · {clip.content.kind==='video'?'映像':'音声'}</option>)}</select></label>
          <button disabled={cutSource.pending||session.busy||!cutSource.clipId} aria-pressed={!!cutSource.active} onClick={()=>{if(cutSource.active)cutSource.stop();else void cutSource.open();}}>{cutSource.active?'完成動画に戻る':'カット前を確認'}</button></>}
        </div>:undefined}
        manipulation={mode==='review'||!!silencePreview||cutSource.active||!!inclusiveActive||!!trial?undefined:{selected,disabled:session.busy||!!visualPreview,externalBusy:agent.busy,snapEnabled:snap,readDocument:()=>nativeSession.readCurrent()?.document??null,onBusy:setManipulationBusy,
          prepare:async()=>{if(inspector.current&&!await inspector.current.flush())return false;return !scriptPanel.current||await scriptPanel.current.flush();},
          commit:async change=>{
            const current=nativeSession.readCurrent()?.document;
            // レビュー M9: 開始時の選択列そのままとの完全一致にはしていない。直接操作できない要素が
            // 選択に混じるドラッグ（begin の除外＝manipulableSelection）では changes が selected の
            // 真部分集合になるのが正しい挙動で、完全一致にすると「除外して残りで操作を続ける」経路が
            // ここで拒否されてしまう。NativePreviewManipulation 側の valid() が
            // gesture 開始時の選択列そのままとの一致を既に見ているため、ここでは
            // 「今 commit しようとしている変更が、現在の選択に含まれるか」だけを二重に確認する。
            if(agent.busy||!current||current.id!==change.documentId||current.revision!==change.revision
              ||!change.changes.length||!change.changes.every(item=>selected.includes(item.clipId))||player.current?.frame()!==change.frame)
              throw new Error('表示や編集内容が変わったため、配置を保存できませんでした。');
            // 複数件でも 1 コマンド。件数ぶんの Undo にしない（競合検査 after.revision>revision+1 もそのまま効く）。
            const ok=await nativeSession.execute(change.changes.length===1
              ?{type:'update-clip',clipId:change.changes[0]!.clipId,patch:{visual:change.changes[0]!.visual}}
              :{type:'batch',commands:change.changes.map(item=>({type:'update-clip',clipId:item.clipId,patch:{visual:item.visual}}))});
            const after=nativeSession.readCurrent()?.document;
            if(ok&&(!after||after.id!==change.documentId||after.revision>change.revision+1))throw new Error('保存中に別の編集が入りました。最新の配置を確認してください。');
            return ok;
          },
          commitShape:async change=>{
            const current=nativeSession.readCurrent()?.document;
            if(agent.busy||!current||current.id!==change.documentId||current.revision!==change.revision||selected.length!==1||selected[0]!==change.clipId)
              throw new Error('表示や編集内容が変わったため、図形を保存できませんでした。');
            const clip=current.clips.find(item=>item.id===change.clipId);
            if(clip?.content.kind!=='shape')throw new Error('図形を選び直してください。');
            const ok=await nativeSession.execute({type:'update-clip',clipId:change.clipId,patch:{content:{...clip.content,data:change.data}}});
            const after=nativeSession.readCurrent()?.document;
            if(ok&&(!after||after.id!==change.documentId||after.revision>change.revision+1))throw new Error('保存中に別の編集が入りました。最新の形を確認してください。');
            return ok;
          }}}/>
      <div className="native-resizer native-resizer-right" {...resizeProps('right')} />
      {rightHidden&&<NativeColumnRail side="right" items={RIGHT_RAIL_ITEMS} onExpand={value=>{setRightHidden(false);if(value)void changeRightTab(value as typeof rightTab);}}/>}
      <section className="native-right-dock" data-finish-tool={mode==='finish'?finishTool:'all'}>
      {!rightHidden&&<div className="native-dock-head">
        <NativeAiBand open={rightTab==='ai'} disabled={session.busy} onOpen={()=>void changeRightTab('ai')} onBack={()=>void changeRightTab(lastDockTab.current)}/>
        <button type="button" className="btn-ghost native-header-icon native-column-collapse" aria-expanded={true} aria-label="右パネルを畳む" data-tip="右パネルを畳む" data-tip-side="left" disabled={silenceBusy} onClick={()=>{if(silenceOpen)closeSilence();setRightHidden(true);}}><Icon name="chevron-right" strokeWidth={2.75} /></button>
      </div>}
      <div className="native-column-head">
        <NativeSegmented className="native-dock-tabs native-seg-grow" role="tablist" label="右パネル" items={DOCK_TABS} value={rightTab==='ai'?null:rightTab} onChange={value=>void changeRightTab(value)}/>
      </div>
      {rightContents}
      {mode==='finish'&&rightTab==='properties'&&<nav className="native-finish-tools" aria-label="仕上げの調整">{([['all','すべて'],['captions','字幕・テロップ'],['color','カラー'],['audio','音声'],['layout','動き・配置'],['fades','シーン転換']] as const).map(([value,label])=><button key={value} className="native-toggle" aria-pressed={finishTool===value} onClick={()=>void chooseFinish(value)}>{label}</button>)}</nav>}
      <div className="native-inspector-host" id="native-panel-properties" hidden={rightTab!=='properties'}>
      {finishHint&&<p className="native-finish-empty" role="status">{finishHint}</p>}
      <NativeInspector leadingTools={mode==='edit'&&<section className="native-inspector-section" data-group="silence">
        <h3><button type="button" ref={silenceButton} aria-label="無音カット" aria-expanded={silenceOpen} aria-controls="native-silence-settings" disabled={editLocked||!!cutSource.active||!!inclusiveActive} onClick={()=>{if(silenceOpen){closeSilence();return;}void flushViewInputs().then(ok=>{if(ok){player.current?.pause();setSilenceOpen(true);}});}}>
          <span className="native-inspector-section-label">無音カット</span>{!silenceOpen&&<span className="native-inspector-section-summary">トークの間を短縮</span>}<Icon name="chevron-down" size={14}/>
        </button></h3>
        <div id="native-silence-settings" hidden={!silenceOpen}>
          {silenceOpen&&session.state&&<NativeSilenceCutPanel key={projectId} projectId={projectId} state={session.state} read={nativeSession.readCurrent} accept={nativeSession.accept}
            prepare={flushViewInputs} blocked={nativeSession.busy||agent.busy||cutWorking||boundaryWorking||switchingProject||!!session.state.externalChange||!!trial}
            selection={range} onBusy={setSilenceBusy} onCandidates={setSilenceCandidates} onPreview={showSilencePreview} onClose={closeSilence}
            onFinish={()=>{closeSilence();void changeMode('finish');}} onUndo={async()=>{showSilencePreview(null);await nativeSession.execute({type:'undo'});}}/>}
        </div>
      </section>} ref={inspector} groupOpen={inspectorOpen} onGroupOpen={(key,open)=>setInspectorOpen(current=>current[key]===open?current:{...current,[key]:open})} projectId={projectId} readDocument={()=>session.readCurrent()?.document??null} frame={frame} onSeek={seekProgram} onPrepareTextStyles={session.prepareTextStyles} onDraftChange={setInspectorDraft} document={doc} selected={selected} disabled={editLocked} externalBusy={agent.busy} bypassLut={bypassLut} onBypass={setBypass} onCommand={propertyCommand} onUploadLut={() => lutInput.current?.click()} showSceneFades={mode==='finish'} sceneFadeSwitching={sceneFadeSwitching} sceneFadeTarget={sceneFadeTarget} onSceneFadeTargetChange={selectSceneFade} transitionJoinKey={transitionJoinKey} onTransitionJoin={async key=>{if(!await flushViewInputs())return false;setTransitionJoinKey(key);return true;}} onPreviewVisual={previewInspectorVisual} exporting={exportBusy} onNotice={setNotice}
        trialSwap={{trial,error:trialSwap.error,disabled:trial?trial.adopting:workBusy||switchingProject,onStart:assetId=>{
          // 選択が試しの対象として成り立たなければ何もしない（節の表示・試しの継続と同じ述語）。同じ使用箇所で試し中なら切替として扱う。
          const id=selected[0];if(!id||!trialSelectable(doc,selected))return;if(trial?.result.clipIds.includes(id))chooseTrial(assetId);else void startTrial(id,assetId);},onChoose:chooseTrial,onEndMode:trialEndMode}} onRegisterAssets={async assetIds=>{
        const current=nativeSession.readCurrent();if(!current)return false;
        try{nativeSession.accept(await nativeRequest<NativeSession>(projectId,'/register',{sessionId:current.sessionId,expectedRevision:current.document.revision,executionId:crypto.randomUUID(),assetIds}));return true;}
        catch(error){setNotice(error instanceof Error?error.message:'補正した音声を取り込めませんでした。');return false;}
      }}/>
      </div>
      {rightTab==='ai'&&!thumbnailOpen&&<div className="native-ai-panel" id="native-panel-ai"><AiTerminal focus={aiFocus}/></div>}
      </section>
      <div className="native-resizer native-resizer-bottom" {...resizeProps('bottom')} onDoubleClick={()=>setBottomAuto(true)} title="ドラッグで高さを調整。ダブルクリックで自動に戻す" />
      <section className="native-timeline-panel" data-tutorial="timeline">

        <div className="native-timeline-toolbar" ref={toolbar}><strong>シーケンス</strong>{mode==='finish'&&<button data-native-script-flush disabled={session.busy} onClick={()=>void flushViewInputs().then(ok=>{if(ok){player.current?.pause();setCutPanelOpen(true);setRightTab('transcript');setRightHidden(false);}})}>カットの詳細</button>}{mode==='finish'&&cutRestoreSelected&&!range&&!selected.length&&<button disabled={editLocked} onClick={()=>void timeline.current?.restoreCut()}>選択範囲を戻す</button>}
        <NativeSegmented className="native-tools" label="工具" items={TOOL_ITEMS} value={tool} onChange={value => setTool(value as NativeTool)} />
        {mode==='finish'&&<NativeSwitch className="native-cut-playback-toggle" label="カット区間も再生" checked={!!inclusiveActive}
          disabled={editLocked||!doc.cutArchive?.entries.length} onChange={()=>void toggleInclusive()}/> }
        <button className="native-toggle native-toggle-icon" aria-pressed={snap} aria-keyshortcuts="S" aria-label="スナップ" data-tip="スナップ S" onClick={() => setSnap(!snap)}><Icon name="magnet" /></button>
        <button className="native-toggle native-toggle-icon" aria-pressed={rippleOn} aria-keyshortcuts="R" aria-label="詰める" data-tip="詰める R"
          aria-description="端を短くした範囲を全トラックから取り除き（元映像から戻すで復元可）、延長で右隣を押し出す"
          disabled={!rippleUsable} onClick={() => setRipple(!rippleOn)}><Icon name="ripple" /></button>
        {toolbarNarrow ? <NativeViewMenu>{timelineOptions}</NativeViewMenu> : timelineOptions}
      </div>
        <NativeTimeline key={`${projectId}:${mediaGeneration}`} ref={timeline} projectId={projectId} sessionId={session.state?.sessionId} trackHeight={trackHeight} waveform={waveform} archivedPlayhead={inclusiveActive?inclusiveMarker:cutSource.marker} silenceCandidates={silenceCandidates} cutSourceActive={!!silencePreview||!!cutSource.active||!!inclusiveActive} playing={playing} busy={session.busy||switchingProject||manipulationBusy} trialClipIds={trial?.result.clipIds} editLocked={!!trial} onEditLocked={()=>setNotice(TRIAL_LOCKED)} mode={mode} activeCutId={activeCutId} onSelectCut={id=>{player.current?.pause();setActiveCutId(id);setSelected([]);setRange(null);}} onOpenCut={id=>void openCut(id)} onZoomChange={setZoom} onDragStateChange={setTimelineDragging} onMinZoom={setMinZoom} document={doc} frame={frame} selected={selected} range={range} tool={tool} zoom={zoom} snap={snap} ripple={rippleOn&&rippleUsable} onSelect={ids=>{player.current?.pause();void flushViewInputs().then(ok=>{if(ok)selectLiveClips(ids);});}} onRange={selectLiveRange}
          prepareCut={prepareViewInputs} readDocument={()=>nativeSession.readCurrent()?.document??null} onCutWorking={setBoundaryWorking} onRestoreSelection={setCutRestoreSelected}
          onCutCommand={async(operation,expected)=>{
            // The row owns this pending operation; do not recursively flush it.
            if(trial){setNotice(TRIAL_LOCKED);return false;}
            if(!await prepareViewInputs())return false;
            const current=nativeSession.readCurrent()?.document;
            if(agent.busy||switchingProject||!current||current.id!==expected.documentId||current.revision!==expected.revision)return false;
            const reviewing=!!inclusiveActive,reviewFrame=inclusiveFrame;
            const ok=await inspectorCommand(operation);
            if(ok&&reviewing){
              const next=nativeSession.readCurrent();
              if(next)try{
                const preview=cutInclusivePreview(next.document),at=Math.max(0,Math.min(reviewFrame,preview.map.displayEnd-1));
                setInclusiveFrame(at);setInclusive({...preview,source:next.document,sessionId:next.sessionId,initialFrame:at});
              }catch(error){setNotice(error instanceof Error?error.message:String(error));}
            }
            return ok;
          }}
          onDisplaySeek={inclusiveActive?at=>{void player.current?.seek(at);}:undefined}
          onSeek={seekProgram} onCommand={command} onDrop={insertAsset} importFrames={importFramesNow} beforeFirstPicture={!firstPicture&&doc.sequenceEndFrame>0} onCancelImport={cancelImport} onLibraryDrop={(key,at,trackId)=>{void placeLibrary(key,at,trackId);}} onSceneFade={target=>{void selectSceneFade(target);}}/>
        <div className="native-timeline-footer"><span className="native-hints">{range && <span className="native-hint native-hint-range">{range.startFrame}–{range.endFrame} fr</span>}{footerHints(tool, !!range).map(s => <span key={s.label} className="native-hint">{s.keys.map((k, i) => <kbd key={i} className="native-key">{k}</kbd>)}{s.label}</span>)}<button type="button" className="btn-ghost native-hint-all" aria-keyshortcuts="?" onClick={() => setShortcutsOpen(true)}><kbd className="native-key" aria-hidden="true">?</kbd>すべてのキー</button></span><span>{doc.clips.length} クリップ · {doc.tracks.length} トラック</span></div>
      </section>
    </div>}
    {doc&&thumbnailOpen&&<div className="native-thumbnail-host">
      <NativeThumbnailWorkspace ref={thumbnailWorkspace} projectId={projectId} session={thumbnail} videoDocument={doc}
        pageId={thumbnailPageId} onPage={setThumbnailPageId} onToast={setToast} exporter={thumbnailExport} onOpenAi={()=>setRightTab('ai')}/>
      {/* AI タブの土台: サムネを見ながら AI に頼めるように、右端に AI の列を置く（開閉は動画側と同じ rightTab）。 */}
      <aside className="native-thumbnail-ai" aria-label="AI" data-open={rightTab==='ai'?'true':'false'}>
        {rightTab==='ai'
          ? <><div className="native-thumbnail-ai-head"><strong>AI に頼む</strong>
              <button type="button" className="btn-ghost native-header-icon" aria-label="AI を閉じる" data-tip="AI を閉じる" data-tip-side="left" onClick={()=>setRightTab(lastDockTab.current)}><Icon name="x"/></button></div>
            <div className="native-ai-panel" id="native-panel-ai-thumbnail"><AiTerminal focus={aiFocus}/></div></>
          : <button type="button" className="btn-ghost native-header-icon" aria-label="✦ AI で編集する" aria-expanded={false} data-tip="AI に頼む" data-tip-side="left" onClick={()=>setRightTab('ai')}><Icon name="sparkles"/></button>}
      </aside>
    </div>}
  </main>;
}
