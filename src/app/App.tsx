import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { EditorPlaybackRef as PlayerRef } from './preview/editorPlayback';
import { useEditorProject } from './useEditorProject';
import { BackupNotice } from './panels/BackupNotice';
import { revealProjectRequest } from './projectRevealApi';
import { useProjectsWatch } from './useProjectsWatch';
import { useEventBusProjectId } from './eventBus';
import { useEditSession } from './useEditSession';
import { usePreferenceEditBridge } from './usePreferenceEditBridge';
import { PreferenceDialog } from './preferences/PreferenceDialog';
import { useEditorCommandBridge } from './useEditorCommandBridge';
import { useEditorAgentConnection } from './useEditorAgentConnection';
import { requestedAgentActivityProject, useInitialAgentActivity } from './useInitialAgentActivity';
import { AgentActivityDialog } from './panels/AgentActivityDialog';
import type { EditorReviewTarget } from '../shared/editorReview';
import { useUnsavedGuard } from './useUnsavedGuard';
import { useAutoSave } from './useAutoSave';
import { useBannerSlotHeight } from './useBannerSlotHeight';
import { loadAutoSaveEnabled, saveAutoSaveEnabled, hasExplicitAutoSavePref } from './layout/autoSavePref';
import { AUTO_SAVE_DELAY_MS, parseAutoSaveDelayOverride } from './edit/autoSave';
import { useRenderJob, type UseRenderJobReturn } from './useRenderJob';

import { useTheme } from './layout/useTheme';
import { toEditorProject } from './edit/editState';
import { buildPlaybackModel } from '../preview/playbackModel';
import { orientationCode } from '../shared/orientation';
import { LARGE_UPLOAD_NOTICE_BYTES } from '../shared/uploadNotice';
import { isTranscriptAlignedWithVideo } from '../core/transcript';
import { ConversionBanner } from './panels/ConversionBanner';
import { ExportNotices } from './panels/ExportNotices';
import { ExternalChangeBanner } from './panels/ExternalChangeBanner';
import { BgmInstallBanner, shouldShowBgmInstallWarning } from './panels/BgmInstallBanner';
import { VideoInsertInstallBanner, shouldShowVideoInsertInstallWarning } from './panels/VideoInsertInstallBanner';
import { usePackStatus } from './usePackStatus';
import { Toolbar } from './panels/Toolbar';
import { ExportDialog } from './panels/ExportDialog';
import { isCutsOnly } from '../shared/cutsOnly';
import { HeavyJobConfirmDialog } from './panels/HeavyJobConfirmDialog';
import { TrashConfirmDialog } from './panels/TrashConfirmDialog';
import { TrashDialog } from './panels/TrashDialog';
import { deleteMaterialRequest } from './trashApi';
import { collectUsedAssetKeys } from './edit/materialUsage';
import { makeAssetKey } from '../shared/assetKey';
import type { RenderOptions } from '../shared/renderPreset';
import { LeftColumn, type LeftTab } from './panels/LeftColumn';
import type { DrawingKind } from './preview/PreviewOverlay';
import { applyInsertMaterial } from './edit/insertMaterial';
import { classifyUploadKind, uploadMaterial } from './uploadMaterial';
import { createNativeImageProject, createNativeProject } from './native/api';
import { relinkRequest } from './browseApi';
import type { CreateSource } from './panels/HomeDashboard';
import { MediaPicker } from './panels/MediaPicker';
import { VideoLinkBanner } from './panels/VideoLinkBanner';
import { useAudition } from './audio/useAudition';
import type { MaterialKind } from './panels/materialList';
import { originalToPlayback, playbackToOriginal } from '../core/cutEngine';
import { cutOrderingOf } from '../core/cutOrder';
import { playbackToPlayer, playerToPlayback } from '../preview/speedBridge';
import { nextReloadKey, withReloadBust } from '../shared/previewReload';
import type { TimelineDropApi } from './panels/Timeline';
import { Preview } from './panels/Preview';
import { HomeDashboardWithAgentBoard } from './panels/HomeDashboard';
import { AppStateBeacon } from './AppStateBeacon';
import { putJsonPost } from './fetchJson';
import { useCaptureEngineStatus } from './useCaptureEngineStatus';
import { hasCaptureOverlays } from '../shared/captureOverlays';
import type { ProjectStage } from '../shared/projectStage';
import { TranscriptPanel } from './panels/TranscriptPanel';
import { ScriptPanel } from './panels/ScriptPanel';
import { Inspector, SettingsTab } from './panels/Inspector';
import { EditingInspector } from './panels/EditingInspector';
import { sequenceSourceFrameAt } from './timeline/CutSequenceTrack';
import { RightDock } from './panels/RightDock';
import { SubtitlePanel } from './panels/SubtitlePanel';
import { tabForSelection, type DockTab } from './dockTab';
import {
  loadLayout,
  loadWorkspaceMode,
  saveLayout,
  saveWorkspaceMode,
  showsSubtitlePanel,
  workspaceModeDefaults,
  workspaceModeLayout,
  type LayoutPreset,
  type TimelineView,
  type WorkspaceMode,
} from './layout/layoutPreset';
import { loadFolderOpen, saveFolderOpen } from './layout/folderOpenPref';
import { loadWaveformPref, saveWaveformPref, type WaveformPref } from './layout/waveformPref';
import { Timeline } from './panels/Timeline';
import { nearestKeptOriginalFrame } from './timeline/cutViewFocus';
import { ClaudePanel } from './panels/ClaudePanel';
import type { InstructionContext } from '../shared/types';
import { setDucking } from './edit/duckingOps';
import { DEFAULT_DUCKING, saveDuckingSettings } from './edit/duckingSettings';
import { INSTALL_APIS, type InstallKind, type InstallErrors } from './install';
import { useTutorial } from './tutorial/useTutorial';
import { TutorialOverlay } from './tutorial/TutorialOverlay';
import { HelpModal } from './help/HelpModal';
import { isModalOpen } from './isModalOpen';
import { useSnapPref } from './useSnapPref';

/**
 * dirty/save 結果から render を開始してよいかを判定する（純関数・テスト容易性のため分離）。
 * dirty でなければ保存不要のため常に true。dirty なら save() の戻り値（成否）に従う。
 */
export function shouldProceedToRender(dirty: boolean, saveOk: boolean): boolean {
  return !dirty || saveOk;
}

/**
 * 別プロジェクトへ切り替える前段: 未保存の編集があれば先に保存し、保存できた時だけ切り替える。
 *
 * 左カラムのプロジェクト一覧は**編集中も常に見えている**ため、そこから別プロジェクトを
 * 選ぶと `useEditorProject.selectProject` が新しい EditorProject を読み込み、
 * `useEditSession` はそれをキーにセッションを作り直す（履歴も savedContent も破棄）。
 * 保存を挟まないと、この経路だけ未保存編集が**警告も出ず**に消える
 * （ホームへ戻る handleGoHome・書き出し handleRenderStart は保存を挟んでいる）。
 * 同じ規律をここへも広げ、保存に失敗したら切り替えない（既存の保存エラー表示に任せる）。
 */
export async function switchProjectWithSave(
  id: string,
  session: { dirty: boolean; save: () => Promise<boolean> } | null,
  selectProject: (id: string) => void,
): Promise<boolean> {
  const dirty = session?.dirty ?? false;
  const saveOk = session && dirty ? await session.save() : true;
  if (!shouldProceedToRender(dirty, saveOk)) return false;
  selectProject(id);
  return true;
}

/**
 * 「未保存の編集があるなら先に保存し、保存できたときだけ次へ進む」共通ガード
 * （ホームへ戻る・書き出し開始と同じ流儀）。保存に失敗したら何もしない
 * ＝既存の保存エラー表示（tb-save-error）に判断を委ねる。
 *
 * 監査 data-safety-1: サイドバーのプロジェクト切替がこのガードを通っておらず、
 * 別案件をクリックしただけで未保存の編集が確認なしに捨てられていた。
 */
export async function proceedAfterSaving(
  dirty: boolean,
  save: () => Promise<boolean>,
  proceed: () => void,
): Promise<boolean> {
  const saveOk = dirty ? await save() : true;
  if (!shouldProceedToRender(dirty, saveOk)) return false;
  proceed();
  return true;
}

/**
 * サイドバーで別の案件を選んだときの手続き（data-safety-1 の本体）。
 * 同じ案件の再選択は何もしない（開き直すと編集セッションが作り直され、未保存分が消える）。
 * 別案件なら未保存を保存してから切り替え、保存できなければ切り替えない。
 */
export async function pickProjectGuarded(
  nextId: string,
  currentId: string | null,
  dirty: boolean,
  save: () => Promise<boolean>,
  select: (id: string) => void,
): Promise<boolean> {
  if (nextId === currentId) return true;
  return proceedAfterSaving(dirty, save, () => select(nextId));
}

/**
 * 保存衝突（409）の復帰 UI をどちらが出すか（純関数・テスト容易性のため分離）。
 *
 * 外部変更バナーが出ているあいだはバナー側が兼ねる。右上に浮く衝突ポップオーバーは
 * バナーの操作領域を丸ごと覆い、本文だけが「見えないボタンを押せ」と案内し続けていた
 * （レビュー指摘・1440×900 実測で 2 ボタンとも不可視）。復帰 UI は常に 1 つにする。
 */
export function showsConflictInBanner(
  externallyChanged: boolean,
  saveConflict: boolean,
  dirty: boolean,
): boolean {
  return externallyChanged && saveConflict && dirty;
}

/**
 * 上書き保存のあとに出す短い知らせ（data-safety-4・サイクル 3 残 Minor）。
 *
 * 以前はここに退避先のパスと時刻まで詰め込んでいたが、**同じ内容を BackupNotice が
 * 持続表示している**ので二重だった。しかもトーストは 4 秒で消えるため、
 * 「消えて困る情報」（控えの場所）を置く先として間違っている。
 * 詳細（場所・時刻・案件フォルダを開く導線）は BackupNotice に一本化し、
 * ここは「済んだ」ことと「詳細はどこにあるか」だけを言う。
 */
export function overwriteSavedToast(backupDir: string | null): string {
  if (backupDir === null) {
    return 'この画面の内容で上書き保存しました';
  }
  return 'この画面の内容で上書き保存しました（控えの場所は下の案内に出ています）';
}

/**
 * トーストの種別（サイクル 2 レビュー Important）。
 *
 * `.sme-toast` は元々「ステータス書き込み失敗」専用の赤枠だった。そこへ上書き保存の
 * **成功**・操作の**説明**・**失敗**を全部流し込んでいたため、ツールバーが「保存済み ✓」を
 * 出している横で赤い箱が出て、初心者には保存が失敗したように読めた。
 * 種別を持たせ、危険色と role="alert" は本当の失敗にだけ使う。
 */
