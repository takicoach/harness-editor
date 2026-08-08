import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { PlayerRef } from '@remotion/player';
import { useEditorProject } from './useEditorProject';
import { useProjectsWatch } from './useProjectsWatch';
import { useEventBusProjectId } from './eventBus';
import { useEditSession } from './useEditSession';
import { useUnsavedGuard } from './useUnsavedGuard';
import { useAutoSave } from './useAutoSave';
import { loadAutoSaveEnabled, saveAutoSaveEnabled, hasExplicitAutoSavePref } from './layout/autoSavePref';
import { AUTO_SAVE_DELAY_MS, parseAutoSaveDelayOverride } from './edit/autoSave';
import { useRenderJob } from './useRenderJob';
import { useLearningDiff } from './useLearningDiff';
import { DiffReviewPanel, DiffReviewDone } from './panels/DiffReviewPanel';

import { useTheme } from './layout/useTheme';
import { toEditorProject } from './edit/editState';
import { buildPlaybackModel } from '../preview/playbackModel';
import { orientationCode } from '../shared/orientation';
import { LARGE_UPLOAD_NOTICE_BYTES } from '../shared/uploadNotice';
import { isTranscriptAlignedWithVideo } from '../core/transcript';
import { ConversionBanner } from './panels/ConversionBanner';
import { ExternalChangeBanner } from './panels/ExternalChangeBanner';
import { BgmInstallBanner, shouldShowBgmInstallWarning } from './panels/BgmInstallBanner';
import { VideoInsertInstallBanner, shouldShowVideoInsertInstallWarning } from './panels/VideoInsertInstallBanner';
import { usePackStatus } from './usePackStatus';
import { useVideoDurations } from './useVideoDurations';
import { Toolbar } from './panels/Toolbar';
import { ExportDialog } from './panels/ExportDialog';
import { isCutsOnly } from '../shared/cutsOnly';
import { HeavyJobConfirmDialog } from './panels/HeavyJobConfirmDialog';
import type { RenderOptions } from '../shared/renderPreset';
import { LeftColumn, type LeftTab } from './panels/LeftColumn';
import type { DrawingKind } from './preview/PreviewOverlay';
import { applyInsertMaterial } from './edit/insertMaterial';
import { classifyUploadKind, uploadMaterial } from './uploadMaterial';
import { createProjectRequest } from './createProjectApi';
import { createProjectLinkRequest, relinkRequest } from './browseApi';
import type { CreateSource } from './panels/HomeDashboard';
import { MediaPicker } from './panels/MediaPicker';
import { VideoLinkBanner } from './panels/VideoLinkBanner';
import { useAudition } from './audio/useAudition';
import type { MaterialKind } from './panels/materialList';
import { playbackToOriginal } from '../core/cutEngine';
import { playbackToPlayer, playerToPlayback } from '../preview/speedBridge';
import { nextReloadKey, withReloadBust } from '../shared/previewReload';
import type { TimelineDropApi } from './panels/Timeline';
import { Preview } from './panels/Preview';
import { HomeDashboard } from './panels/HomeDashboard';
import { putJsonPost } from './fetchJson';
import type { ProjectStage } from '../server/projectStatus';
import { TranscriptPanel } from './panels/TranscriptPanel';
import { Inspector, SettingsTab } from './panels/Inspector';
import { RightDock } from './panels/RightDock';
import { SubtitlePanel } from './panels/SubtitlePanel';
import { tabForSelection, type DockTab } from './dockTab';
import { loadLayout, saveLayout, showsSubtitlePanel, type LayoutPreset } from './layout/layoutPreset';
import { loadFolderOpen, saveFolderOpen } from './layout/folderOpenPref';
import { loadWaveformPref, saveWaveformPref, type WaveformPref } from './layout/waveformPref';
import { Timeline } from './panels/Timeline';
import { ClaudePanel } from './panels/ClaudePanel';
import type { InstructionContext } from '../shared/types';
import { setDucking } from './edit/duckingOps';
import { DEFAULT_DUCKING, saveDuckingSettings } from './edit/duckingSettings';
import { INSTALL_APIS, type InstallKind, type InstallErrors } from './install';
import { useTutorial } from './tutorial/useTutorial';
import { TutorialOverlay } from './tutorial/TutorialOverlay';
import { HelpModal } from './help/HelpModal';

