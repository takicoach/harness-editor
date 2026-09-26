import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorProject, ValidationResult } from '../core/types';
import type { ProjectSummary, ProjectFingerprint } from '../shared/types';
import { fetchJson } from './fetchJson';
import type { NativeTelopRevision } from '../preview/nativeTelopCache';
import { useProjectWatch } from './useProjectWatch';
import { mergeProjectSummaries, applyStatusPatch, type ProjectListEntry } from './projectSummaries';
export { mergeProjectSummaries, applyStatusPatch, type ProjectListEntry } from './projectSummaries';

interface ProjectsResponse {
  root: string;
  projects: ProjectSummary[];
}
interface SaveMeta {
  telopDataRelPath: string;
  cutDataRelPath: string;
  fingerprint: ProjectFingerprint;
}
interface ProjectResponse {
  project: EditorProject;
  validation: ValidationResult;
  save: SaveMeta;
  hasVideo: boolean;
  /** 原本（リンク先の実体）が読めるか。false なら書き出し・波形再生成はできない。 */
  sourceAvailable: boolean;
  /** 外部実体への symlink 取り込みの状態。通常のコピー取り込みなら null。 */
  videoLink: { target: string; state: 'ok' | 'broken' | 'mismatch' } | null;
  videoVersion: string | null;
  seLibrary: string[];
  imageLibrary: string[];
  telopPackInstalled: boolean;
  videoLibrary: string[];
  videoInsertInstalled: boolean;
  bgmLibrary: string[];
  assetVersions: Record<string, string>;
  bgmInstalled: boolean;
  transitionInstalled: boolean;
  shapeInstalled: boolean;
  denoiseApplied: boolean;
  /** キーフレームが書き出しへ反映されるか（部品の版で決まる・F-1）。 */
  motionKeysSupport: { telop: boolean; image: boolean };
  /** カラー補正が書き出しへ反映されるか（部品の版と配線で決まる・F-2）。 */
  colorGradeSupported: boolean;
  colorWheelsSupported?: boolean;
  mainAudioSupported?: boolean;
  imageRendering?: { supported: boolean; canUpgrade: boolean };
}

/** 選択中プロジェクトの読込状態。 */
export interface OpenState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  project: EditorProject | null;
  validation: ValidationResult | null;
  save: SaveMeta | null;
  /** Internal load identity; never part of the editable project or save payload. */
  componentRevision: NativeTelopRevision | null;
  hasVideo: boolean;
  /** 原本（リンク先の実体）が読めるか。false なら書き出し・波形再生成はできない。 */
  sourceAvailable: boolean;
  /** 外部実体への symlink 取り込みの状態。通常のコピー取り込みなら null。 */
  videoLink: { target: string; state: 'ok' | 'broken' | 'mismatch' } | null;
  videoVersion: string | null;
  seLibrary: string[];
  imageLibrary: string[];
  telopPackInstalled: boolean;
  videoLibrary: string[];
  videoInsertInstalled: boolean;
  bgmLibrary: string[];
  /** ライブラリ各ファイルの size-mtime トークン（assetPath キー）。asset URL の &v= 用。 */
  assetVersions: Record<string, string>;
  bgmInstalled: boolean;
  transitionInstalled: boolean;
  shapeInstalled: boolean;
  /** denoise.json marker が applied=true か（ノイズ除去適用済み判定）。 */
  denoiseApplied: boolean;
  /** キーフレームが書き出しへ反映されるか（部品の版で決まる・F-1）。 */
  motionKeysSupport: { telop: boolean; image: boolean };
  /** カラー補正が書き出しへ反映されるか（部品の版と配線で決まる・F-2）。 */
  colorGradeSupported: boolean;
  colorWheelsSupported?: boolean;
  mainAudioSupported?: boolean;
  imageRendering?: { supported: boolean; canUpgrade: boolean };
  error: string | null;
}

const IDLE: OpenState = {
  status: 'idle', project: null, validation: null, save: null, componentRevision: null,
  hasVideo: false, sourceAvailable: false, videoLink: null, videoVersion: null, seLibrary: [], imageLibrary: [], telopPackInstalled: false,
  videoLibrary: [], videoInsertInstalled: false,
  bgmLibrary: [], assetVersions: {}, bgmInstalled: false, transitionInstalled: false, shapeInstalled: false, denoiseApplied: false,
  motionKeysSupport: { telop: false, image: false }, colorGradeSupported: false, error: null,
};