export type ToastKind = 'success' | 'info' | 'error';

/** 画面に出ている 1 件のトースト。 */
export interface StatusToast {
  text: string;
  kind: ToastKind;
}

/** 種別ごとの class（危険色の枠は error だけ）。 */
export function toastClassName(kind: ToastKind): string {
  return `sme-toast sme-toast-${kind}`;
}

/**
 * 種別ごとの ARIA role。成功・案内で alert を使うと支援技術が読み上げに割り込む。
 * 割り込ませるのは失敗のときだけにする。
 */
export function toastRole(kind: ToastKind): 'alert' | 'status' {
  return kind === 'error' ? 'alert' : 'status';
}

/**
 * 保存に失敗している間の自動保存の状態（data-safety-12）。
 * 自動保存は saveStatus が 'error' のあいだ発火せず、次の編集か手動保存で再開する。
 * 画面に書いていなかったため「黙って止まっている」ことに気づけなかった。
 */
export const SAVE_ERROR_AUTOSAVE_NOTICE =
  '自動保存は一時停止中です。「もう一度保存」を押すか、編集を続けると再開します。';

/** 保存に失敗して案件の切り替えを中止したときの案内。 */
export const PROJECT_SWITCH_ABORTED_TOAST = '保存できなかったため、案件を切り替えませんでした';

/**
 * 焼き込み動画の変換後、保存に失敗して開き直しを見送ったときの案内（サイクル 2 Minor）。
 * これまで無言だったため「変換は終わったのに画面が変わらない」と見えていた。
 */
export const CONVERT_REOPEN_ABORTED_TOAST =
  '保存できなかったため開き直しませんでした。保存してからもう一度お試しください。';

/** 保存できなかったときだけ出す、再読込の最終確認。 */
export const DISCARD_RELOAD_CONFIRM = '保存できませんでした。編集を破棄して再読込しますか？';

/** 外部変更バナーで「保存せずに再読込」を選んだときの確認。 */
export const DISCARD_EDITS_CONFIRM =
  '保存していない編集は失われます。保存せずに再読込しますか？';

/**
 * 完了バナー等からの「再読込」。開き直すと編集セッションが作り直されるため、
 * 未保存があれば必ず先に保存する（監査 data-safety-2）。
 * 保存に成功したら再読込、失敗したときだけ「破棄して再読込するか」を確認する。
 *
 * ただし **衝突（409）で失敗したときは確認を出さない**。外部でプロジェクトファイルが
 * 書き換わったときの保存はまさに 409 になるのが普通で、そこで
 * 「破棄して再読込しますか？」を出すと OK 1 回で編集が消える（レビュー指摘・1 回目の
 * 実走で追加テロップが消失）。409 では既存の衝突 UI（この画面の内容で上書き保存／
 * 開き直す）に委ね、破棄は利用者が明示的に選ぶ二次操作のままにする。
 */
export async function requestReloadGuarded(
  dirty: boolean,
  save: () => Promise<boolean>,
  reload: () => void,
  confirmDiscard: () => boolean,
  isConflict: () => boolean,
): Promise<void> {
  if (!dirty) {
    reload();
    return;
  }
  if (await save()) {
    reload();
    return;
  }
  if (isConflict()) return; // 衝突 UI が 2 択を出す。ここで破棄を促さない。
  if (confirmDiscard()) reload();
}

/**
 * converting はプロジェクト単位フラグ（変換中の projectId）のため、選択中プロジェクトの
 * ものだけ表示する（切替時に無関係なプロジェクトへスピナーが漏れないようにする）。
 */
export function isConvertingSelected(converting: string | null, selectedId: string | null): boolean {
  return converting !== null && selectedId !== null && converting === selectedId;
}

/**
 * installing はプロジェクト単位フラグ（{ kind, projectId }）のため、選択中プロジェクト向け
 * でなければ kind を返さない（表示側は null を「導入中でない」として扱う）。
 */
export function installingKindFor(
  installing: { kind: InstallKind; projectId: string } | null,
  selectedId: string | null,
): InstallKind | null {
  return installing !== null && selectedId !== null && installing.projectId === selectedId ? installing.kind : null;
}

/**
 * useRenderJob の戻り値から ExportNotices へ渡す props を組み立てる（純関数）。
 * render(<App>) は依存が重いため配線を pin するための切り出し（M2d T2 修正2 I-2）。
 * fastCutFallbackMessage は `??` 等で握り潰さずそのまま透過する（null＝理由なしも意味を持つ値）。
 * H-3 以前は同じ props をツールバーへ渡していた（名前は toolbarRenderProps だった）が、
 * 通知の置き場をツールバー直下のバナー枠へ移したのに合わせて渡し先も改名した。
 */
export function exportNoticeProps(render: UseRenderJobReturn): {
  renderState: UseRenderJobReturn['state'];
  fastCutFallbackNotice: boolean;
  fastCutFallbackMessage: string | null;
} {
  return {
    renderState: render.state,
    fastCutFallbackNotice: render.fastCutFallbackNotice,
    fastCutFallbackMessage: render.fastCutFallbackMessage,
  };
}