/**
 * dirty/save 結果から render を開始してよいかを判定する（純関数・テスト容易性のため分離）。
 * dirty でなければ保存不要のため常に true。dirty なら save() の戻り値（成否）に従う。
 */
export function shouldProceedToRender(dirty: boolean, saveOk: boolean): boolean {
  return !dirty || saveOk;
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

export function App() {
  const { projects, projectsError, selectedId, open, selectProject, goHome, externallyChanged, reload, isCurrent, patchProject, refreshProjects, patchLibraries } =
    useEditorProject();
  // SSE 1 本統合（/api/events）: 選択中プロジェクトが変わったらバスの接続先を張り替える。
  useEventBusProjectId(selectedId ?? '');
  // ステータス書き込み失敗時のトースト（自動消滅）。
  const [statusToast, setStatusToast] = useState<string | null>(null);
  useEffect(() => {
    if (statusToast === null) return;
    const t = setTimeout(() => setStatusToast(null), 4000);
    return () => clearTimeout(t);
  }, [statusToast]);

  /** カードのバッジメニューから手動 stage を変更する（楽観更新→確定 refetch、失敗時は巻き戻し＋トースト）。 */
  const handleSetStage = useCallback(
    (id: string, stage: ProjectStage) => {
      const prev = projects.find((p) => p.id === id);
      // review/published は即バッジへ反映（自動判定に戻す場合はクライアントで解決できないため refetch に委ねる）。
      if (stage === 'review' || stage === 'published') patchProject(id, { status: stage });
      void putJsonPost('/api/project/status', { id, stage })
        .then(() => refreshProjects())
        .catch((err: unknown) => {
          // status フィールドのみ巻き戻す（prev を丸ごと書き戻すと、取得後に SSE 等で
          // 変化した他フィールド — activityLabel/lastEditedAt 等 — まで巻き戻ってしまうため）。
          if (prev) patchProject(id, { status: prev.status });
          setStatusToast(err instanceof Error ? err.message : 'ステータスの更新に失敗しました');
        });
    },
    [projects, patchProject, refreshProjects],
  );
  // ステータスのライブ更新を常時購読する（ホーム画面のバッジと、編集中も見える
  // 左サイドバーの「AI 作業中」表示の両方が対象。SSE 1 本＋差分パッチのみで軽量）。
  // onOpen（再接続成功時）に refreshProjects で取りこぼしイベントを埋め合わせる。
  useProjectsWatch(true, patchProject, refreshProjects);
  const { stalePacks, refetch: refetchPackStatus, upgrade: upgradePacksReq } = usePackStatus(selectedId);
  const { theme, toggle: toggleTheme } = useTheme();
  // サイドバーの開閉はユーザーの選択として永続する（閉じて作業する人の選択を毎回リセットしない）。
  const [folderOpen, setFolderOpen] = useState(() => loadFolderOpen());
  const toggleFolder = useCallback(() => {
    setFolderOpen((v) => {
      saveFolderOpen(!v);
      return !v;
    });
  }, []);
  const [claudeOpen, setClaudeOpen] = useState(true);
  const [userTab, setUserTab] = useState<DockTab>('transcript');
  const [layout, setLayout] = useState<LayoutPreset>(() => loadLayout());
  function changeLayout(v: LayoutPreset): void {
    setLayout(v);
    saveLayout(v);
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
    if (notices.length > 0) setStatusToast(notices.join(' / '));
    if (jobs.length === 0) return;
    setUploadRemaining((n) => n + jobs.length);
    void (async () => {
      for (const job of jobs) {
        try {
          const res = await uploadMaterial(selectedId, job.kind, job.file);
          if (!isCurrent(selectedId)) return;
          patchLibraries(res);
        } catch (err) {
          setStatusToast(err instanceof Error ? err.message : 'アップロードに失敗しました');
        } finally {
          setUploadRemaining((n) => Math.max(0, n - 1));
        }
      }
      // 最初のファイルの種別タブへ切り替えて、追加された素材がすぐ見えるようにする。
      const first = jobs[0];
      if (first && isCurrent(selectedId)) setMaterialKind(first.kind);
    })();
  }, [selectedId, materialKind, isCurrent, patchLibraries]);

  // ホームの「動画を作成する」。作成 API → 一覧更新 → そのまま新規プロジェクトを開く。
  // 素材は2経路: アップロード（実体をコピー）と、外部実体への symlink（コピーしない）。
  const handleCreateProject = useCallback(async (name: string, source: CreateSource) => {
    const { id } = source.kind === 'upload'
      ? await createProjectRequest(name, source.file)
      : await createProjectLinkRequest(name, source.path);
    await refreshProjects();
    selectProject(id);
  }, [refreshProjects, selectProject]);

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
  const session = useEditSession(selectedId, baseProject, saveMeta);
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
      .catch(() => {});
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
    const saveOk = session && dirty ? await session.save() : true;
    if (!shouldProceedToRender(dirty, saveOk)) return;
    goHome();
    // 編集・書き出しでステータスが変わっている可能性があるためホーム一覧を更新する。
    void refreshProjects().catch(() => {});
  }, [session, goHome, refreshProjects]);

  // 書き出し（render）ジョブ。プロジェクト未選択時は空文字（フック側で no-op）。
  const render = useRenderJob(selectedId ?? '');
  // 学習ループ: 書き出し完了時に AI との差分をレビューする。
  const learningDiff = useLearningDiff();

  // 書き出しが running → done へ遷移したエッジで 1 回だけ差分レビューを開く。
  // useRef で前回 status を保持し、同一 done の再レンダーでは再発火させない。
  const prevRenderStatusRef = useRef(render.state.status);
  useEffect(() => {
    const prev = prevRenderStatusRef.current;
    const now = render.state.status;
    prevRenderStatusRef.current = now;
    if (prev === 'running' && now === 'done' && selectedId) {
      learningDiff.open(selectedId);
    }
  }, [render.state.status, selectedId, learningDiff]);
  // 書き出しボタン → プリセット選択ダイアログ → 開始。
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  // 書き出し開始: 未保存があれば先に自動保存（A案）。保存失敗時は開始しない
  // （既存の tb-save-error 表示に委ねる）。
  const handleRenderStart = async (options: RenderOptions) => {
    setExportDialogOpen(false);
    const dirty = session?.dirty ?? false;
    const saveOk = session && dirty ? await session.save() : true;
    if (!shouldProceedToRender(dirty, saveOk)) return; // 保存できなければ書き出さない（既存の保存エラー表示に任せる）
    await render.start(options);
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

  // プロジェクトを切り替えたら前プロジェクトの変換/導入エラー表示を消す。
  useEffect(() => {
    setConvertError(null);
    setInstallErrors({});
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
        selectProject(id);
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
      if (isCurrent(id)) selectProject(id);
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
    // ホーム（プロジェクト未選択）はカンバンボード専用モード。
    // タイムライン行と右ドック列を CSS で消し、ボードを全幅・全高にする。
    root.setAttribute('data-home', open.status === 'idle' ? 'on' : 'off');
  }, [orientation, folderOpen, claudeOpen, layout, open.status]);

  // カット確認モード。ON の間はカットを適用せず原本全体を再生できる（長いカット区間の中身確認用）。
  // 場面転換・速度も外し、プレイヤーフレーム＝再生フレーム＝原本フレームの恒等にして座標変換を単純化する。
  const [previewCuts, setPreviewCuts] = useState(false);

  // プレビューモデルは編集状態から都度合成する（編集が即プレビュー反映される）。
  const model = useMemo(() => {
    if (!baseProject || !session) return null;
    const proj = toEditorProject(session.state, baseProject);
    if (!previewCuts) return buildPlaybackModel(proj);
    return buildPlaybackModel({
      ...proj,
      cutRegions: [],
      sceneTransitions: [],
      mainSpeed: 1,
      segmentSpeeds: {},
    });
  }, [baseProject, session, previewCuts]);

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
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target?.isContentEditable ?? false);

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
    const auto = session ? tabForSelection(session.state) : null;
    if (auto) {
      setUserTab(auto);
      activeTab = auto;
    }
  }
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
  const subPanelOn = session ? showsSubtitlePanel(session.state, layout) : false;
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
  // サブ動画素材の実フレーム長（file → frames）。区間を素材内へクランプするために使う。
  // 読めなかった素材はキーごと載らない＝クランプしない（従来挙動）。
  const videoDurations = useVideoDurations(selectedId ?? '', videoLibrary, fps, assetVersions);

  // ツールバーの警告バッジに出す一覧。サーバ側の検証警告に加えて、
  // 「導入済みなのにサブ動画部品を読み込めなかった」をクライアント側の警告として合流させる
  // （このケースはプレビューを同梱部品で代替しない＝黙って乖離させないため、警告が唯一の手掛かり）。
  const projectWarnings =
    open.status === 'ready'
      ? [
          ...(open.validation ? open.validation.warnings : []),
          ...(open.insertVideoError !== null ? [open.insertVideoError] : []),
        ]
      : [];

  // クリック挿入: 再生ヘッド（プレイバック）→原本フレームへ変換して挿入。
  function insertMaterial(kind: MaterialKind, file: string): void {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!session) return;
    // Player の現在フレームは速度後座標。playerToPlayback で再生座標へ戻してから原本へ。
    const pf = playerRef.current?.getCurrentFrame() ?? 0;
    const orig = playbackToOriginal(
      model ? playerToPlayback(pf, model) : pf,
      previewCuts ? [] : session.state.cutRegions,
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
  const restartTutorialFromHelp = useCallback(() => {
    setHelpOpen(false);
    tutorial.start();
  }, [tutorial]);

  return (
    <div className="app">
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
        onRenderCancel={() => void render.cancel()}
        onRenderReveal={() => void render.reveal()}
        renderRevealError={render.revealError}
        onRenderDismiss={render.reset}
        warnings={projectWarnings}
        stalePacks={stalePacks}
        onPackUpgrade={upgradePacksReq}
        onPackUpgraded={(() => { const id = selectedId; return () => { if (id !== null && isCurrent(id)) { reload(); void refetchPackStatus(); } }; })()}
        onShowTutorial={() => setHelpOpen(true)}
      />
      <div className="conv-banner-slot">
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
            onConvert={() => void handleConvert()}
          />
        )}
        {externallyChanged && (
          <ExternalChangeBanner
            dirty={session?.dirty ?? false}
            onReload={reload}
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
          onPickProject={selectProject}
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
        />
        <div className="estack">
          {open.status === 'idle' && (
            <HomeDashboard
              projects={projects}
              error={projectsError}
              onPick={selectProject}
              onSetStage={handleSetStage}
              onCreate={handleCreateProject}
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
              </div>
            </div>
          )}
          {open.status === 'ready' && model && open.telop && session && (
            <Preview
              ref={playerRef}
              model={model}
              telop={open.telop}
              insertImage={open.insertImage}
              insertVideo={open.insertVideo}
              /* 未導入のときだけ同梱部品で代替描画する（導入済み×読込失敗は描かず警告に載せる）。 */
              allowInsertVideoFallback={!open.videoInsertInstalled}
              videoUrl={videoUrl}
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
            />
          )}
        </div>
        {/* 右ドック: 文字起こし／設定／AI をタブで出し分ける（プレビューは中央の主役）。 */}
        {open.status === 'ready' && baseProject && session ? (
          <RightDock
            activeTab={activeTab}
            onPickTab={pickTab}
            open={claudeOpen}
            onToggleOpen={() => setClaudeOpen((v) => !v)}
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
                onReloadRequested={reload}
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
              <Inspector
                state={session.state}
                fps={fps}
                seLibrary={open.seLibrary}
                imageLibrary={open.imageLibrary}
                videoLibrary={open.videoLibrary}
                videoDurations={videoDurations}
                projectId={selectedId ?? ''}
                telopPackInstalled={open.telopPackInstalled}
                videoInsertInstalled={open.videoInsertInstalled}
                installing={installingKindFor(installing, selectedId)}
                installErrors={installErrors}
                dirty={session.dirty}
                telopComponent={open.telop}
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
            embedded
            // I-2: プロジェクト未選択（ホーム画面）・読込中・エラー時のフォールバック描画。
            // ここは open.status !== 'ready' の分岐なので常に false——AI の導入確認
            // （/api/ai/tools）すら、プロジェクトを開いて AI タブを選ぶまで呼ばない。
            showTerminal={open.status === 'ready' && activeTab === 'ai'}
          />
        )}
        <Timeline
        session={session}
        baseProject={baseProject}
        playerRef={playerRef}
        seLibrary={open.seLibrary}
        imageLibrary={open.status === 'ready' ? open.imageLibrary : []}
        videoLibrary={open.status === 'ready' ? open.videoLibrary : []}
        videoDurations={videoDurations}
        bgmLibrary={open.status === 'ready' ? open.bgmLibrary : []}
        videoUrl={videoUrl}
        projectId={selectedId ?? ''}
        assetVersions={assetVersions}
        highlightRange={highlightRange}
        onHighlightRange={setHighlightRange}
        dropApiRef={timelineDropRef}
        speedSegments={model?.speedSegments ?? null}
        cutsBypassed={previewCuts}
        onToggleCutsBypassed={() => setPreviewCuts((v) => !v)}
        waveformPref={waveformPref}
        playbackRate={playbackRate}
        onPlaybackRateChange={setPlaybackRate}
        />
        {subPanelOn && selectedSubtitle && baseProject && session && open.status === 'ready' && (
          <SubtitlePanel
            settings={
              <SettingsTab
                telop={selectedSubtitle}
                state={session.state}
                fps={fps}
                telopPackInstalled={open.telopPackInstalled}
                videoInsertInstalled={open.videoInsertInstalled}
                bgmInstalled={open.bgmInstalled}
                installing={installingKindFor(installing, selectedId)}
                installErrors={installErrors}
                dirty={session.dirty}
                telopComponent={open.telop}
                previewWidth={baseProject.videoConfig.resolution.width}
                previewHeight={baseProject.videoConfig.resolution.height}
                onInstall={(kind) => void handleInstall(kind)}
                onEdit={session.apply}
              />
            }
          />
        )}
      </div>
      {session?.saveStatus === 'error' && session.saveError && (
        <div className="tb-save-error">保存に失敗しました: {session.saveError}</div>
      )}
      {ghost && (
        <div className="material-ghost" style={{ left: ghost.x + 12, top: ghost.y + 12 }}>
          {ghost.file}
        </div>
      )}
      {(learningDiff.state.status === 'review' || learningDiff.state.status === 'submitting') && (
        <DiffReviewPanel
          diff={learningDiff.state.diff}
          submitting={learningDiff.state.status === 'submitting'}
          onApprove={(cut, words, telops, ses) => {
            if (selectedId) learningDiff.approve(selectedId, cut, words, telops, ses);
          }}
          onDismiss={learningDiff.dismiss}
        />
      )}
      {learningDiff.state.status === 'done' && (
        <DiffReviewDone
          result={learningDiff.state.result}
          recordedCount={learningDiff.state.recordedCount}
          onClose={learningDiff.dismiss}
        />
      )}
      {exportDialogOpen && baseProject && (
        <ExportDialog
          orientation={baseProject.videoConfig.orientation}
          width={baseProject.videoConfig.resolution.width}
          height={baseProject.videoConfig.resolution.height}
          onStart={(options) => void handleRenderStart(options)}
          onClose={() => setExportDialogOpen(false)}
          fastCut={session !== null && isCutsOnly(session.state)}
        />
      )}
      {render.heavyJobConfirm.pendingConfirm && (
        <HeavyJobConfirmDialog
          running={render.heavyJobConfirm.pendingConfirm.running}
          onConfirm={render.heavyJobConfirm.confirm}
          onDismiss={render.heavyJobConfirm.dismiss}
        />
      )}
      {statusToast !== null && (
        <div className="sme-toast" role="alert">
          {statusToast}
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
                if (isCurrent(id)) reload();
              })
              .catch((err: unknown) => {
                setStatusToast(err instanceof Error ? err.message : '接続先を変更できませんでした');
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
                      if (isCurrent(id)) reload();
                    })
                    .catch((err: unknown) => {
                      setStatusToast(err instanceof Error ? err.message : '接続先を変更できませんでした');
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
      {helpOpen && (
        <HelpModal onClose={() => setHelpOpen(false)} onRestartTutorial={restartTutorialFromHelp} />
      )}
    </div>
  );
}