export interface EditorProjectState {
  projects: ProjectSummary[];
  /**
   * `/api/projects` の初回取得が終わっていないか（status-ia-1）。
   * 取得中も projects は [] のため、これが true の間にホームが
   * 「まだプロジェクトがありません」という嘘の空状態を出さないようにする。
   */
  projectsLoading: boolean;
  projectsError: string | null;
  /** 初回URLが一覧外だった場合のホーム向け案内。取得失敗とは分ける。 */
  initialProjectNotice: string | null;
  selectedId: string | null;
  open: OpenState;
  selectProject: (id: string) => void;
  /** プロジェクトを閉じてホーム（未選択状態）へ戻る。 */
  goHome: () => void;
  externallyChanged: boolean;
  reload: () => void;
  /**
   * 外部変更バナーだけを畳む（再読込しない）。上書き保存が成功した時点で
   * ディスクと画面は一致しているので、再読込を促し続けない。
   */
  clearExternalChange: () => void;
  /** 今もそのプロジェクトを見ているか（in-flight fetch の settle 時ガード用）。 */
  isCurrent: (id: string) => boolean;
  /**
   * 非同期処理（導入・部品更新など）の着地時に、今のプロジェクトを安全に開き直せるかを判定し、
   * 安全なら実際に reload する。false を返した呼び出し元は、切替済みなら黙って何もせず、
   * 今のプロジェクトのまま dirty（未保存編集あり）なら黙って reload せずユーザーに確認を求めること
   * （ExternalChangeBanner と同じ「dirty なら黙って捨てない」規律を handleConvert 以外の着地点へ広げる）。
   */
  reloadIfSafe: (id: string, dirty: boolean) => boolean;
  /**
   * 一覧の 1 プロジェクトを部分更新する（ステータス変更の楽観的反映・巻き戻し用）。
   * 該当 id が無ければ何もしない。後続の SSE ライブ更新もこの関数を経由する想定。
   */
  patchProject: (id: string, patch: Partial<ProjectSummary>) => void;
  /** 一覧全体を新しい要約で置き換える（ステータス確定時の再取得結果反映用）。 */
  setProjectSummaries: (next: ProjectSummary[]) => void;
  /** `/api/projects` を再取得して一覧を更新する（ステータス変更後の確定反映用）。 */
  refreshProjects: () => Promise<void>;
  /**
   * 素材ライブラリ一覧＋assetVersions だけを差し替える（素材アップロード後の反映用）。
   * プロジェクト全体を reload すると編集中の状態が失われるため、部分パッチにする。
   */
  patchLibraries: (libs: Pick<OpenState, 'seLibrary' | 'imageLibrary' | 'bgmLibrary' | 'videoLibrary' | 'assetVersions'>) => void;
}