export function App() {
  const { projects, projectsLoading, projectsError, initialProjectNotice, selectedId, open, selectProject, goHome, externallyChanged, reload, isCurrent, reloadIfSafe, clearExternalChange, patchProject, refreshProjects, patchLibraries } =
    useEditorProject();
  const [initialAgentActivityProject] = useState(() => requestedAgentActivityProject(window.location.search));
  // SSE 1 本統合（/api/events）: 選択中プロジェクトが変わったらバスの接続先を張り替える。
  useEventBusProjectId(selectedId ?? '');
  // 画面下のトースト（自動消滅）。種別で見た目と role を変える。
  const [statusToast, setStatusToast] = useState<StatusToast | null>(null);
  /** トーストを出す。種別を必ず選ばせる（成功・案内を危険色で出さないため）。 */
  const showToast = useCallback((text: string, kind: ToastKind) => {
    setStatusToast({ text, kind });
  }, []);
  /**
   * 上書き保存で消した内容の退避先（data-safety-4）。トーストは 4 秒で消えるので、
   * 復元の唯一の手がかりをそこだけに置かない。閉じるのは利用者の操作だけ
   * （サイクル 2 レビュー Important）。
   */
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  // 案件を切り替えたら、前の案件の控え案内は畳む（別案件の場所を出し続けない）。
  useEffect(() => {
    setBackupNotice(null);
  }, [selectedId]);
  useEffect(() => {
    if (statusToast === null) return;
    const t = setTimeout(() => setStatusToast(null), 4000);
    return () => clearTimeout(t);
  }, [statusToast]);

  /** カードのバッジメニューから手動 stage を変更する（楽観更新→確定 refetch、失敗時は巻き戻し＋トースト）。 */
  const handleSetStage = useCallback(
    (id: string, stage: ProjectStage) => {
      const prev = projects.find((p) => p.id === id);
      // 手動 stage は表示ステータス全値（正本 shared/projectStage）を即バッジへ反映し、
      // 「手動」バッジも同時に立てる。
      // null（自動判定に戻す）はクライアントで status を解決できないため、
      // 手動バッジの解除だけ先に反映して status 自体は refetch に委ねる。
      if (stage !== null) patchProject(id, { status: stage, stageManual: true });
      else patchProject(id, { stageManual: undefined });
      void putJsonPost('/api/project/status', { id, stage })
        .then(() => refreshProjects())
        .catch((err: unknown) => {
          // status フィールドのみ巻き戻す（prev を丸ごと書き戻すと、取得後に SSE 等で
          // 変化した他フィールド — activityLabel/lastEditedAt 等 — まで巻き戻ってしまうため）。
          if (prev) patchProject(id, { status: prev.status, stageManual: prev.stageManual });
          showToast(err instanceof Error ? err.message : 'ステータスの更新に失敗しました', 'error');
        });
    },
    [projects, patchProject, refreshProjects],
  );
  // ステータスのライブ更新を常時購読する（ホーム画面のバッジと、編集中も見える
  // 左サイドバーの「AI 作業中」表示の両方が対象。SSE 1 本＋差分パッチのみで軽量）。
  // onOpen（再接続成功時）に refreshProjects で取りこぼしイベントを埋め合わせる。
  useProjectsWatch(true, patchProject, refreshProjects);
  const { stalePacks, notices: packNotices, revertable: packRevertable, refetch: refetchPackStatus,
    upgrade: upgradePacksReq, revert: revertPacksReq } = usePackStatus(selectedId);
  const { theme, toggle: toggleTheme } = useTheme();
  // サイドバーの開閉はユーザーの選択として永続する（閉じて作業する人の選択を毎回リセットしない）。
  const [folderOpen, setFolderOpen] = useState(() => loadFolderOpen(window.innerWidth >= 1100));
  const toggleFolder = useCallback(() => {
    setFolderOpen((v) => {
      saveFolderOpen(!v);
      return !v;
    });
  }, []);
  const [claudeOpen, setClaudeOpen] = useState(true);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() => loadWorkspaceMode());
  const [userTab, setUserTab] = useState<DockTab>(() => workspaceModeDefaults(workspaceMode).dock);
  const [timelineView, setTimelineView] = useState<TimelineView>(() => workspaceModeDefaults(workspaceMode).timeline);
  const [layout, setLayout] = useState<LayoutPreset>(() => loadLayout());
  function changeLayout(v: LayoutPreset): void {
    setLayout(v);
    saveLayout(v);
  }
  function changeWorkspaceMode(mode: WorkspaceMode): void {
    const defaults = workspaceModeDefaults(mode);
    setWorkspaceMode(mode);
    saveWorkspaceMode(mode);
    setUserTab(current => current === 'script' ? 'script' : defaults.dock);
    setTimelineView(defaults.timeline);
    changeLayout(workspaceModeLayout(mode));
    setClaudeOpen(true);
  }
  const [waveformPref, setWaveformPref] = useState<WaveformPref>(() => loadWaveformPref());
  function changeWaveformPref(v: WaveformPref): void {
    setWaveformPref(v);
    saveWaveformPref(v);
  }
  const playerRef = useRef<PlayerRef>(null);

  // 素材ライブラリ（左カラム素材タブ）の状態。
  const [leftTab, setLeftTab] = useState<LeftTab>('projects');
  const [materialKind, setMaterialKind] = useState<MaterialKind>('se');

  // Finder からの素材ドロップ。拡張子で保存先を振り分け、順にアップロードして
  // 応答のライブラリ一覧で open 状態を部分更新する（プロジェクト reload はしない）。
  const [uploadRemaining, setUploadRemaining] = useState(0);
  const handleDropFiles = useCallback((files: File[]) => {
    if (selectedId === null) return;
    const jobs: Array<{ file: File; kind: MaterialKind }> = [];
    const skipped: string[] = [];
    for (const file of files) {
      const kind = classifyUploadKind(file.name, materialKind);
      if (kind === null) skipped.push(file.name);
      else jobs.push({ file, kind });
    }
    // トースト枠は1つなので、スキップ警告と大容量案内は1メッセージに束ねる。
    const notices: string[] = [];
    if (skipped.length > 0) notices.push(`対応していないファイルをスキップしました: ${skipped.join(', ')}`);
    if (jobs.some((j) => j.file.size > LARGE_UPLOAD_NOTICE_BYTES)) {
      notices.push('容量の大きいファイルが含まれています。アップロードに時間がかかることがあります。');
    }
    if (notices.length > 0) showToast(notices.join(' / '), 'info');
    if (jobs.length === 0) return;
    setUploadRemaining((n) => n + jobs.length);
    void (async () => {
      for (const job of jobs) {
        try {
          const res = await uploadMaterial(selectedId, job.kind, job.file);
          if (!isCurrent(selectedId)) return;
          patchLibraries(res);
        } catch (err) {
          showToast(err instanceof Error ? err.message : 'アップロードに失敗しました', 'error');
        } finally {
          setUploadRemaining((n) => Math.max(0, n - 1));
        }
      }
      // 最初のファイルの種別タブへ切り替えて、追加された素材がすぐ見えるようにする。
      const first = jobs[0];
      if (first && isCurrent(selectedId)) setMaterialKind(first.kind);
    })();
  }, [selectedId, materialKind, isCurrent, patchLibraries]);

  // New projects always use managed media and open in the native editor.
  const handleCreateProject = useCallback(async (name: string, source: CreateSource) => {
    const { id } = source.kind === 'upload-images' ? await createNativeImageProject(name, source.files)
      : source.kind === 'link-images' ? await createNativeImageProject(name, source.files.map(file => file.path))
      : await createNativeProject(name, source.kind === 'upload' ? source.file : source.path);
    location.assign(`/?${new URLSearchParams({ project: id })}`);
  }, []);

  // ドロップゾーン外への誤ドロップでブラウザがファイルを開いて編集が飛ぶ事故を防ぐ。
  // （アプリ内の素材/クリップのドラッグは PointerEvent ベースなので影響しない）
  useEffect(() => {
    const prevent = (e: DragEvent): void => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);
  const audition = useAudition();
  // 素材のドラッグ挿入とクリック挿入の取り合いを防ぐフラグ＋ドラッグ状態。
  const suppressClickRef = useRef(false);
  const timelineDropRef = useRef<TimelineDropApi>(null);

  /**
   * 吸着の共有設定（監査 interaction-7）。**App に 1 つだけ**持ち、タイムラインと
   * プレビューへ同じものを配る。以前はタイムラインだけがトグルと Alt 一時解除を持ち、
   * プレビュー上の位置ドラッグは常時吸着で逃げ道が無かった。
   */
  const snapPref = useSnapPref();

  // 外付けリンクの張り直し用ファイラを開いているか。
  const [relinkOpen, setRelinkOpen] = useState(false);
  // 張り直し時に「別の動画に見える」場合の確認内容（null なら確認なし）。
  const [relinkConfirm, setRelinkConfirm] = useState<{ path: string; warnings: string[] } | null>(null);

  // JKL トランスポートの再生速度（負＝逆再生）。Timeline のキー操作で更新し Preview の Player へ渡す。
  // 停止時は Timeline 側で 1 へ戻すため、等速以外は「再生中だけ」の状態。
  const [playbackRate, setPlaybackRate] = useState(1);
  const dragRef = useRef<{ kind: MaterialKind; file: string; x0: number; y0: number; active: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ kind: MaterialKind; file: string; x: number; y: number } | null>(null);

  const baseProject = open.status === 'ready' ? open.project : null;
  const saveMeta = open.status === 'ready' ? open.save : null;
  const session = useEditSession(
    selectedId,
    baseProject,
    saveMeta,
    open.status === 'ready' ? open.telopPackInstalled : false,
  );
  const preferenceBridge = usePreferenceEditBridge(session, selectedId);
  const commandBridge = useEditorCommandBridge(session, selectedId);
  const agentConnection = useEditorAgentConnection(commandBridge, selectedId, (operation) => {
    if (operation.request.projectId !== selectedId) return;
    showToast(operation.phase === 'saved' ? (operation.request.script ? '採用した台本の変更を保存しました。「AIの作業」で内容を確認できます。' : 'AIの字幕変更を保存しました。「AIの作業」で内容を確認できます。')
      : operation.phase === 'cancelled' ? 'AI編集の停止結果を記録しました。'
      : 'AI編集を完了できませんでした。「AIの作業」で結果を確認してください。', operation.phase === 'failed' ? 'error' : 'info');
  }, open.status === 'error');
  // handleInstall / onPackUpgraded は await の後（＝着地時）に「今 dirty か」を見る必要があるが、
  // それらのクロージャは呼び出し時点の render の session を捕まえたまま await を挟むため、
  // await 中に dirty が変わっても素の session 参照では古い値のままになる（stale closure）。
  // 常に最新値を読めるよう ref に鏡写しする（selectedIdRef と同じ理由・同じ形）。
  const sessionRef = useRef(session);
  useLayoutEffect(() => {
    sessionRef.current = session;
  }, [session]);
  // 導入・部品更新の着地時に「未保存編集があって黙って reload できなかった」ことをユーザーへ知らせ、
  // 手動での再読込を促すためのフラグ（ExternalChangeBanner と同じ「dirty なら黙って捨てない」規律）。
  const [pendingReload, setPendingReload] = useState(false);
  // 再読込の唯一の入口。保留中の再読込案内（pendingReload）は**再読込が成立したとき**に消す
  // （reload は selectedId を変えないので、切替時の自動解除には乗らない・マージレビュー P2-3）。
  const reloadProject = useCallback(() => {
    setPendingReload(false);
    reload();
  }, [reload]);

  // 素材削除フロー（ゴミ箱方式）。usedCount はクライアント編集状態＋サーバ走査の合算。
  // force はユーザーが使用中警告を確認済みのときのみ true。
  // 素材ゴミ箱一覧（プロジェクト単位）。
  const [trashOpen, setTrashOpen] = useState(false);

  const [trashConfirm, setTrashConfirm] = useState<{
    kind: MaterialKind;
    file: string;
    usedCount: number;
    force: boolean;
  } | null>(null);

  const handleDeleteMaterial = useCallback(
    (kind: MaterialKind, file: string) => {
      // 未保存の参照を含む現行編集状態から使用箇所を数える（サーバはディスクしか見えない）。
      const used = session === null ? 0 : collectUsedAssetKeys(session.state).get(makeAssetKey(kind, file)) ?? 0;
      setTrashConfirm({ kind, file, usedCount: used, force: used > 0 });
    },
    [session],
  );

  // 削除リクエスト送信中フラグ。送信中はダイアログの両ボタンを無効化する
  // （連打で二重送信したり、二段目の警告が出た瞬間に Enter で確定するのを防ぐ）。
  const [trashPending, setTrashPending] = useState(false);

  const confirmTrashMaterial = useCallback(() => {
    if (trashConfirm === null || selectedId === null || trashPending) return;
    const { kind, file, force, usedCount } = trashConfirm;
    setTrashPending(true);
    void deleteMaterialRequest(selectedId, kind, file, force)
      .then((res) => {
        if (!res.ok) {
          if (res.code === 'in-use') {
            // サーバ走査で新たに見つかった使用箇所を合算して再確認（既定キャンセル）。
            // ダイアログは key で再マウントされるため autoFocus（キャンセル）が効き直す。
            setTrashConfirm({ kind, file, usedCount: usedCount + res.count, force: true });
            return;
          }
          setTrashConfirm(null);
          showToast('使用状況を確認できないため、削除を保留しました', 'error');
          return;
        }
        setTrashConfirm(null);
        patchLibraries(res.libraries);
        // usedCount はサーバがディスクを走査して数えた実数（force で消したときも数える）。
        showToast(
          res.usedCount !== null && res.usedCount > 0
            ? `ゴミ箱へ移動しました: ${file}（${res.usedCount} 箇所で使われていました）`
            : `ゴミ箱へ移動しました: ${file}`,
          'success',
        );
      })
      .catch((err: unknown) => {
        setTrashConfirm(null);
        showToast(err instanceof Error ? err.message : '削除に失敗しました', 'error');
      })
      .finally(() => setTrashPending(false));
  }, [trashConfirm, selectedId, trashPending, patchLibraries]);

  // 未保存の変更があるままタブを閉じる／リロードしようとした時にブラウザ標準の確認を出す。
  useUnsavedGuard(session?.dirty ?? false);

  // 自動保存（既定 ON・⚙メニューでトグル、localStorage 永続）。
  // dirty になってから編集が落ち着くと既存の session.save()（外部変更ウォッチの自己保存抑制・
  // samePersistedContent 等をそのまま適用する経路）を呼ぶ。保存失敗（saveStatus:'error'）後は
  // 自動リトライしない（tb-save-error 表示に任せる）。保存が走れば dirty が消え、上の
  // useUnsavedGuard も自然に外れる。
  const [autoSaveEnabled, setAutoSaveEnabledState] = useState(() => loadAutoSaveEnabled());
  const setAutoSaveEnabled = useCallback((v: boolean) => {
    setAutoSaveEnabledState(v);
    saveAutoSaveEnabled(v);
  }, []);
  // e2e はサーバ既定（/api/config の autoSaveDefaultEnabled）で自動保存を既定 OFF にする
  // （SME_AUTO_SAVE=0・playwright.config.ts）。ユーザーが⚙メニューで明示的に選択済みなら
  // その選択を常に優先し、このサーバ既定では上書きしない。
  useEffect(() => {
    if (hasExplicitAutoSavePref()) return;
    let alive = true;
    void fetch('/api/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { autoSaveDefaultEnabled?: boolean } | null) => {
        if (alive && body && body.autoSaveDefaultEnabled === false) {
          setAutoSaveEnabledState(false);
        }
      })
      .catch((e: unknown) => {
        // 取得できなくてもクライアント既定（自動保存 ON）で動く。ただし黙って飲むと
        // 「e2e で自動保存が既定 OFF にならない」等の原因が追えないので必ず残す（E-2）。
        // eslint-disable-next-line no-console
        console.warn('/api/config の取得に失敗しました（クライアント既定で続行）', e);
      });
    return () => {
      alive = false;
    };
  }, []);
  const autoSaveDelayMs = useMemo(
    () => parseAutoSaveDelayOverride(window.location.search) ?? AUTO_SAVE_DELAY_MS,
    [],
  );
  useAutoSave({
    enabled: autoSaveEnabled,
    dirty: session?.dirty ?? false,
    saveStatus: session?.saveStatus ?? 'idle',
    state: session?.state ?? null,
    save: session ? session.save : async () => false,
    delayMs: autoSaveDelayMs,
  });

  // ホームへ戻る: 未保存の編集があれば先に自動保存し、保存できなければ戻らない
  // （書き出し開始時の A案 と同じ流儀。保存エラー表示は既存 UI に任せる）。
  const handleGoHome = useCallback(async () => {
    const dirty = session?.dirty ?? false;
    const stillSame = session ? session.sessionGuard() : () => true;
    const saveOk = session && dirty ? await session.save() : true;
    // 保存の往復中にセッションが差し替わっていたら（破棄して開き直し→再編集）、古い応答で戻らない。
    if (!stillSame()) return;
    if (!shouldProceedToRender(dirty, saveOk)) {
      showToast('未保存の変更を保存できなかったため、ホームへ戻るのを中止しました', 'error');
      return;
    }
    goHome();
    // 編集・書き出しでステータスが変わっている可能性があるためホーム一覧を更新する。
    void refreshProjects().catch((e: unknown) => {
      // 一覧が古いままになるだけで、ホーム表示自体は続く。原因追跡のため握り潰さない。
      // eslint-disable-next-line no-console
      console.warn('ホーム一覧の更新に失敗しました（表示は前回の一覧のまま）', e);
    });
  }, [session, goHome, refreshProjects]);

  // サイドバーで別の案件を選ぶ: ホームへ戻るのと同じく、未保存があれば先に保存し、
  // 保存できたときだけ切り替える（data-safety-1）。同じ案件の再選択は何もしない
  // （開き直しで編集セッションが作り直され、未保存分が消えるのを防ぐ）。
  const handlePickProject = useCallback(
    async (id: string) => {
      const stillSame = session ? session.sessionGuard() : () => true;
      const switched = await pickProjectGuarded(
        id,
        selectedId,
        session?.dirty ?? false,
        session ? session.save : async () => true,
        (next) => {
          // 保存の往復中にセッションが差し替わっていたら（破棄して開き直し→再編集）、古い応答で切り替えない。
          if (stillSame()) selectProject(next);
        },
      );
      if (!stillSame()) return;
      // 黙って「押しても何も起きない」状態にしない（サイクル 1 レビューの残件）。
      if (!switched) showToast(PROJECT_SWITCH_ABORTED_TOAST, 'error');
    },
    [selectedId, session, selectProject],
  );

  // 完了バナー（文字起こし・ノイズ除去・音量調整・軽量プレビュー）と外部変更バナーの
  // 「再読込」の入口。未保存があれば保存してから開き直す（data-safety-2／3）。
  const requestReload = useCallback(async () => {
    // 保存の往復中にセッションが差し替わっていたら（破棄して開き直し→再編集）、古い応答の
    // 保存成功で新セッションの編集を再読込で捨てない（マージレビュー Codex P1）。
    const stillSame = session ? session.sessionGuard() : () => true;
    await requestReloadGuarded(
      session?.dirty ?? false,
      session ? session.save : async () => true,
      () => {
        if (stillSame()) reloadProject();
      },
      () => stillSame() && window.confirm(DISCARD_RELOAD_CONFIRM),
      session ? session.isSaveConflict : () => false,
    );
  }, [session, reloadProject]);

  // 外部変更バナーの二次操作「保存せずに再読込」。破棄になるので必ず確認を挟む（data-safety-3）。
  // 衝突の復帰 UI は「バナー」か「右上のポップオーバー」のどちらか一方だけを出す。
  const showConflictInBanner = showsConflictInBanner(
    externallyChanged,
    session?.saveConflict ?? false,
    session?.dirty ?? false,
  );

  const discardAndReload = useCallback(() => {
    if (window.confirm(DISCARD_EDITS_CONFIRM)) reloadProject();
  }, [reloadProject]);


  // 書き出し（render）ジョブ。プロジェクト未選択時は空文字（フック側で no-op）。
  const render = useRenderJob(selectedId ?? '');
  // Export completion is not a preference judgment. Review is explicit through AIの作業 / 編集の好み.
  // 書き出しボタン → プリセット選択ダイアログ → 開始。
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  // 撮影エンジン（chrome-headless-shell）の状態（M2d T2・I-4／修正ラウンド2・I-1）。
  //
  // 起動時に1回取得し、ダイアログを開くたびに取り直す。取り直しの間は**前回値を保持**する
  // （旧実装は開くたび undefined へ戻していたため、fetch 完了までの数十 ms は「未取得＝従来表示」
  //  になり、エンジン未導入でも「高速で書き出せる見込み」が一瞬出ていた）。
  // 起動時 fetch があるため、2 回目以降は初期表示から実値が入る。
  // 実体は useCaptureEngineStatus（App から抽出・StrictMode 二重マウント対応済み）。
  const captureEngine = useCaptureEngineStatus(exportDialogOpen);
  // 書き出し開始: 未保存があれば先に自動保存（A案）。保存失敗時は開始しない
  // （既存の tb-save-error 表示に委ねる）。
  const handleRenderStart = async (options: RenderOptions, predictedFastCut: boolean) => {
    setExportDialogOpen(false);
    const dirty = session?.dirty ?? false;
    const saveOk = session && dirty ? await session.save() : true;
    if (!shouldProceedToRender(dirty, saveOk)) return; // 保存できなければ書き出さない（既存の保存エラー表示に任せる）
    // session がある時だけ現在の ducking 設定を同梱する（EditState 上は必須フィールドなので ?? 不要）。
    // session が null なら ducking フィールド自体を省く（undefined → 従来の焼き込み検知ゲートへ・保守的）。
    await render.start(
      session ? { ...options, ducking: session.state.ducking } : options,
      predictedFastCut,
    );
  };

  const orientation = baseProject ? orientationCode(baseProject.videoConfig.orientation) : 'v';

  // 描画ツール種別（null なら通常の選択・移動モード）。
  // 受入基準: App.tsx に drawingKind state の最小配線（音声パネル/transcribe 配線に触れない）。
  const [drawingKind, setDrawingKind] = useState<DrawingKind>(null);

  // converting は変換中の projectId（プロジェクト単位フラグ）。選択中プロジェクトと
  // 一致する場合のみバナーに表示し、切替時に無関係なプロジェクトへスピナーが漏れないようにする。
  const [converting, setConverting] = useState<string | null>(null);
  const [convertError, setConvertError] = useState<string | null>(null);
  // state は非同期反映のため、同一レンダー内の連続クリックは state ガードをすり抜ける。
  // ref を同期的な排他ロックとして併用する（handleInstall の installingRef と同じ理由）。
  const convertingRef = useRef(false);
  // 導入は同時に1件のみ（構成変更＋再読込を伴うため排他）。エラーは kind 別に保持し、
  // 別機能の CTA/バナーへ漏れないようにする（残課題 #5 の state 分離）。
  // installing は { kind, projectId } のプロジェクト単位フラグ。busy（排他）は installing !== null
  // のまま全体で判定し、表示は選択中プロジェクト向けかどうかで絞り込む。
  const [installing, setInstalling] = useState<{ kind: InstallKind; projectId: string } | null>(null);
  const [installErrors, setInstallErrors] = useState<InstallErrors>({});
  // state は非同期反映のため、同一レンダー内の連続クリックは state ガードをすり抜ける。
  // ref を同期的な排他ロックとして併用する。
  const installingRef = useRef<InstallKind | null>(null);

  // プロジェクトを切り替えたら前プロジェクトの変換/導入エラー表示・保留中の再読込案内を消す。
  useEffect(() => {
    setConvertError(null);
    setInstallErrors({});
    setPendingReload(false);
  }, [selectedId]);

  async function handleInstall(kind: InstallKind): Promise<void> {
    if (selectedId === null || installingRef.current !== null) return;
    const id = selectedId;
    installingRef.current = kind;
    setInstalling({ kind, projectId: id });
    // 再導入の開始時点で自分の古いエラーは隠す（他 kind のエラーは保持）。
    setInstallErrors((prev) => {
      const next = { ...prev };
      delete next[kind];
      return next;
    });
    try {
      const { path, failMessage } = INSTALL_APIS[kind];
      const res = await fetch(`${path}?id=${encodeURIComponent(id)}`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? failMessage);
      }
      // 切替済みなら開き直さない（勝手に前のプロジェクトへ引き戻さない）。
      if (isCurrent(id)) {
        setInstallErrors({});
        // await の間に今のプロジェクトで編集が進み dirty になっていたら、黙って開き直して
        // 未保存編集を消さない。ユーザーに再読込を促すバナーへ倒す。
        if (!reloadIfSafe(id, sessionRef.current?.dirty ?? false)) {
          setPendingReload(true);
        } else {
          // 開き直せたなら、以前の着地で立てた再読込案内は用済み（マージレビュー Codex P2）。
          setPendingReload(false);
        }
      }
    } catch (err) {
      // 切替済みなら前プロジェクトのエラーを今の CTA/バナーに出さない。
      if (isCurrent(id)) {
        setInstallErrors((prev) => ({ ...prev, [kind]: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`[sme] 導入に失敗（プロジェクト ${id}・切替済みのため非表示）:`, err);
      }
    } finally {
      installingRef.current = null;
      setInstalling(null);
    }
  }

  // cutData.ts 不在のプロジェクトを非破壊モデルへ変換し、成功後に再読込する。
  async function handleConvert(): Promise<void> {
    if (selectedId === null || convertingRef.current) return;
    const id = selectedId;
    convertingRef.current = true;
    setConverting(id);
    setConvertError(null);
    try {
      const res = await fetch(
        `/api/convert-burned-in?id=${encodeURIComponent(id)}`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? '変換に失敗しました');
      }
      // cutData.ts が生成されたのでプロジェクトを開き直す。
      // ただし変換中に別プロジェクトへ切り替えていたら、勝手に引き戻さない
      // （切替先に戻った時に通常の読込で新しい cutData が反映される）。
      // 変換後の開き直しも未保存を巻き込まない（UX data-safety-1 と hardening reloadIfSafe の
      // 両方の規律）。未保存があれば先に保存し、保存できたときだけ開き直す。保存できなければ
      // 開き直さず、再読込の案内バナー（pendingReload）とトーストで知らせる（黙って消さない・黙って止まらない）。
      if (isCurrent(id)) {
        const s = sessionRef.current;
        if (s && s.dirty) {
          // 保存の往復のあいだに別案件へ切り替わった／開き直されたら引き戻さず、失敗通知も持ち込まない
          // （着地時に isCurrent とセッション世代を再確認）。
          const stillSame = s.sessionGuard();
          const reopened = await proceedAfterSaving(true, s.save, () => {
            if (isCurrent(id) && stillSame()) reloadProject();
          });
          if (isCurrent(id) && stillSame()) {
            if (!reopened) setPendingReload(true);
            if (!reopened) showToast(CONVERT_REOPEN_ABORTED_TOAST, 'error');
          }
        } else if (!reloadIfSafe(id, sessionRef.current?.dirty ?? false)) {
          // 未保存が無くても開き直せない（変換中に切り替わった等）なら案内だけ立てる。
          setPendingReload(true);
        } else {
          setPendingReload(false);
        }
      }
    } catch (err) {
      // 切替済みなら前プロジェクトのエラーを今のバナーに出さない（変換競合の残留文言防止）。
      // 失敗理由が完全に消えないよう console には残す。
      if (isCurrent(id)) {
        setConvertError(err instanceof Error ? err.message : String(err));
      } else {
        console.error(`[sme] 変換に失敗（プロジェクト ${id}・切替済みのため非表示）:`, err);
      }
    } finally {
      convertingRef.current = false;
      setConverting(null);
    }
  }

  // レイアウトに影響する data 属性はペイント前に反映する（useLayoutEffect）。
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-orientation', orientation);
    root.setAttribute('data-folder', folderOpen ? 'open' : 'closed');
    root.setAttribute('data-claude', claudeOpen ? 'open' : 'closed');
    root.setAttribute('data-layout', layout);
    root.setAttribute('data-workspace-mode', workspaceMode);
    root.setAttribute('data-timeline-view', timelineView);
    // ホーム（プロジェクト未選択）はカンバンボード専用モード。
    // タイムライン行と右ドック列を CSS で消し、ボードを全幅・全高にする。
    root.setAttribute('data-home', open.status === 'idle' ? 'on' : 'off');
  }, [orientation, folderOpen, claudeOpen, layout, workspaceMode, timelineView, open.status]);

  // カット確認モード。ON の間はカットを適用せず原本全体を再生できる（長いカット区間の中身確認用）。
  // 場面転換・速度も外し、プレイヤーフレーム＝再生フレーム＝原本フレームの恒等にして座標変換を単純化する。
  const [previewCuts, setPreviewCuts] = useState(false);
  const pendingCutViewSeekRef = useRef<{ bypassed: boolean; originalFrame: number } | null>(null);

  // 書き出しと同じ完成後モデル。確認モードの全体帯は、素材確認中でもこの尺と座標を正とする。
  const finalModel = useMemo(() => {
    if (!baseProject || !session) return null;
    return buildPlaybackModel(toEditorProject(session.state, baseProject));
  }, [baseProject, session]);

  // Player 用モデル。カット確認中だけ原本全体の恒等再生へ切り替える。
  const model = useMemo(() => {
    if (!baseProject || !session) return null;
    if (!previewCuts) return finalModel;
    const proj = toEditorProject(session.state, baseProject);
    return buildPlaybackModel({
      ...proj,
      cutRegions: [],
      // カットを外す以上、カット並び替えも外す（Timeline 側の playbackOrdering と対称）。
      cutOrder: [],
      sceneTransitions: [],
      mainSpeed: 1,
      segmentSpeeds: {},
    });
  }, [baseProject, session, previewCuts, finalModel]);

  // Player のモデル更新後に同じ原素材frameへ戻す。完成順へ戻る時にカット内なら
  // 最寄りの表示可能frameへ寄せ、完成座標へ正しく射影する。
  useLayoutEffect(() => {
    const pending = pendingCutViewSeekRef.current;
    if (pending === null || pending.bypassed !== previewCuts || !baseProject || !session || !model) return;
    pendingCutViewSeekRef.current = null;
    if (previewCuts) {
      playerRef.current?.seekTo(Math.max(0, Math.min(baseProject.videoConfig.durationFrames - 1, pending.originalFrame)));
      return;
    }
    const source = nearestKeptOriginalFrame(pending.originalFrame, baseProject.videoConfig.durationFrames, session.state.cutRegions);
    const playback = originalToPlayback(source, session.state.cutRegions, cutOrderingOf(session.state));
    playerRef.current?.seekTo(playbackToPlayer(playback ?? 0, model));
  }, [previewCuts, baseProject, session, model]);

  // 撮影（native capture）が要るか＝サーバ（fastCutPlan）と同じ述語を、同じ射影後の配列に当てる（I-3）。
  // カット確認モード（previewCuts）ではカットを外したモデルを描いているため、
  // 判定にはカット適用後のモデルを別途組む（プレビュー表示ではなく書き出しの姿を答える）。
  // ダイアログが閉じている間は使われない値なので計算しない（修正ラウンド2・M-4。
  // previewCuts での再計算・buildPlaybackModel は軽くないため、開いている時だけに絞る）。
  const needsCapture = useMemo(() => {
    if (!exportDialogOpen || !baseProject || !session) return false;
    return finalModel !== null && hasCaptureOverlays(finalModel);
  }, [exportDialogOpen, baseProject, session, finalModel]);

  const fps = baseProject?.videoConfig.fps ?? 30;
  const projectName = projects.find((p) => p.id === selectedId)?.name ?? null;
  // &v=<videoVersion> は波形キャッシュのバスター。動画を差し替え/削除すると
  // サイズ＋mtime が変わり URL が変わるので、波形が古いまま残らない（spec §6・サーバは v を無視）。
  const videoVersion = open.status === 'ready' ? open.videoVersion : null;
  const baseVideoUrl =
    baseProject && selectedId !== null
      ? `/api/video?id=${encodeURIComponent(selectedId)}&file=${encodeURIComponent(baseProject.videoConfig.videoFile)}${videoVersion !== null ? `&v=${encodeURIComponent(videoVersion)}` : ''}`
      : '';

  // プレビュー再読み込み（C-4）: 黒画面・映像停止（Windows フィードバック）の応急処置。
  // Remotion Player だけを key で再マウントし、動画 URL も reload= でキャッシュバストする。
  // 編集状態（undo 履歴・選択・未保存の変更）は App/session 側に残るため保持される。
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const pendingReloadFrameRef = useRef<number | null>(null);
  const videoUrl = withReloadBust(baseVideoUrl, previewReloadKey);
  const handleReloadPreview = useCallback(() => {
    pendingReloadFrameRef.current = playerRef.current?.getCurrentFrame() ?? 0;
    setPreviewReloadKey((k) => nextReloadKey(k));
  }, []);
  // Player 再マウント後、直前の再生ヘッド位置へ復元する。
  // ref は commit フェーズで再アタッチ済みのため、この effect の時点で新インスタンスを指している。
  useEffect(() => {
    if (previewReloadKey === 0) return;
    const frame = pendingReloadFrameRef.current;
    pendingReloadFrameRef.current = null;
    if (frame !== null) playerRef.current?.seekTo(frame);
  }, [previewReloadKey]);

  // 双方向ハイライト中の原本フレーム区間（履歴に積まない一時シグナル）。
  // 文字起こしチップ hover / カットブロック hover の双方が読み書きする。
  const [highlightRange, setHighlightRange] = useState<{ start: number; end: number } | null>(null);

  // キーボードショートカット: Undo / Redo / 保存。
  useEffect(() => {
    if (!session) return;
    function onKey(e: KeyboardEvent): void {
      if (!session) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();

      // フォーカスが編集可能要素にあるかどうかを判定する。
      const target = e.target as HTMLElement | null;
      const inEditable =
        (target instanceof HTMLInputElement && target.type !== 'range') ||
        target instanceof HTMLTextAreaElement ||
        (target?.isContentEditable ?? false);

      // 前面にモーダルがある間は、背後の編集履歴と保存を動かさない。モーダル内の入力欄では
      // 文字単位のnative Undo/Redoを維持し、それ以外のUndo/RedoとSave Asだけを抑止する。
      if (isModalOpen()) {
        if (key === 's' || (!inEditable && (key === 'z' || key === 'y'))) e.preventDefault();
        return;
      }

      if (key === 'z' && !e.shiftKey) {
        // 編集可能要素フォーカス中はブラウザのテキスト Undo に委ねる。
        if (inEditable) return;
        e.preventDefault();
        session.undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        // 編集可能要素フォーカス中はブラウザのテキスト Redo に委ねる。
        if (inEditable) return;
        e.preventDefault();
        session.redo();
      } else if (key === 's') {
        // 保存はフォーカス位置に関わらず常に実行する（ブラウザの「ページを保存」は抑止）。
        e.preventDefault();
        void session.save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  // 送信時に「今見ている文脈」を読み取る。playerRef と編集状態（選択）から合成。
  function buildContext(): InstructionContext {
    const frame = playerRef.current?.getCurrentFrame() ?? 0;
    const selection = session?.state.selection ?? null;
    return {
      frame,
      timeSec: frame / fps,
      // selection.id は editState では number だが InstructionContext では string を要求するため変換。
      // join・mainVideo・cutSegment 種別は InstructionContext の selection に含まれないため除外する。
      selection: selection && selection.kind !== 'join' && selection.kind !== 'mainVideo' && selection.kind !== 'cutSegment' ? { kind: selection.kind, id: selection.id.toString() } : null,
    };
  }

  // 右ドックのアクティブタブ。選択が「変わった」ときだけ自動でタブを寄せる。
  // useEffect（非同期）だと「選択→即タブクリック」と競合するため、描画中に前回選択と
  // 比較して同期的に state 調整する React 公式パターンを使う（タブクリックと戦わない）。
  const selKey = session && session.state.selection
    ? session.state.selection.kind === 'join'
      ? `join:${String(session.state.selection.at)}`
      : session.state.selection.kind === 'mainVideo'
        ? 'mainVideo'
        : `${session.state.selection.kind}:${session.state.selection.id}`
    : null;
  const [lastSelKey, setLastSelKey] = useState<string | null>(null);
  let activeTab: DockTab = userTab;
  if (selKey !== lastSelKey) {
    setLastSelKey(selKey);
    const auto = session ? workspaceMode === 'edit' && session.state.selection ? 'settings' : tabForSelection(session.state) : null;
    if (auto) {
      setUserTab(auto);
      activeTab = auto;
    }
  }
  // 確認/編集では本文とカット判断に集中し、色・位置・音声などの調整は仕上げだけに出す。
  if (workspaceMode === 'review' && activeTab === 'settings') activeTab = 'transcript';
  // タブクリック: userTab を切替（選択は維持＝設定タブに選択中クリップが全幅で出続ける）。
  function pickTab(tab: DockTab): void {
    setUserTab(tab);
  }
  // 「← 文字起こしに戻る」: 選択を解除して文字起こしへ。
  function backToTranscript(): void {
    if (session) session.setTransient({ ...session.state, selection: null });
    setUserTab('transcript');
  }

  // 字幕編集モードかつ字幕選択中なら、文字起こしの隣に設定側パネル（subpanel）を出す。
  const subPanelOn = session ? showsSubtitlePanel(session.state, layout, activeTab) : false;
  const selectedSubtitle =
    subPanelOn && session && session.state.selection?.kind === 'telop'
      ? session.state.telops.find((t) => t.id === (session.state.selection as { kind: 'telop'; id: number }).id)
      : undefined;
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-subpanel', subPanelOn ? 'on' : 'off');
  }, [subPanelOn]);

  // 素材ライブラリ用。プロジェクト未オープン時は空配列。
  const seLibrary = open.status === 'ready' ? open.seLibrary : [];
  const imageLibrary = open.status === 'ready' ? open.imageLibrary : [];
  const bgmLibrary = open.status === 'ready' ? open.bgmLibrary : [];
  const videoLibrary = open.status === 'ready' ? open.videoLibrary : [];
  // asset URL の &v= トークン（同名差し替えの stale キャッシュバスト）。
  const assetVersions = open.status === 'ready' ? open.assetVersions : undefined;

  // クリック挿入: 再生ヘッド（プレイバック）→原本フレームへ変換して挿入。
  function insertMaterial(kind: MaterialKind, file: string): void {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!session) return;
    // Player の現在フレームは速度後座標。playerToPlayback で再生座標へ戻してから原本へ。
    const pf = playerRef.current?.getCurrentFrame() ?? 0;
    const orig = (workspaceMode === 'edit' && !previewCuts && model
      ? sequenceSourceFrameAt(model.keptSegments, model.overlaps, pf)?.originalFrame : undefined) ?? playbackToOriginal(
      model ? playerToPlayback(pf, model) : pf,
      previewCuts ? [] : session.state.cutRegions,
      previewCuts ? undefined : cutOrderingOf(session.state),
    );
    session.apply(applyInsertMaterial(kind, session.state, file, orig));
  }

  // ドラッグ挿入: しきい値を超えたらゴーストを出し、離した位置を Timeline がフレーム化して挿入。
  const onMaterialMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
      d.active = true;
    }
    setGhost({ kind: d.kind, file: d.file, x: e.clientX, y: e.clientY });
  }, []);

  const onMaterialUp = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      window.removeEventListener('pointermove', onMaterialMove);
      window.removeEventListener('pointerup', onMaterialUp);
      dragRef.current = null;
      setGhost(null);
      if (d && d.active) {
        // ドラッグだった → 直後の click による二重挿入を抑止し、ドロップ位置へ挿入。
        suppressClickRef.current = true;
        timelineDropRef.current?.dropMaterial(d.kind, d.file, e.clientX, e.clientY);
      }
    },
    [onMaterialMove],
  );

  const onMaterialDragStart = useCallback(
    (kind: MaterialKind, file: string, e: React.PointerEvent) => {
      // 新しい押下のたびに抑止フラグをリセット。前回のドラッグでドロップ先が
      // タイムライン（別要素）だと行の click が発火せず true が残るため、ここで必ず戻す。
      suppressClickRef.current = false;
      dragRef.current = { kind, file, x0: e.clientX, y0: e.clientY, active: false };
      window.addEventListener('pointermove', onMaterialMove);
      window.addEventListener('pointerup', onMaterialUp);
    },
    [onMaterialMove, onMaterialUp],
  );

  // 初回チュートリアル（ホームで自動開始・図鑑の「もう一度最初から見る」から再実行）。
  const tutorial = useTutorial({
    home: open.status === 'idle',
    hasProjects: projects.length > 0,
    editorReady: open.status === 'ready' && session !== null,
    telopCount: session?.state.telops.length ?? 0,
    dirty: session?.dirty ?? false,
  });
  // チュートリアル図鑑（？ボタン・⚙メニュー「チュートリアル図鑑」から開く）。
  const [helpOpen, setHelpOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [agentActivityOpen, setAgentActivityOpen] = useState(false);
  const [agentReviewTarget, setAgentReviewTarget] = useState<EditorReviewTarget | null>(null);
  const openAgentActivity = () => {
    playerRef.current?.pause();
    agentConnection.clearError();
    setAgentActivityOpen(true);
  };
  useInitialAgentActivity(
    initialAgentActivityProject,
    projectsLoading || projectsError !== null
      ? null
      : initialAgentActivityProject !== null && projects.some((project) => project.id === initialAgentActivityProject),
    selectedId,
    open.status,
    () => {
      playerRef.current?.pause();
      agentConnection.clearError();
      setAgentActivityOpen(true);
    },
  );
  const restartTutorialFromHelp = useCallback(() => {
    setHelpOpen(false);
    tutorial.start();
  }, [tutorial]);

  // 保存エラー箱（右上に固定表示）が、上のバナー帯のボタンに重ならないようにする
  // （サイクル 2 Minor）。帯の高さを測って CSS 変数へ流し、箱の top をその下へずらす。
  // 計測は初回 1 回だけ（以後の高さ変化は ResizeObserver）。毎レンダーで測ると
  // ドラッグ中（pointermove ごとの再描画）に強制レイアウトが入る。
  const bannerSlotRef = useRef<HTMLDivElement>(null);
  useBannerSlotHeight(bannerSlotRef);

  // AI エージェント（コンピュータユース）向けの画面状態。
  // 見た目の文字列を推測せずに「保存されたか」「書き出しが終わったか」を判定できるようにする。
  const beaconSelection =
    session && session.state.selection
      ? session.state.selection.kind === 'join'
        ? { kind: 'join', id: String(session.state.selection.at) }
        : session.state.selection.kind === 'mainVideo'
          ? { kind: 'mainVideo', id: '' }
          : { kind: session.state.selection.kind, id: String(session.state.selection.id) }
      : null;

  return (
    <div className="app">
      <AppStateBeacon
        state={{
          project: projectName,
          dirty: session?.dirty ?? false,
          saveStatus: session?.saveStatus ?? 'idle',
          selection: beaconSelection,
          warnings: open.status === 'ready' && open.validation ? open.validation.warnings : [],
          renderStatus: render.state.status,
        }}
        getPlayheadFrame={() => playerRef.current?.getCurrentFrame() ?? 0}
      />
      <Toolbar
        projectName={projectName}
        home={open.status === 'idle'}
        active={session !== null}
        canUndo={session?.canUndo ?? false}
        canRedo={session?.canRedo ?? false}
        dirty={session?.dirty ?? false}
        saving={session?.saveStatus === 'saving'}
        onUndo={() => session?.undo()}
        onRedo={() => session?.redo()}
        onSave={() => void session?.save()}
        theme={theme}
        onToggleTheme={toggleTheme}
        layout={layout}
        onLayoutChange={changeLayout}
        workspaceMode={workspaceMode}
        onWorkspaceModeChange={changeWorkspaceMode}
        onGoHome={() => void handleGoHome()}
        onPreferences={() => { playerRef.current?.pause(); setAgentReviewTarget(null); setPreferencesOpen(true); }}
        onAgentActivity={openAgentActivity}
        ducking={session?.state.ducking ?? DEFAULT_DUCKING}
        onDuckingChange={(v) => {
          if (!session) return;
          session.apply(setDucking(session.state, v));
          saveDuckingSettings(v);
        }}
        waveformPref={waveformPref}
        onWaveformPrefChange={changeWaveformPref}
        autoSaveEnabled={autoSaveEnabled}
        onAutoSaveEnabledChange={setAutoSaveEnabled}
        renderState={render.state}
        onRenderStart={() => setExportDialogOpen(true)}
        onRenderCancel={() => {
          // 失敗を画面に出す（data-safety-11: 以前は握りつぶしていた）。
          void render.cancel().then((msg) => {
            if (msg !== null) showToast(msg, 'error');
          });
        }}
        onRenderReveal={() => {
          void render.reveal().then((msg) => {
            if (msg !== null) showToast(msg, 'error');
          });
        }}
        onRenderDismiss={render.reset}
        warnings={open.status === 'ready' && open.validation ? open.validation.warnings : []}
        stalePacks={stalePacks}
        packNotices={packNotices}
        packRevertable={packRevertable}
        onPackUpgrade={upgradePacksReq}
        onPackRevert={revertPacksReq}
        onPackUpgraded={(() => {
          const id = selectedId;
          return () => {
            if (id === null || !isCurrent(id)) return;
            void refetchPackStatus();
            // 更新リクエスト中に今のプロジェクトで編集が進み dirty になっていたら、黙って
            // remount して未保存編集を消さない（ExternalChangeBanner と同じ dirty 確認を足す）。
            if (!reloadIfSafe(id, sessionRef.current?.dirty ?? false)) {
              setPendingReload(true);
            } else {
              // 開き直せたなら、以前の着地で立てた再読込案内は用済み（マージレビュー Codex P2）。
              setPendingReload(false);
            }
          };
        })()}
        onShowTutorial={() => setHelpOpen(true)}
      />
      <div className="conv-banner-slot" ref={bannerSlotRef}>
        {/* H-3: 書き出し中の通知はツールバーから浮かせず、ここ（バナー枠）へ流し込む。
            浮かせると右ドックのタブ帯を覆い、2 つ同時に立つと互いを隠した。 */}
        <ExportNotices {...exportNoticeProps(render)} />
        {session?.saveClampNotice && (
          // C-2: 保存時クランプ（サブ動画の終了位置をソース実長へ自動調整）を無言にしない通知。
          <div className="tb-save-clamp-notice">
            {/* X-2(a): クランプ通知と「再生できる範囲が残っていない」警告が同時に出うるため
                改行区切りの各件を1件ずつ描く（片方が埋もれない）。
                H-3(e): 隙間なく積むと 2 件が地続きの1文に見えるため、件ごとに余白と
                区切り線を入れる（.tb-save-clamp-item）。 */}
            <div className="tb-save-clamp-list">
              {session.saveClampNotice.split('\n').map((line) => (
                <div className="tb-save-clamp-item" key={line}>{line}</div>
              ))}
            </div>
            <button type="button" onClick={session.dismissSaveClampNotice}>
              閉じる
            </button>
          </div>
        )}
        {open.status === 'ready' && open.videoLink !== null && open.videoLink.state !== 'ok' && (
          <VideoLinkBanner
            state={open.videoLink.state}
            target={open.videoLink.target}
            canKeepEditing={open.hasVideo}
            onRelink={() => setRelinkOpen(true)}
          />
        )}
        {open.status === 'ready' && baseProject && baseProject.cutDataSource === null && (
          <ConversionBanner
            converting={isConvertingSelected(converting, selectedId)}
            error={convertError}
            dirty={session?.dirty ?? false}
            onConvert={() => void handleConvert()}
          />
        )}
        {externallyChanged && (
          <ExternalChangeBanner
            dirty={session?.dirty ?? false}
            onReload={reloadProject}
            onSaveThenReload={() => void requestReload()}
            onDiscardReload={discardAndReload}
            conflict={showConflictInBanner}
            onOverwriteSave={() => {
              void session?.saveOverwrite().then((r) => {
                if (!r.ok) return;
                showToast(overwriteSavedToast(r.backupDir), 'success');
                setBackupNotice(r.backupDir);
                // 上書きが通った時点でディスクと画面は一致している。古い外部変更バナーを
                // 残したままにすると成功トーストと矛盾し、再読込（編集の破棄）を誘う。
                clearExternalChange();
              });
            }}
          />
        )}
        {backupNotice !== null && selectedId !== null && (
          <BackupNotice
            backupDir={backupNotice}
            onOpenFolder={() => {
              void revealProjectRequest(selectedId).catch((err: unknown) => {
                showToast(err instanceof Error ? err.message : '保存先を開けませんでした', 'error');
              });
            }}
            onDismiss={() => setBackupNotice(null)}
          />
        )}
        {!externallyChanged && pendingReload && (
          <ExternalChangeBanner
            title="更新の反映に再読込が必要です"
            dirty={session?.dirty ?? false}
            onReload={reloadProject}
            onSaveThenReload={() => void requestReload()}
            onDiscardReload={discardAndReload}
          />
        )}
        {session && shouldShowBgmInstallWarning(session.state.bgm.length, open.bgmInstalled) && (
          <BgmInstallBanner
            installing={installingKindFor(installing, selectedId) === 'bgm'}
            busy={installing !== null}
            dirty={session.dirty}
            error={installErrors.bgm ?? null}
            onInstall={() => void handleInstall('bgm')}
          />
        )}
        {session && shouldShowVideoInsertInstallWarning(session.state.videoInserts.length, open.videoInsertInstalled) && (
          <VideoInsertInstallBanner
            installing={installingKindFor(installing, selectedId) === 'videoInsert'}
            busy={installing !== null}
            dirty={session.dirty}
            error={installErrors.videoInsert ?? null}
            onInstall={() => void handleInstall('videoInsert')}
          />
        )}
      </div>
      <div className="stage">
        <LeftColumn
          tab={leftTab}
          onPickTab={setLeftTab}
          folderOpen={folderOpen}
          projects={projects}
          activeId={selectedId}
          projectsError={projectsError}
          onPickProject={(id) => void handlePickProject(id)}
          onToggleFolder={toggleFolder}
          onGoHome={() => void handleGoHome()}
          materialKind={materialKind}
          onPickMaterialKind={setMaterialKind}
          seLibrary={seLibrary}
          imageLibrary={imageLibrary}
          bgmLibrary={bgmLibrary}
          videoLibrary={videoLibrary}
          projectId={selectedId ?? ''}
          assetVersions={assetVersions}
          playingPath={audition.playingPath}
          onAudition={(url, volume) => audition.toggle(url, volume)}
          onAuditionStop={audition.stop}
          onInsert={insertMaterial}
          onDragStart={onMaterialDragStart}
          onDropFiles={open.status === 'ready' ? handleDropFiles : undefined}
          uploadStatus={uploadRemaining > 0 ? `アップロード中… 残り${uploadRemaining}件` : null}
          onDeleteMaterial={open.status === 'ready' ? handleDeleteMaterial : undefined}
          onOpenTrash={open.status === 'ready' ? () => setTrashOpen(true) : undefined}
        />
        <div className="estack">
          {open.status === 'idle' && (
            <HomeDashboardWithAgentBoard
              managedMedia
              projects={projects}
              error={projectsError}
              notice={initialProjectNotice}
              loading={projectsLoading}
              onPick={selectProject}
              onSetStage={handleSetStage}
              onCreate={handleCreateProject}
              onProjectsChanged={() => void refreshProjects()}
            />
          )}
          {open.status === 'loading' && (
            <div className="pv">
              <div className="sme-center">
                <div className="sme-spinner" />
                <p>読み込み中…</p>
              </div>
            </div>
          )}
          {open.status === 'error' && (
            <div className="pv">
              <div className="sme-center">
                <p className="sme-error">プロジェクトを開けませんでした</p>
                <p className="hint">{open.error}</p>
                <div className="preference-actions">
                  <button type="button" className="export-start" onClick={() => void requestReload()}>もう一度開く</button>
                  <button type="button" className="export-cancel" onClick={() => void handleGoHome()}>案件一覧へ戻る</button>
                </div>
              </div>
            </div>
          )}
          {open.status === 'ready' && model && baseProject && session && (
            <Preview
              key={selectedId}
              project={baseProject}
              showEditOverlay={workspaceMode !== 'edit'}
              ref={playerRef}
              model={model}
              hasVideo={open.hasVideo}
              projectId={selectedId ?? ''}
              seLibrary={open.seLibrary}
              imageLibrary={open.imageLibrary}
              videoLibrary={open.videoLibrary}
              bgmLibrary={open.bgmLibrary}
              assetVersions={assetVersions}
              state={session.state}
              onLive={session.setTransient}
              onEdit={session.apply}
              drawingKind={drawingKind}
              onDrawingKindChange={setDrawingKind}
              reloadKey={previewReloadKey}
              onReloadPreview={handleReloadPreview}
              playbackRate={playbackRate}
              cutsBypassed={previewCuts}
              snapPref={snapPref}
            />
          )}
        </div>
        {/* 右ドック: 文字起こし／設定／AI をタブで出し分ける（プレビューは中央の主役）。 */}
        {open.status === 'ready' && baseProject && session ? (
          <RightDock
            workspaceMode={workspaceMode}
            activeTab={activeTab}
            onPickTab={pickTab}
            open={claudeOpen}
            onToggleOpen={() => setClaudeOpen((v) => !v)}
            script={<ScriptPanel key={selectedId} projectId={selectedId ?? ''} session={session}
              adoption={{ bridge: commandBridge, onOpenActivity: () => setAgentActivityOpen(true),
                connectionReady: agentConnection.connection === 'connected' && agentConnection.readySnapshot?.projectId === selectedId
                  && agentConnection.readySnapshot?.revision === commandBridge.read()?.revision }}
              transcript={baseProject.transcript} previewVersion={open.videoVersion} projectStale={externallyChanged}
              onSeekSource={(milliseconds) => {
                playerRef.current?.pause();
                const frame = Math.max(0, Math.min(baseProject.videoConfig.durationFrames - 1, Math.round(milliseconds * fps / 1000)));
                if (previewCuts) playerRef.current?.seekTo(frame);
                else {
                  pendingCutViewSeekRef.current = { bypassed: true, originalFrame: frame };
                  setPreviewCuts(true);
                }
              }} />}
            transcript={
              <TranscriptPanel
                state={session.state}
                transcript={baseProject.transcript}
                fps={fps}
                transcriptAligned={isTranscriptAlignedWithVideo(
                  baseProject.transcript,
                  baseProject.videoConfig,
                )}
                projectId={selectedId ?? ''}
                cutsBypassed={previewCuts}
                onReloadRequested={() => void requestReload()}
                onEdit={session.apply}
                onSelect={session.setTransient}
                onSeek={(playbackFrame) =>
                  playerRef.current?.seekTo(
                    // 再生フレーム → プレイヤー（速度後）フレームへ変換。
                    model ? playbackToPlayer(playbackFrame, model) : playbackFrame,
                  )
                }
                highlightRange={highlightRange}
                onHighlightRange={setHighlightRange}
                denoiseApplied={open.status === 'ready' ? open.denoiseApplied : false}
                linkedVideo={open.status === 'ready' && open.videoLink !== null}
                playerRef={playerRef}
                model={model}
                previewReloadKey={previewReloadKey}
              />
            }
            settings={
              workspaceMode === 'edit' ? <EditingInspector state={session.state} fps={fps} model={finalModel ?? undefined} onEdit={session.apply}
                onFinish={() => changeWorkspaceMode('finish')}
                onFinishAudio={() => {
                  session.setTransient(prev => ({ ...prev, selection: { kind: 'mainVideo' }, multiTelopIds: [] }));
                  changeWorkspaceMode('finish');
                  setUserTab('settings');
                  setClaudeOpen(true);
                }} /> : <Inspector
                finalModel={finalModel ?? undefined}
                state={session.state}
                fps={fps}
                seLibrary={open.seLibrary}
                imageLibrary={open.imageLibrary}
                videoLibrary={open.videoLibrary}
                projectId={selectedId ?? ''}
                telopPackInstalled={open.telopPackInstalled}
                motionKeysSupport={open.motionKeysSupport}
                imageRendering={open.imageRendering}
                colorGradeSupported={open.colorGradeSupported}
                mainAudioSupported={open.mainAudioSupported}
                colorWheelsSupported={open.colorWheelsSupported ?? false}
                videoInsertInstalled={open.videoInsertInstalled}
                installing={installingKindFor(installing, selectedId)}
                installErrors={installErrors}
                dirty={session.dirty}
                componentRevision={open.componentRevision}
                previewWidth={baseProject.videoConfig.resolution.width}
                previewHeight={baseProject.videoConfig.resolution.height}
                bgmLibrary={open.bgmLibrary}
                bgmInstalled={open.bgmInstalled}
                onInstall={(kind) => void handleInstall(kind)}
                shapeInstalled={open.shapeInstalled}
                transitionInstalled={open.transitionInstalled}
                joins={model?.joins ?? []}
                keptSegments={model?.keptSegments ?? []}
                onLive={session.setTransient}
                onEdit={session.apply}
                playerRef={playerRef}
                assetVersions={assetVersions}
                onBack={backToTranscript}
              />
            }
            ai={
              <ClaudePanel
                projectId={selectedId}
                open={claudeOpen}
                onToggle={() => setClaudeOpen((v) => !v)}
                buildContext={buildContext}
                onOpenActivity={openAgentActivity}
                embedded
                // I-2: このノードは RightDock 側で activeTab==='ai' の時しか実際には
                // 描画されないため常に true 相当だが、明示しておく（下の一貫性のため）。
                showTerminal={open.status === 'ready' && activeTab === 'ai'}
              />
            }
          />
        ) : (
          <ClaudePanel
            projectId={selectedId}
            open={claudeOpen}
            onToggle={() => setClaudeOpen((v) => !v)}
            buildContext={buildContext}
            onOpenActivity={openAgentActivity}
            embedded
            // I-2: プロジェクト未選択（ホーム画面）・読込中・エラー時のフォールバック描画。
            // ここは open.status !== 'ready' の分岐なので常に false——AI の導入確認
            // （/api/ai/tools）すら、プロジェクトを開いて AI タブを選ぶまで呼ばない。
            showTerminal={open.status === 'ready' && activeTab === 'ai'}
          />
        )}
        <Timeline
          allowRangeCut={workspaceMode === 'edit'}
          view={timelineView}
          onViewChange={setTimelineView}
          finalDurationFrames={finalModel?.durationInFrames}
          finalPlaybackModel={finalModel ?? undefined}
          session={session}
          baseProject={baseProject}
          playerRef={playerRef}
          seLibrary={open.seLibrary}
          imageLibrary={open.status === 'ready' ? open.imageLibrary : []}
          videoLibrary={open.status === 'ready' ? open.videoLibrary : []}
          bgmLibrary={open.status === 'ready' ? open.bgmLibrary : []}
          videoUrl={videoUrl}
          projectId={selectedId ?? ''}
          assetVersions={assetVersions}
          highlightRange={highlightRange}
          onHighlightRange={setHighlightRange}
          onNotice={(m) => showToast(m, 'info')}
          dropApiRef={timelineDropRef}
          speedSegments={model?.speedSegments ?? null}
          cutsBypassed={previewCuts}
          onToggleCutsBypassed={(originalFrame = 0) => {
            const bypassed = !previewCuts;
            pendingCutViewSeekRef.current = { bypassed, originalFrame };
            setPreviewCuts(bypassed);
          }}
          waveformPref={waveformPref}
          playbackRate={playbackRate}
          onPlaybackRateChange={setPlaybackRate}
          snapPref={snapPref}
        />
        {subPanelOn && selectedSubtitle && baseProject && session && open.status === 'ready' && (
          <SubtitlePanel
            settings={
              <SettingsTab
                projectId={selectedId ?? ''}
                telop={selectedSubtitle}
                state={session.state}
                fps={fps}
                telopPackInstalled={open.telopPackInstalled}
                keyframesSupported={open.motionKeysSupport.telop}
                bgmInstalled={open.bgmInstalled}
                installing={installingKindFor(installing, selectedId)}
                installErrors={installErrors}
                dirty={session.dirty}
                componentRevision={open.componentRevision}
                previewWidth={baseProject.videoConfig.resolution.width}
                previewHeight={baseProject.videoConfig.resolution.height}
                onInstall={(kind) => void handleInstall(kind)}
                onEdit={session.apply}
              />
            }
          />
        )}
      </div>
      {session?.saveStatus === 'error' && session.saveError && !showConflictInBanner && (
        session.saveConflict ? (
          /*
           * 保存衝突（409）。同じプロジェクトを別の画面が開いていて、そちらが先に保存すると
           * ここへ来る。以前は「開き直してください」と出すだけで、開き直すと未保存の編集が
           * 消えた（2026-09-04 のデータ損失）。どちらを残すかを利用者が選べるようにする。
           */
          <div className="tb-save-error">
            <div>
              {'別の画面がこのプロジェクトを保存したため、保存できませんでした。どちらの内容を残すか選んでください。上書きしても、消える方の内容は案件フォルダ内に控えを取ります。'}
            </div>
            <div className="tb-save-error-actions">
              <button
                type="button"
                onClick={() => {
                  void session.saveOverwrite().then((r) => {
                    if (!r.ok) return;
                    showToast(overwriteSavedToast(r.backupDir), 'success');
                setBackupNotice(r.backupDir);
                    // 上書き成功＝ディスクと画面は一致。外部変更バナーも畳む。
                    clearExternalChange();
                  });
                }}
              >
                この画面の内容で上書き保存
              </button>
              <button type="button" onClick={reloadProject}>
                開き直す（この画面の編集は失われます）
              </button>
            </div>
          </div>
        ) : (
          /*
           * 409 以外の保存失敗（書込権限・容量・サーバ停止など）。以前は理由を 1 行出すだけで、
           * 自動保存が止まっていること（autoSave.ts: saveStatus !== 'idle' では発火しない）も
           * 再試行のしかたも画面に無かった（data-safety-12）。
           */
          <div className="tb-save-error">
            <div>保存に失敗しました: {session.saveError}</div>
            <div>{SAVE_ERROR_AUTOSAVE_NOTICE}</div>
            <div className="tb-save-error-actions">
              <button
                type="button"
                onClick={() => {
                  void session.save();
                }}
              >
                もう一度保存
              </button>
            </div>
          </div>
        )
      )}
      {ghost && (
        <div className="material-ghost" style={{ left: ghost.x + 12, top: ghost.y + 12 }}>
          {ghost.file}
        </div>
      )}
      {exportDialogOpen && baseProject && (
        <ExportDialog
          orientation={baseProject.videoConfig.orientation}
          width={baseProject.videoConfig.resolution.width}
          height={baseProject.videoConfig.resolution.height}
          fps={baseProject.videoConfig.fps}
          onStart={(options, predictedFastCut) => void handleRenderStart(options, predictedFastCut)}
          onClose={() => setExportDialogOpen(false)}
          fastCut={
            session !== null &&
            isCutsOnly({
              ...session.state,
              // M1c 以降: 書き出し開始 POST は常に現在の ducking 設定を同梱するため
              // （handleRenderStart）、native 側で処理でき 'ducking' 理由は立たない。
              bgmDucking: false,
            })
          }
          needsCapture={needsCapture}
          captureEngine={captureEngine}
        />
      )}
      {render.heavyJobConfirm.pendingConfirm && (
        <HeavyJobConfirmDialog
          running={render.heavyJobConfirm.pendingConfirm.running}
          onConfirm={render.heavyJobConfirm.confirm}
          onDismiss={render.heavyJobConfirm.dismiss}
        />
      )}
      {trashConfirm !== null && (
        <TrashConfirmDialog
          // 使用中警告（2段目）へ昇格したら再マウントさせる。props 更新だけだと
          // autoFocus が効き直さず、フォーカスが直前の「ゴミ箱へ移動」に残ったままになる。
          key={`${trashConfirm.file}:${trashConfirm.usedCount}:${String(trashConfirm.force)}`}
          name={trashConfirm.file}
          usedCount={trashConfirm.usedCount}
          mode="trash"
          busy={trashPending}
          onConfirm={confirmTrashMaterial}
          onCancel={() => setTrashConfirm(null)}
        />
      )}
      {trashOpen && selectedId !== null && (
        <TrashDialog
          projectId={selectedId}
          onClose={() => setTrashOpen(false)}
          // 全体 reload は編集中の未保存状態を捨てるため使わない。サーバが返す
          // ライブラリパッチで部分反映する（パッチが無い異常時のみ reload に退避）。
          onChanged={(libraries) => {
            if (libraries === null) reloadProject();
            else patchLibraries(libraries);
          }}
        />
      )}
      {statusToast !== null && (
        <div className={toastClassName(statusToast.kind)} role={toastRole(statusToast.kind)}>
          {statusToast.text}
        </div>
      )}
      {relinkOpen && selectedId !== null && (
        <MediaPicker
          title="接続先を選び直す"
          note="外付けドライブの名前やフォルダが変わった場合は、同じ動画をもう一度選んでください。"
          onCancel={() => setRelinkOpen(false)}
          onPick={(f) => {
            const id = selectedId;
            void relinkRequest(id, f.path, false)
              .then((res) => {
                if (res.warnings.length > 0) {
                  // 別素材に見える場合は張り替えず、確認してから force で再実行する。
                  setRelinkConfirm({ path: f.path, warnings: res.warnings });
                  return;
                }
                setRelinkOpen(false);
                if (isCurrent(id)) reloadProject();
              })
              .catch((err: unknown) => {
                showToast(err instanceof Error ? err.message : '接続先を変更できませんでした', 'error');
              });
          }}
        />
      )}
      {relinkConfirm !== null && selectedId !== null && (
        <div className="export-overlay" onClick={() => setRelinkConfirm(null)}>
          <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="export-head">別の動画に見えます</div>
            <ul className="vl-warn-list">
              {relinkConfirm.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
            <p className="hint">
              このまま繋ぐと、テロップやカットの位置がずれる可能性があります。
            </p>
            <div className="export-actions">
              <button type="button" className="export-cancel" onClick={() => setRelinkConfirm(null)}>
                やめる
              </button>
              <button
                type="button"
                className="export-start"
                onClick={() => {
                  const id = selectedId;
                  const path = relinkConfirm.path;
                  void relinkRequest(id, path, true)
                    .then(() => {
                      setRelinkConfirm(null);
                      setRelinkOpen(false);
                      if (isCurrent(id)) reloadProject();
                    })
                    .catch((err: unknown) => {
                      showToast(err instanceof Error ? err.message : '接続先を変更できませんでした', 'error');
                    });
                }}
              >
                それでも繋ぐ
              </button>
            </div>
          </div>
        </div>
      )}
      <TutorialOverlay tutorial={tutorial} />
      {agentActivityOpen && <AgentActivityDialog projectId={selectedId} credentials={agentConnection.credentials}
        connection={agentConnection.connection} connectionError={agentConnection.error ?? agentConnection.transportError} onClose={() => setAgentActivityOpen(false)}
        onReview={session ? (target) => { setAgentReviewTarget(target); setAgentActivityOpen(false); setPreferencesOpen(true); } : undefined} />}
      {preferencesOpen && session && selectedId && <PreferenceDialog key={selectedId} projectId={selectedId}
        projectName={projectName ?? 'この動画'}
        selectedElementId={session.state.selection?.kind === 'telop' ? String(session.state.selection.id) : null}
        getTarget={preferenceBridge.target} onApply={preferenceBridge.apply} initialReview={agentReviewTarget}
        onClose={() => { setPreferencesOpen(false); if (agentReviewTarget) setAgentActivityOpen(true); setAgentReviewTarget(null); }} />}
      {helpOpen && (
        <HelpModal onClose={() => setHelpOpen(false)} onRestartTutorial={restartTutorialFromHelp} />
      )}
    </div>
  );
}
