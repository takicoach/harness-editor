import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorProject, ValidationResult } from '../core/types';
import type { ProjectSummary, ProjectFingerprint } from '../shared/types';
import { fetchJson } from './fetchJson';
import { loadTelopComponent, type TelopComponent } from '../preview/loadTelopComponent';
import { loadInsertImageComponent, type InsertImageComponent } from '../preview/loadInsertImageComponent';
import { loadInsertVideoComponent, type InsertVideoComponent } from '../preview/loadInsertVideoComponent';
import { useProjectWatch } from './useProjectWatch';

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
}

/** 選択中プロジェクトの読込状態。 */
export interface OpenState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  project: EditorProject | null;
  validation: ValidationResult | null;
  save: SaveMeta | null;
  telop: TelopComponent | null;
  insertImage: InsertImageComponent | null;
  insertVideo: InsertVideoComponent | null;
  /**
   * サブ動画部品の読み込みに失敗した理由（**導入済みなのに失敗した場合のみ**・それ以外は null）。
   * 未導入は「失敗」ではなく想定内（プレビューは同梱部品で代替描画し、導入バナーが出る）。
   * 導入済みで失敗した場合は代替描画すると書き出しとの乖離を無警告で隠すため、警告として表に出す。
   */
  insertVideoError: string | null;
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
  error: string | null;
}

const IDLE: OpenState = {
  status: 'idle', project: null, validation: null, save: null, telop: null, insertImage: null,
  insertVideo: null, insertVideoError: null,
  hasVideo: false, sourceAvailable: false, videoLink: null, videoVersion: null, seLibrary: [], imageLibrary: [], telopPackInstalled: false,
  videoLibrary: [], videoInsertInstalled: false,
  bgmLibrary: [], assetVersions: {}, bgmInstalled: false, transitionInstalled: false, shapeInstalled: false, denoiseApplied: false, error: null,
};

export interface EditorProjectState {
  projects: ProjectSummary[];
  projectsError: string | null;
  selectedId: string | null;
  open: OpenState;
  selectProject: (id: string) => void;
  /** プロジェクトを閉じてホーム（未選択状態）へ戻る。 */
  goHome: () => void;
  externallyChanged: boolean;
  reload: () => void;
  /** 今もそのプロジェクトを見ているか（in-flight fetch の settle 時ガード用）。 */
  isCurrent: (id: string) => boolean;
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

/** プロジェクト一覧の取得、選択、選択プロジェクトの読込（データ + テロップ部品）を管理する。 */
export function useEditorProject(): EditorProjectState {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenState>(IDLE);

  useEffect(() => {
    let cancelled = false;
    fetchJson<ProjectsResponse>('/api/projects')
      .then((data) => {
        if (cancelled) return;
        setProjects(data.projects);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setProjectsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patchProject = useCallback((id: string, patch: Partial<ProjectSummary>) => {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const setProjectSummaries = useCallback((next: ProjectSummary[]) => {
    setProjects(next);
  }, []);

  const refreshProjects = useCallback(async () => {
    const data = await fetchJson<ProjectsResponse>('/api/projects');
    setProjects(data.projects);
  }, []);

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
      const { project, validation, save, hasVideo, sourceAvailable, videoLink, videoVersion, seLibrary, imageLibrary, telopPackInstalled, videoLibrary, videoInsertInstalled, bgmLibrary, assetVersions, bgmInstalled, transitionInstalled, shapeInstalled, denoiseApplied } =
        await fetchJson<ProjectResponse>(`/api/project?id=${encodeURIComponent(id)}`);
      const telop = await loadTelopComponent(id);
      let insertImage: InsertImageComponent | null = null;
      try {
        insertImage = await loadInsertImageComponent(id);
      } catch (err) {
        // InsertImage.tsx が無い／ビルドに失敗するプロジェクトは画像レイヤなしで開く。
        console.warn('[sme] 挿入画像部品の読み込みをスキップ:', err);
        insertImage = null;
      }
      let insertVideo: InsertVideoComponent | null = null;
      let insertVideoError: string | null = null;
      try {
        insertVideo = await loadInsertVideoComponent(id);
      } catch (err) {
        // 未導入（InsertVideo.tsx が無い）と、導入済みなのに壊れているのを区別する。
        // サーバはどちらも 500 を返すため、導入マーカー（videoInsertInstalled）で判定する。
        insertVideo = null;
        if (videoInsertInstalled) {
          insertVideoError =
            'サブ動画部品（InsertVideo.tsx）を読み込めませんでした。プレビューにサブ動画は表示されません（書き出しは影響を受けない可能性があります）。'
            + `詳細: ${err instanceof Error ? err.message : String(err)}`;
          console.warn('[sme] サブ動画部品の読み込みに失敗:', err);
        } else {
          // 未導入は想定内。プレビューは同梱部品で代替描画し、導入バナーが警告を担う。
          console.warn('[sme] サブ動画未導入のため同梱部品で代替描画:', err);
        }
      }
      if (cancelled) return;
      setOpen({
        status: 'ready', project, validation, save, telop, insertImage, insertVideo, insertVideoError,
        hasVideo, sourceAvailable, videoLink, videoVersion, seLibrary, imageLibrary, telopPackInstalled,
        videoLibrary, videoInsertInstalled,
        bgmLibrary, assetVersions, bgmInstalled, transitionInstalled, shapeInstalled, denoiseApplied, error: null,
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
  // 再読込: 同じプロジェクトを開き直す。fetch とコンポーネント再マウントで状態が新しくなる。
  const reload = useCallback(() => {
    if (selectedId === null) return;
    setExternallyChanged(false);
    selectProject(selectedId);
  }, [selectedId, selectProject]);

  return {
    projects, projectsError, selectedId, open, selectProject, goHome, externallyChanged, reload, isCurrent,
    patchProject, setProjectSummaries, refreshProjects, patchLibraries,
  };
}

export type { SaveMeta };