/** プロジェクト一覧の取得、選択、データの読込と成功した読込の識別を管理する。 */
export function useEditorProject(): EditorProjectState {
  const [projects, setProjects] = useState<ProjectListEntry[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [initialProjectNotice, setInitialProjectNotice] = useState<string | null>(null);
  // 初回の一覧取得が終わるまで true（status-ia-1）。
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenState>(IDLE);
  const initialProjectHandledRef = useRef(false);

  /**
   * 一覧の**全置換**（`/api/projects` の応答）と、SSE 由来の**部分パッチ**は、
   * どちらも「サーバがディスクを見た結果」であり、届く順番は入れ替わる。
   * どちらが新しいかは到着順から**推測しない** — サーバが観測ごとに振る単調増加の番号
   * （`statusSeq`）で決める。取り込みの規則は `mergeProjectSummaries` /
   * `applyStatusPatch`（どちらも純関数・単体テスト済み）に集約する。
   *
   * 以前は「応答待ちの間に来たパッチを記録して着地時に再適用する」方式だったが、
   * これは「パッチは常にスナップショットより新しい」という**順序の仮定**に依存しており、
   * 仮定が崩れる interleaving（応答待ちの間に始まった別の再取得・遅れて届いた古い差分）で
   * 巻き戻りが残っていた。番号による判定にはその仮定が要らない。
   */
  const fetchProjectList = useCallback(
    async (onError?: (err: unknown) => void): Promise<void> => {
      try {
        const data = await fetchJson<ProjectsResponse>('/api/projects');
        setProjects((prev) => mergeProjectSummaries(prev, data.projects));
      } catch (err) {
        if (onError === undefined) throw err;
        onError(err);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void fetchProjectList((err: unknown) => {
      if (cancelled) return;
      setProjectsError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      // 一覧の取得が終わったら（成功・失敗とも）読込中を解く（status-ia-1）。
      if (cancelled) return;
      setProjectsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchProjectList]);

  const patchProject = useCallback((id: string, patch: Partial<ProjectSummary>) => {
    setProjects((prev) => applyStatusPatch(prev, id, patch));
  }, []);

  const setProjectSummaries = useCallback((next: ProjectSummary[]) => {
    // 外から渡された一覧も観測の新旧で取り込む（到着順で上書きしない）。
    setProjects((prev) => mergeProjectSummaries(prev, next));
  }, []);

  const refreshProjects = useCallback(async () => {
    await fetchProjectList();
  }, [fetchProjectList]);

  const patchLibraries = useCallback(
    (libs: Pick<OpenState, 'seLibrary' | 'imageLibrary' | 'bgmLibrary' | 'videoLibrary' | 'assetVersions'>) => {
      setOpen((prev) => (prev.status === 'ready' ? { ...prev, ...libs } : prev));
    },
    [],
  );

  // 直前の読込を無効化するための関数を保持する。プロジェクトを素早く切り替えた
  // とき、遅い前の読込が後から ready を上書きする out-of-order を防ぐ。
  const cancelLoadRef = useRef<(() => void) | null>(null);

  // in-flight の非同期処理が settle した時に「まだ同じプロジェクトを見ているか」の判定鏡。
  // setSelectedId と同期的に更新する（selectProject 内で直接代入）ため effect の窓が無い。
  const selectedIdRef = useRef<string | null>(null);
  const isCurrent = useCallback((id: string) => selectedIdRef.current === id, []);

  const selectProject = useCallback((id: string) => {
    cancelLoadRef.current?.();

    selectedIdRef.current = id;
    setSelectedId(id);
    setOpen({ ...IDLE, status: 'loading' });

    let cancelled = false;
    cancelLoadRef.current = () => {
      cancelled = true;
    };

    (async () => {
      const { project, validation, save, hasVideo, sourceAvailable, videoLink, videoVersion, seLibrary, imageLibrary, telopPackInstalled, videoLibrary, videoInsertInstalled, bgmLibrary, assetVersions, bgmInstalled, transitionInstalled, shapeInstalled, denoiseApplied, motionKeysSupport, colorGradeSupported, colorWheelsSupported, mainAudioSupported, imageRendering } =
        await fetchJson<ProjectResponse>(`/api/project?id=${encodeURIComponent(id)}`);
      if (cancelled) return;
      setOpen({
        status: 'ready', project, validation, save,
        componentRevision: Object.freeze({ token: Symbol(id) }),
        hasVideo, sourceAvailable, videoLink, videoVersion, seLibrary, imageLibrary, telopPackInstalled,
        videoLibrary, videoInsertInstalled,
        bgmLibrary, assetVersions, bgmInstalled, transitionInstalled, shapeInstalled, denoiseApplied,
        motionKeysSupport: motionKeysSupport ?? { telop: false, image: false },
        // 旧サーバ応答（フィールド無し）は fail-closed（＝注意書きを出す側）へ倒す。
        colorGradeSupported: colorGradeSupported ?? false,
        colorWheelsSupported: colorWheelsSupported ?? false,
        mainAudioSupported: mainAudioSupported ?? false,
        imageRendering: imageRendering ?? { supported: false, canUpgrade: false },
        error: null,
      });
    })().catch((err: unknown) => {
      if (cancelled) return;
      setOpen({
        ...IDLE,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, []);

  // A deep link is a one-time initial selection. It may only name a project returned by the real catalog;
  // going Home later must not reopen it, and an unknown ID must not trigger a project request.
  useEffect(() => {
    if (projectsLoading || projectsError !== null || initialProjectHandledRef.current) return;
    initialProjectHandledRef.current = true;
    const requested = new URLSearchParams(window.location.search).get('project');
    if (requested === null || requested === '') return;
    if (projects.some((project) => project.id === requested)) {
      selectProject(requested); return;
    }
    setInitialProjectNotice('URLで指定された動画は一覧にありません。進行ボードから開き直してください。');
  }, [projects, projectsError, projectsLoading, selectProject]);

  const goHome = useCallback(() => {
    cancelLoadRef.current?.();
    selectedIdRef.current = null;
    setSelectedId(null);
    setOpen(IDLE);
  }, []);

  // 外部（Claude Code 等）でプロジェクトファイルが書き換わったときの通知フラグ。
  const [externallyChanged, setExternallyChanged] = useState(false);
  // SSE 購読: selectedId がある間だけアクティブ。
  useProjectWatch(selectedId, () => setExternallyChanged(true));
  // 別プロジェクトへ切り替えたらフラグはリセット。
  useEffect(() => {
    setExternallyChanged(false);
  }, [selectedId]);
  /**
   * 外部変更バナーだけを畳む（再読込しない）。
   *
   * 上書き保存（衝突からの「この画面の内容で上書き保存」）が成功した時点で、
   * ディスクと画面は一致している。それでもバナーが「外部で更新されました…再読込」の
   * まま残っていたため、直前の成功トーストと矛盾し、初心者が再読込（＝自分の編集の破棄）を
   * 押しかねなかった（サイクル 2 レビュー Important）。
   */
  const clearExternalChange = useCallback(() => {
    setExternallyChanged(false);
  }, []);

  // 再読込: 同じプロジェクトを開き直す。fetch とコンポーネント再マウントで状態が新しくなる。
  const reload = useCallback(() => {
    if (selectedId === null) return;
    setExternallyChanged(false);
    selectProject(selectedId);
  }, [selectedId, selectProject]);

  // handleConvert の convertingRef + selectedIdRef 照合と同じ守りを一箇所へ集約したもの。
  // 切替済み、または dirty（未保存編集あり）なら reload せず false を返す。
  const reloadIfSafe = useCallback(
    (id: string, dirty: boolean): boolean => {
      if (!isCurrent(id) || dirty) return false;
      reload();
      return true;
    },
    [isCurrent, reload],
  );

  return {
    projects, projectsLoading, projectsError, initialProjectNotice, selectedId, open, selectProject, goHome, externallyChanged, reload, isCurrent,
    reloadIfSafe, clearExternalChange, patchProject, setProjectSummaries, refreshProjects, patchLibraries,
  };
}

export type { SaveMeta };
