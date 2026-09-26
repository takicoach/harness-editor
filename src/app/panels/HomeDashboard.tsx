import { useEffect, useRef, useState } from 'react';
import type { ProjectSummary, ProjectSteps } from '../../shared/types';
import { defaultProjectName } from '../createProjectApi';
import {TaskProgress,type TransferProgress} from '../components/TaskProgress';
import { DISPLAY_STATUSES, STATUS_LABEL, type ProjectStage } from '../../shared/projectStage';
import { VideoThumb } from './VideoThumb';
import { MediaPicker, type PickedFile } from './MediaPicker';
import { useDropdown } from '../useDropdown';
import { useLiveNow } from '../useLiveNow';
import { resolveStatusView, formatRelativeTime } from './projectStatusView';
import { groupProjectsByStatus } from './homeKanban';
import { loadHomeView, saveHomeView, type HomeView } from './homeViewPref';
import { largeUploadNotice } from '../../shared/uploadNotice';
import { CREATE_MEDIA_ACCEPT, classifyCreateSelection, imageLimitMessage } from '../../shared/createMedia';
import { deleteProjectRequest } from '../trashApi';
import { moveProjectsToTrash, formatBulkTrashResult } from '../trashBulk';
import { revealProjectRequest } from '../projectRevealApi';
import { pruneSelection, toggleSelection } from './projectSelection';
import { TrashConfirmDialog } from './TrashConfirmDialog';
import { TrashView } from './TrashView';
import { TrashIcon } from '../icons/TrashIcon';
import { Icon } from '../Icon';
import { linkCandidateRequest, convertToLinkRequest } from '../convertLinkApi';
import { formatSize } from '../../shared/format';
import type { EditorProjectBoardItem } from '../../shared/editorBoard';
import { useEditorProjectBoard, type EditorProjectBoardState } from '../useEditorProjectBoard';
import { editorProjectBoardView } from './editorProjectBoardView';
import './editorProjectBoard.css';

/** Dropped images use the same numeric filename order as Finder. */
const FILE_NAME_ORDER = new Intl.Collator('ja', { numeric: true });

interface HomeDashboardProps {
  /** Native projects retain managed media copies for reproducible preview/export. */
  managedMedia?: boolean;
  projects: ProjectSummary[];
  error: string | null;
  /** 一覧の初回取得中か（status-ia-1）。true の間は空状態を出さない。 */
  loading?: boolean;
  /** URL指定が一覧外だった等、一覧を隠さずに伝える案内。 */
  notice?: string | null;
  /** AI作業は制作stageとは別の読み取り専用projection。未指定なら従来カードだけを描画する。 */
  agentBoard?: Omit<EditorProjectBoardState, 'refresh'>;
  /** カードクリックでプロジェクトを開く。 */
  onPick: (id: string) => void;
  /** バッジメニューで手動 stage を設定（null=自動判定に戻す）。App が楽観更新・巻き戻し・トーストを担う。 */
  onSetStage: (id: string, stage: ProjectStage) => void;
  /** 「動画を作成する」。動画（コピー or 外部リンク）と名前を受け取り作成〜エディタで開くまで担う。 */
  onCreate: (name: string, source: CreateSource, preferCopy: boolean,onProgress?:(progress:TransferProgress)=>void) => Promise<void>;
  /** プロジェクトの削除・復元後に一覧を再取得する（App の refreshProjects）。 */
  onProjectsChanged: () => void;
  /** 相対時刻の基準（テスト注入用）。 */
  now?: number;
}

/** バッジメニューの選択肢。表示ステータス全値（正本 shared/projectStage）+ 自動判定に戻す。 */
const STAGE_OPTIONS: { stage: ProjectStage; label: string }[] = [
  ...DISPLAY_STATUSES.map((s) => ({ stage: s, label: `${STATUS_LABEL[s]}にする` })),
  { stage: null, label: '自動判定に戻す' },
];

/**
 * プロジェクト未選択時のホーム。カードグリッドで各プロジェクトの
 * サムネ・ステータス・最終編集日時・尺を一覧する。
 */
export function HomeDashboard({ projects, error, loading = false, notice = null, agentBoard, onPick, onSetStage, onCreate, onProjectsChanged, now, managedMedia = false }: HomeDashboardProps) {
  const boardItem = (projectId: string) => agentBoard && Object.prototype.hasOwnProperty.call(agentBoard.items, projectId)
    ? agentBoard.items[projectId]
    : undefined;
  // ホーム画面表示中だけ 45 秒間隔で現在時刻を更新し、相対時刻表示・stale 判定を進行させる
  // （now が明示的に渡された場合はテスト注入として優先し、live 更新は使わない）。
  const liveNow = useLiveNow();
  const effectiveNow = now ?? liveNow;

  // 表示モード（パネル/カンバン）。localStorage 永続。
  const [view, setView] = useState<HomeView>(() => loadHomeView());
  const changeView = (v: HomeView): void => {
    setView(v);
    saveHomeView(v);
  };

  // D&D 中にハイライトする列。列間移動のみ（同列 drop は無効 = 並び替えは提供しない）。
  const [dropCol, setDropCol] = useState<string | null>(null);

  // 新規作成: 選んだ動画（null = モーダル非表示）。コピー取り込みと外部リンクの2経路。
  const [createSource, setCreateSource] = useState<CreateSource | null>(null);
  // 外付け等から選ぶファイラを開いているか。
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ホームの明示的ドロップ領域（Finder からの動画ドロップ → 作成モーダル）。
  // App.tsx のウィンドウ全域 drop 抑止（誤ドロップでページが飛ぶ事故の防止）は維持したまま、
  // ここで先に処理する。カード・ダイアログ・メニュー上への誤ドロップは新規作成にしない。
  const [homeDragDepth, setHomeDragDepth] = useState(0);
  // 直近のドラッグ位置が「受理しない領域・状態」か（ヒント表示の抑止に使う）。
  const [blockedOver, setBlockedOver] = useState(false);
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  // プロジェクト削除（ゴミ箱）とルートゴミ箱一覧。
  const [projTrashConfirm, setProjTrashConfirm] = useState<{ id: string; name: string } | null>(null);
  const [rootTrashOpen, setRootTrashOpen] = useState(false);
  // 削除失敗の通知はドロップ通知（5秒で自動的に消える案内）と混ぜない。
  // 失敗はユーザーが読んで対処する必要があるため、消えない専用の表示にする。
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // 「保存先を開く」の失敗（多くは 404＝フォルダを外で動かした）。console.warn だけだと
  // 非エンジニアには「押したのに何も起きない＝壊れた」に見えるので画面へ出す（レビュー M-5）。
  const [revealError, setRevealError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  // 選択モード（一括ゴミ箱移動）。ボード・一覧のどちらでも同じ state を使う。
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // 一括移動の確認ダイアログを開いているか。対象は selection から都度導く。
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);
  // 一括移動の結果通知（M 件移動・K 件スキップ）。
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  // 一覧から消えた ID は選択に数え残さない（削除・外部変更のあと）。
  const liveSelected = pruneSelection(selectedIds, projects);
  const selectedTargets = liveSelected.map((id) => {
    const p = projects.find((q) => q.id === id);
    return { id, name: p?.name ?? id };
  });

  // リンク化（容量回収）。探す → 見つかった接続先を見せて確認 → 実行、の 3 段。
  // 接続先パスはサーバが探索して決めるので、ここで持つのは**表示のため**だけ
  // （確認後もサーバへ送り返さない＝クライアントの表示値で置換先が決まらない）。
  const [convertBusyId, setConvertBusyId] = useState<string | null>(null);
  const [convertConfirm, setConvertConfirm] = useState<{ id: string; name: string; target: string } | null>(null);
  const [convertPending, setConvertPending] = useState(false);
  const [convertNotice, setConvertNotice] = useState<string | null>(null);

  const startConvertLink = (id: string, name: string): void => {
    if (convertBusyId !== null) return;
    setConvertBusyId(id);
    setConvertNotice(null);
    void linkCandidateRequest(id)
      .then((c) => {
        if (c.matched) setConvertConfirm({ id, name, target: c.target });
        else setConvertNotice(c.message);
      })
      .catch((err: unknown) => {
        setConvertNotice(err instanceof Error ? err.message : '同じ動画を探せませんでした');
      })
      .finally(() => setConvertBusyId(null));
  };

  const confirmConvertLink = (): void => {
    if (convertConfirm === null || convertPending) return;
    const { id } = convertConfirm;
    setConvertPending(true);
    void convertToLinkRequest(id)
      .then((r) => {
        setConvertConfirm(null);
        setConvertNotice(
          // 実際に消せていない時に「回収しました」と言わない（I-1）。
          r.keptCopyPath === undefined
            ? `${formatSize(r.freedBytes)} を回収しました（動画の実体: ${r.target}）`
            : `リンクに置き換えましたが、元のコピーを消せませんでした（${r.keptCopyPath}）。` +
              'ゴミ箱を空にすると容量が回収されます',
        );
        onProjectsChanged();
      })
      .catch((err: unknown) => {
        setConvertConfirm(null);
        setConvertNotice(err instanceof Error ? err.message : 'リンク化できませんでした');
      })
      .finally(() => setConvertPending(false));
  };

  const exitSelectMode = (): void => {
    setSelectMode(false);
    setSelectedIds([]);
    setBulkConfirm(false);
    // 前回の一括移動の結果を持ち越さない（別の操作の結果に見える・レビュー M-3）。
    setBulkNotice(null);
  };

  const openRootTrash = (): void => {
    setBulkNotice(null);
    setRootTrashOpen(true);
  };

  const confirmBulkTrash = (): void => {
    if (bulkPending || selectedTargets.length === 0) return;
    setBulkPending(true);
    setDeleteError(null);
    void moveProjectsToTrash(selectedTargets)
      .then((r) => {
        setBulkConfirm(false);
        setBulkNotice(formatBulkTrashResult(r));
        // 成功・失敗にかかわらず一覧を取り直す（部分成功でも表示を実体に合わせる）。
        onProjectsChanged();
        // スキップが 1 件でもあれば選択モードを抜けず、**失敗した分だけ**選択に残す
        // （レビュー I-2）。原因（実行中ジョブ等）を解消すればそのまま再実行できる。
        // 全部消すと、やり直す操作をもう一度最初から作り直させることになる。
        if (r.skipped.length > 0) {
          setSelectMode(true);
          setSelectedIds(r.skipped.map((s) => s.id));
          return;
        }
        // 通知は残す（exitSelectMode はクリアするので、その前に読み出せる形にしない）。
        setSelectMode(false);
        setSelectedIds([]);
      })
      .catch((err: unknown) => {
        // moveProjectsToTrash 自体は投げない設計だが、通知・再取得の副作用で
        // 例外が出た場合に沈黙させない（送信中表示のまま固まらせない）。
        setBulkConfirm(false);
        setDeleteError(err instanceof Error ? err.message : 'ゴミ箱へ移動できませんでした');
      })
      .finally(() => setBulkPending(false));
  };

  // 一覧から消えた ID は **state 側でも**落とす（レビュー M-1）。表示だけ剪定していると、
  // 同じ ID のプロジェクトが復元・再作成で戻ってきたときに選択が蘇る。
  // pruneSelection は落とすものが無ければ同一参照を返すので、これで再レンダは増えない。
  useEffect(() => {
    setSelectedIds((s) => pruneSelection(s, projects));
  }, [projects]);

  useEffect(() => {
    if (dropNotice === null) return;
    const t = setTimeout(() => setDropNotice(null), 5000);
    return () => clearTimeout(t);
  }, [dropNotice]);

  const confirmDeleteProject = (): void => {
    if (projTrashConfirm === null || deletePending) return;
    const { id } = projTrashConfirm;
    setDeletePending(true);
    setDeleteError(null);
    void deleteProjectRequest(id)
      .then(() => {
        setProjTrashConfirm(null);
        onProjectsChanged();
      })
      .catch((err: unknown) => {
        setProjTrashConfirm(null);
        setDeleteError(err instanceof Error ? err.message : 'プロジェクトを削除できませんでした');
      })
      .finally(() => setDeletePending(false));
  };

  const isFileDrag = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files');
  const overExcluded = (e: React.DragEvent): boolean =>
    e.target instanceof Element &&
    e.target.closest('.home-card, .export-overlay, .dd-menu') !== null;

  /**
   * このドロップ位置・この状態では**受理しない**か。受理条件と 1 箇所で定義し、
   * ハイライト（「ここにドロップ」）の表示条件にも同じ述語を使う
   * — 受理しない場所で受理できるように見せない（バッチE レビュー指摘③）。
   */
  const dropBlocked = (e: React.DragEvent): boolean =>
    overExcluded(e) || createSource !== null || pickerOpen;

  /**
   * 選んだ・ドロップしたファイルから作成の素材を決める（設計 M1・M3b・M6b）。
   * 1回の作成で1種類。画像は複数可（上限を超えたら理由だけ出す）。動画・音声は1件目だけ（複数なら通知）。
   */
  const startCreate = (files: File[], via: 'drop' | 'select'): void => {
    const first = files[0];
    if (first === undefined) return;
    const selection = classifyCreateSelection(files.map((file) => file.name));
    if (!selection.ok) {
      setDropNotice(selection.message);
      return;
    }
    if (selection.kind === 'image' && files.length > 1) {
      const ordered = via === 'drop' ? [...files].sort((a, b) => FILE_NAME_ORDER.compare(a.name, b.name)) : files;
      const limit = imageLimitMessage(ordered.length, ordered.reduce((sum, file) => sum + file.size, 0));
      if (limit !== null) {
        setDropNotice(limit);
        return;
      }
      setCreateSource({ kind: 'upload-images', files: ordered });
      return;
    }
    if (files.length > 1) {
      setDropNotice(`${files.length} 件${via === 'drop' ? 'ドロップされました' : '選ばれました'}。1件目のみ取り込みます: ${first.name}`);
    }
    setCreateSource({ kind: 'upload', file: first });
  };

  const handleHomeDrop = (e: React.DragEvent): void => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setHomeDragDepth(0);
    setBlockedOver(false);
    if (dropBlocked(e)) return;
    startCreate(Array.from(e.dataTransfer.files), 'drop');
  };

  const pickImages = (files: PickedFile[]): void => {
    const limit = imageLimitMessage(files.length, files.reduce((sum, file) => sum + file.sizeBytes, 0));
    if (limit !== null) {
      setDropNotice(limit);
      return;
    }
    setPickerOpen(false);
    setCreateSource({ kind: 'link-images', files });
  };

  const homeDropHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      // 受理しない領域・状態ではヒントを出さない（深さは数え続ける — 数えないと
      // 対になる dragleave で負に振れて、除外領域を通っただけでハイライトが消える）。
      setBlockedOver(dropBlocked(e));
      setHomeDragDepth((d) => d + 1);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      const blocked = dropBlocked(e);
      setBlockedOver(blocked);
      e.dataTransfer.dropEffect = blocked ? 'none' : 'copy';
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      setHomeDragDepth((d) => Math.max(0, d - 1));
    },
    onDrop: handleHomeDrop,
  };

  const dropOverlay = (
    <>
      {homeDragDepth > 0 && !blockedOver && (
        <div className="home-drop-hint" data-testid="home-drop-hint">
          ここにドロップして作成（動画・音声・画像）
        </div>
      )}
      {dropNotice !== null && (
        <div className="home-drop-notice" role="status">{dropNotice}</div>
      )}
    </>
  );

  const createUi = (
    <>
      <button type="button" className="home-create-btn" data-tutorial="home-create" onClick={() => fileInputRef.current?.click()}>
        ＋ 動画を作成する
      </button>
      <button
        type="button"
        className="home-create-link-btn"
        title="元動画をコピーせず、選んだ場所から読み込みます"
        onClick={() => setPickerOpen(true)}
      >
        フォルダから選ぶ
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept={CREATE_MEDIA_ACCEPT}
        multiple
        style={{ display: 'none' }}
        data-testid="home-create-file"
        onChange={(e) => {
          startCreate(Array.from(e.target.files ?? []), 'select');
          e.target.value = ''; // 同じファイルを選び直しても change が発火するように
        }}
      />
      {pickerOpen && (
        <MediaPicker
          media="all"
          multiple
          title={managedMedia ? '素材を選ぶ' : '素材を選ぶ（リンクで取り込み）'}
          note="動画・音声は1件を選びます。画像は複数選ぶと、選んだ順に1枚5秒で並べます（複数の画像はコピーして取り込みます）。"
          onCancel={() => setPickerOpen(false)}
          onPick={(f) => {
            setPickerOpen(false);
            setCreateSource({ kind: 'link', name: f.name, path: f.path, sizeBytes: f.sizeBytes });
          }}
          onPickMany={pickImages}
        />
      )}
      {createSource !== null && (
        <CreateProjectModal
          managedMedia={managedMedia}
          source={createSource}
          onCancel={() => setCreateSource(null)}
          onCreate={onCreate}
        />
      )}
    </>
  );

  // ゴミ箱はダイアログではなく、ホームと同じ画面領域を使う全画面ビュー（「戻る」で復帰）。
  if (rootTrashOpen) {
    return <TrashView onBack={() => setRootTrashOpen(false)} onChanged={onProjectsChanged} />;
  }

  if (error !== null) {
    return (
      <div className="home" data-tutorial="home">
        <div className="sme-center">
          <p className="sme-error">プロジェクト一覧を取得できませんでした</p>
          <p className="hint">{error}</p>
          {/* 一覧が出せなくてもゴミ箱＝復元の唯一の入口は塞がない（レビュー M-4）。 */}
          <button
            type="button"
            className="home-trash-open"
            title="ゴミ箱（削除したプロジェクトの復元）"
            onClick={openRootTrash}
          >
            ゴミ箱
          </button>
        </div>
      </div>
    );
  }

  // 取得中は空状態より前に読込中を出す（status-ia-1）。
  // 「まだプロジェクトがありません」を先に見せると「作った動画が消えた」と誤解させる。
  if (loading && projects.length === 0) {
    return (
      // 読込中でもドロップは受ける（サイクル 3 残 Minor）。一覧が出るまでの数百 ms に
      // 落とした動画が黙って無視されると「ドロップは効かない」と学習してしまう。
      <div className="home" data-tutorial="home" {...homeDropHandlers}>
        {dropOverlay}
        <div className="sme-center" data-testid="home-loading">
          <TaskProgress label="プロジェクトを読み込み中…"/>
        </div>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="home" data-tutorial="home" {...homeDropHandlers}>
        {dropOverlay}
        <div className="sme-center">
          <p>まだプロジェクトがありません</p>
          <p className="hint">動画を選んで最初のプロジェクトを作りましょう</p>
          {createUi}
          {/* 全件をゴミ箱へ移した直後もここに来る。復元導線を必ず残す。 */}
          <button
            type="button"
            className="home-trash-open"
            title="ゴミ箱（削除したプロジェクトの復元）"
            onClick={openRootTrash}
          >
            ゴミ箱
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="home" data-tutorial="home" {...homeDropHandlers}>
      {dropOverlay}
      <div className="home-head">
        <h1>プロジェクト</h1>
        <span className="home-count">{projects.length} 件</span>
        {createUi}
        <div className="home-view-switch" data-tutorial="home-view-switch" role="group" aria-label="表示切替">
          {([['panel', '一覧'], ['kanban', '進行ボード']] as Array<[HomeView, string]>).map(([v, label]) => (
            <button
              key={v}
              type="button"
              className={'home-view-btn' + (view === v ? ' active' : '')}
              aria-pressed={view === v}
              onClick={() => changeView(v)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={'home-select-toggle' + (selectMode ? ' active' : '')}
          aria-pressed={selectMode}
          disabled={bulkPending}
          title="複数のプロジェクトを選んでまとめてゴミ箱へ移動します"
          onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
        >
          選択
        </button>
        <button
          type="button"
          className="home-trash-open"
          disabled={bulkPending}
          title="ゴミ箱（削除したプロジェクトの復元）"
          onClick={openRootTrash}
        >
          ゴミ箱
        </button>
      </div>
      {notice && <p className="home-board-notice" role="status">{notice}</p>}
      {agentBoard && <div className="home-agent-guide">
        <span>処理中のタブを開いたまま、別の動画を編集できます。</span>
        {agentBoard.status === 'error' && <span role="status">AI作業の状態を確認できません。次の更新で再確認します。</span>}
      </div>}
      {selectMode && (
        <div className="home-select-bar" data-testid="home-select-bar" role="status">
          <span className="home-select-count">{selectedTargets.length} 件選択中</span>
          <button
            type="button"
            className="home-select-move"
            disabled={selectedTargets.length === 0 || bulkPending}
            onClick={() => setBulkConfirm(true)}
          >
            ゴミ箱へ移動
          </button>
          <button type="button" className="export-cancel" disabled={bulkPending} onClick={exitSelectMode}>
            キャンセル
          </button>
        </div>
      )}
      {bulkNotice !== null && (
        <p className="home-bulk-notice" role="status" data-testid="home-bulk-notice">
          {bulkNotice}
          <button type="button" className="export-cancel" onClick={() => setBulkNotice(null)}>
            閉じる
          </button>
        </p>
      )}
      {view === 'panel' ? (
        <div className="home-grid" data-tutorial="home-grid">
          {projects.map((p) => (
            <ProjectCard
                    key={p.id}
                    p={p}
                    now={effectiveNow}
                    onPick={onPick}
                    onSetStage={onSetStage}
                    onDelete={(id, name) => setProjTrashConfirm({ id, name })}
                    onRevealFailed={setRevealError}
                    onConvertLink={startConvertLink}
                    convertBusy={convertBusyId === p.id}
                    selectMode={selectMode}
                    selected={liveSelected.includes(p.id)}
                    agentItem={boardItem(p.id)}
                    agentStatus={agentBoard?.status}
                    onToggleSelect={(id) => setSelectedIds((s) => toggleSelection(s, id))}
                  />
          ))}
        </div>
      ) : (
        <div className="home-kanban">
          {groupProjectsByStatus(projects).map((col) => (
            <div
              key={col.status}
              className={
                'home-col' +
                (col.projects.length === 0 ? ' empty' : '') +
                (dropCol === col.status ? ' drop-target' : '')
              }
              data-status={col.status}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('application/x-sme-project')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDropCol(col.status);
              }}
              onDragLeave={() => setDropCol((s) => (s === col.status ? null : s))}
              onDrop={(e) => {
                if (!e.dataTransfer.types.includes('application/x-sme-project')) return;
                e.preventDefault();
                setDropCol(null);
                const id = e.dataTransfer.getData('application/x-sme-project');
                const proj = projects.find((q) => q.id === id);
                // 同一列内 drop は無効（列内は lastEditedAt 降順のまま・列間移動専用）。
                if (proj === undefined || proj.status === col.status) return;
                onSetStage(id, col.status);
              }}
            >
              <div className="home-col-head">
                <span className="home-col-label">{col.label}</span>
                <span className="home-col-count">{col.projects.length}</span>
              </div>
              <div className="home-col-cards">
                {col.projects.map((p) => (
                  <ProjectCard
                    key={p.id}
                    p={p}
                    now={effectiveNow}
                    onPick={onPick}
                    onSetStage={onSetStage}
                    onDelete={(id, name) => setProjTrashConfirm({ id, name })}
                    onRevealFailed={setRevealError}
                    onConvertLink={startConvertLink}
                    convertBusy={convertBusyId === p.id}
                    selectMode={selectMode}
                    selected={liveSelected.includes(p.id)}
                    agentItem={boardItem(p.id)}
                    agentStatus={agentBoard?.status}
                    onToggleSelect={(id) => setSelectedIds((s) => toggleSelection(s, id))}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {convertNotice !== null && (
        <p className="home-bulk-notice" role="status" data-testid="home-convert-notice">
          {convertNotice}
          <button type="button" className="export-cancel" onClick={() => setConvertNotice(null)}>
            閉じる
          </button>
        </p>
      )}
      {convertConfirm !== null && (
        <ConvertLinkDialog
          name={convertConfirm.name}
          target={convertConfirm.target}
          busy={convertPending}
          onConfirm={confirmConvertLink}
          onCancel={() => setConvertConfirm(null)}
        />
      )}
      {revealError !== null && (
        <p className="sme-error" role="alert" data-testid="home-reveal-error">
          {revealError}
          <button type="button" className="export-cancel" onClick={() => setRevealError(null)}>
            閉じる
          </button>
        </p>
      )}
      {deleteError !== null && (
        <p className="sme-error" role="alert" data-testid="home-delete-error">
          {deleteError}
          <button type="button" className="export-cancel" onClick={() => setDeleteError(null)}>
            閉じる
          </button>
        </p>
      )}
      {projTrashConfirm !== null && (
        <TrashConfirmDialog
          name={projTrashConfirm.name}
          usedCount={0}
          mode="trash"
          busy={deletePending}
          onConfirm={confirmDeleteProject}
          onCancel={() => setProjTrashConfirm(null)}
        />
      )}
      {bulkConfirm && selectedTargets.length > 0 && (
        <TrashConfirmDialog
          name={selectedTargets[0]?.name ?? ''}
          names={selectedTargets.map((t) => t.name)}
          usedCount={0}
          mode="trash"
          busy={bulkPending}
          onConfirm={confirmBulkTrash}
          onCancel={() => setBulkConfirm(false)}
        />
      )}
    </div>
  );
}

interface ConvertLinkDialogProps {
  name: string;
  target: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * リンク化（容量回収）の確認。**既定フォーカスはキャンセル** — 破壊的な置換なので、
 * Enter の連打で走らせない（削除確認と同じ規律）。
 */
function ConvertLinkDialog({ name, target, busy, onConfirm, onCancel }: ConvertLinkDialogProps) {
  return (
    <div className="export-overlay" onClick={busy ? undefined : onCancel}>
      <div
        className="export-dialog"
        data-testid="convert-link-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="export-head">リンク化して容量を回収する</div>
        <p className="hint">
          「{name}」のコピーを削除してリンクに置き換えます（同一の動画が外付けにあることを確認済みです）。
        </p>
        <div className="home-create-link-note" role="note">
          動画の実体: {target}
        </div>
        <p className="sme-error" role="note">
          置き換えたあとは、この動画がある SSD を外すと編集できなくなります。
          リンク化後は音量調整・ノイズ除去が使えなくなります。
        </p>
        <div className="export-actions">
          <button type="button" className="export-cancel" autoFocus disabled={busy} onClick={onCancel}>
            キャンセル
          </button>
          <button type="button" className="export-start" disabled={busy} onClick={onConfirm}>
            リンク化する
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 新規作成の素材。1件（動画・音声・画像）はコピー取り込み（アップロード）か外部実体へのリンク。
 * 2枚以上の画像は、アップロードかフォルダから選んだパスで、どちらもコピーで取り込む（設計 M3e）。
 */
export type CreateSource =
  | { kind: 'upload'; file: File }
  | { kind: 'link'; name: string; path: string; sizeBytes: number }
  | { kind: 'upload-images'; files: File[] }
  | { kind: 'link-images'; files: PickedFile[] };

/** 作成ダイアログの「素材: …」（設計 M6）。 */
export function createSourceLabel(source: CreateSource): string {
  if (source.kind === 'upload') return source.file.name;
  if (source.kind === 'link') return source.name;
  return `画像 ${source.files.length} 枚（${source.files[0]?.name ?? ''} ほか）`;
}
/** 複数画像の合計の大きさ（バイト）。 */
function imagesTotalBytes(source: Extract<CreateSource, { kind: 'upload-images' | 'link-images' }>): number {
  return source.kind === 'upload-images' ? source.files.reduce((sum, file) => sum + file.size, 0) : source.files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

interface CreateProjectModalProps {
  managedMedia?: boolean;
  source: CreateSource;
  onCancel: () => void;
  onCreate: (name: string, source: CreateSource, preferCopy: boolean,onProgress?:(progress:TransferProgress)=>void) => Promise<void>;
}

/**
 * 新規プロジェクトの名前確認モーダル。作成成功時は親がエディタへ遷移して
 * ホームごとアンマウントされるため、成功側のクローズ処理は持たない。
 */
function CreateProjectModal({ source, onCancel, onCreate, managedMedia = false }: CreateProjectModalProps) {
  const fileName = createSourceLabel(source);
  const images = source.kind === 'upload-images' || source.kind === 'link-images' ? source : null;
  const [name, setName] = useState(() => defaultProjectName(source.kind === 'upload' ? source.file.name : source.kind === 'link' ? source.name : source.files[0]!.name));
  const [progress,setProgress]=useState<TransferProgress>({phase:'preparing'});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // アップロード経路の既定は「できる限りリンク化」。サーバが登録済みフォルダから
  // 同一実体を探し、確証が取れたときだけリンクにする。ここはその自動判定を切って
  // 必ずコピーさせるための逃げ道（外付けを外して持ち歩きたい場合など）。
  const [preferCopy, setPreferCopy] = useState(false);
  // リンク取り込みは実体を運ばないので、大容量の待ち時間案内は出さない。
  const sizeNotice = source.kind === 'upload' && (!managedMedia||preferCopy) ? largeUploadNotice(source.file.size)
    : source.kind === 'upload-images' ? largeUploadNotice(imagesTotalBytes(source)) : null;

  const submit = (): void => {
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('プロジェクト名を入力してください');
      return;
    }
    setBusy(true);
    setError(null);
    (managedMedia?onCreate(trimmed, source, preferCopy,setProgress):onCreate(trimmed,source,preferCopy)).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'プロジェクトの作成に失敗しました');
      setBusy(false);
    });
  };

  return (
    <div className="export-overlay" onClick={busy ? undefined : onCancel}>
      <div className="export-dialog home-create-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="export-head">動画を作成する</div>
                <div className="home-create-file-note">素材: {fileName}</div>
        {images !== null && (
          <p className="home-create-link-note" role="note" data-testid="home-create-images-note">
            画像 {images.files.length} 枚（合計 {formatSize(imagesTotalBytes(images))}）をコピーして取り込みます。元の画像は変更しません。選んだ順に1枚5秒で並べます。
          </p>
        )}
        {managedMedia && source.kind==='upload' && <p className="home-create-link-note" role="note">{preferCopy?'元の動画を変更せず、編集用のコピーを保存します。動画の容量に応じた空き容量が必要です。':'元の動画をコピーせずに使います。外付けの動画は、編集するときにドライブを接続してください。'}</p>}
        {source.kind === 'link' && (
          <div className="home-create-link-note" role="note">
            リンクで取り込みます（コピーしません）: {source.path}
          </div>
        )}
        {sizeNotice !== null && <div className="home-create-large-note" role="note">{sizeNotice}</div>}
        <label className="home-create-label">
          プロジェクト名
          <input
            type="text"
            className="home-create-name"
            value={name}
            autoFocus
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape' && !busy) onCancel();
            }}
          />
        </label>
        {source.kind === 'upload' && (
          <label className="home-create-copy-label">
            <input
              type="checkbox"
              data-testid="home-create-copy"
              checked={preferCopy}
              disabled={busy}
              onChange={(e) => setPreferCopy(e.target.checked)}
            />
            コピーして取り込む（外付けを外しても編集できるようにする）
          </label>
        )}
        {source.kind === 'upload' && !preferCopy && (
          <p className="hint home-create-link-hint">
            {managedMedia?'元動画の保存場所を確認します。自動で見つからない場合は、保存場所を選んでください。':'同じ動画が登録済みのフォルダ（外付け・デスクトップ・ダウンロード・ムービー）にあれば、コピーせずリンクで取り込みます。'}
          </p>
        )}
        {error !== null && <p className="sme-error home-create-error">{error}</p>}
        {busy && (
          <TaskProgress label={progress.phase==='uploading'?(images!==null?'画像をコピーしています':'素材をコピーしています'):progress.phase==='checking'?'元の動画を確認しています':'動画を確認して編集の準備をしています'} value={progress.total?progress.loaded!/progress.total:undefined} detail={progress.total?`${((progress.loaded??0)/1048576).toFixed(0)} / ${(progress.total/1048576).toFixed(0)} MB`:'素材の解析・音声の準備が終わると編集画面が開きます。'} />
        )}
        <div className="export-actions">
          <button type="button" className="export-cancel" onClick={onCancel} disabled={busy}>
            キャンセル
          </button>
          <button type="button" className="export-start" onClick={submit} disabled={busy}>
            作成
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 工程ステッパーのラベル。Record なので ProjectSteps にキーが増えたら型エラーになり、
 * ラベルの付け忘れをコンパイル時に検出できる（配列1本だと網羅が型で守れない）。
 */
export const STEP_LABEL: Record<keyof ProjectSteps, string> = {
  transcribe: '文字起こし',
  cut: 'カット',
  telop: 'テロップ',
  audio: 'SE/BGM',
  rendered: '書き出し',
};

/** 工程ステッパーの表示順（編集フロー準拠）。網羅は STEP_LABEL とのキー数一致テストで担保。 */
export const STEP_ORDER: ReadonlyArray<keyof ProjectSteps> = [
  'transcribe',
  'cut',
  'telop',
  'audio',
  'rendered',
];

/** ステップ完了判定。telop のみ三値（nonempty のときだけ完了）。 */
function stepDone(steps: ProjectSteps, key: keyof ProjectSteps): boolean {
  if (key === 'telop') return steps.telop === 'nonempty';
  return steps[key] === true;
}

interface ProjectCardProps {
  p: ProjectSummary;
  now: number;
  onPick: (id: string) => void;
  onSetStage: (id: string, stage: ProjectStage) => void;
  onDelete: (id: string, name: string) => void;
  /** 「保存先を開く」が失敗したときの通知（null で消す）。表示は親が持つ。 */
  onRevealFailed: (message: string | null) => void;
  /** コピー実体をリンクへ張り替える（容量回収）。探索は親が担う。 */
  onConvertLink: (id: string, name: string) => void;
  /** このカードの候補探索が走っている間 true（メニュー項目を「探しています…」にする）。 */
  convertBusy?: boolean;
  /** 選択モード中か。true の間はカードの D&D と「開く」を止め、選択トグルに置き換える。 */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  agentItem?: EditorProjectBoardItem;
  agentStatus?: EditorProjectBoardState['status'];
}

function ProjectCard({ p, now, onPick, onSetStage, onDelete, onRevealFailed, onConvertLink, convertBusy = false, selectMode = false, selected = false, onToggleSelect, agentItem, agentStatus }: ProjectCardProps) {
  const view = resolveStatusView(p, now);
  const agentView = agentItem ? editorProjectBoardView(agentItem) : null;
  const boardItemMissing = agentStatus === 'ready' && agentItem === undefined;
  const dd = useDropdown();
  const steps = p.steps;
  // 削除アイコンを掴んだ直後だけドラッグ開始を抑止するフラグ。
  // dragstart は draggable 祖先（＝このカード）で発火し、アイコンの onDragStart は
  // イベント経路に載らない（＝アイコン側で止められない）。そこでアイコンの pointerdown で
  // 印を付け、カードの onDragStart 冒頭で見て preventDefault する。
  // 解除はカード本体の onPointerDown（アイコンは stopPropagation するのでそこには来ない）に加え、
  // アイコン自身の pointerup / pointercancel でも行う（＝印の寿命をその 1 ジェスチャに閉じる）。
  // これが無いと「アイコンを押して離しただけ」で印が残り、次に別経路（バッジ等）で始めた
  // ドラッグまで巻き添えで潰れうる。dragstart はドラッグ確定時点で pointerup より先に来るので、
  // 本来の抑止（アイコンを掴んだままドラッグ）は壊れない。
  const suppressDragRef = useRef(false);

  const thumbClass =
    'home-card-thumb' + (p.orientation === 'h' ? ' h' : p.orientation === 'sq' ? ' sq' : ' v');

  return (
    <div
      className={'home-card' + (selectMode ? ' select-mode' : '') + (selected ? ' selected' : '')}
      // AI エージェントが案件を名前で開けるようにする（ホームにはカード以外の入口が無い）。
      data-testid={`project-card-${p.id}`}
      data-project-id={p.id}
      role="button"
      tabIndex={0}
      draggable={!selectMode}
      onPointerDown={() => {
        suppressDragRef.current = false;
      }}
      onDragStart={(e) => {
        // 選択モード中は列間 D&D を止める（チェックしている最中の誤移動を作らない）。
        // draggable={false} だけでは、React 経由の合成ドラッグや古い描画が残った場合に
        // すり抜けうるため、ここでも明示的に断つ。
        if (selectMode) {
          e.preventDefault();
          return;
        }
        if (suppressDragRef.current) {
          // 削除アイコンを掴んだドラッグ。カードを動かさない。
          suppressDragRef.current = false;
          e.preventDefault();
          return;
        }
        // 進行ボードの列間移動用。パネルビューでも掴めるが drop 先が無いだけで無害。
        e.dataTransfer.setData('application/x-sme-project', p.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => (selectMode ? onToggleSelect?.(p.id) : onPick(p.id))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (selectMode) onToggleSelect?.(p.id);
          else onPick(p.id);
        }
      }}
      title={p.name}
    >
      {selectMode && (
        <label className="home-card-check" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            aria-label={`${p.name} を選択`}
            onChange={() => onToggleSelect?.(p.id)}
          />
        </label>
      )}
      {/*
        カード上の削除導線。バッジメニューの「ゴミ箱へ移動」と同じ onDelete を呼ぶ
        （確認ダイアログ→moveToTrash の実体は HomeDashboard 側に 1 本だけ）。
        カード自身が draggable（列間 D&D）なので、アイコンでは draggable={false} に加えて
        pointerdown で suppressDragRef を立て、カード側の onDragStart でドラッグを断つ
        （dragstart はアイコンでは発火しないため、アイコン側のハンドラでは止められない）。
        stopPropagation はカードの onPointerDown（＝抑止解除）へ届かせないために必要。
        click もカードの onClick（プロジェクトを開く）へ伝播させない。
      */}
      {/* 選択モード中は 1 件用の削除アイコンを出さない（一括バーと二重の削除導線にしない）。 */}
      {!selectMode && (
      <button
        type="button"
        className="home-card-delete"
        title="ゴミ箱へ移動"
        aria-label="ゴミ箱へ移動"
        draggable={false}
        onPointerDown={(e) => {
          suppressDragRef.current = true;
          e.stopPropagation();
        }}
        onPointerUp={() => {
          suppressDragRef.current = false;
        }}
        onPointerCancel={() => {
          suppressDragRef.current = false;
        }}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(p.id, p.name);
        }}
      >
        <TrashIcon size={14} />
      </button>
      )}
      <div className={thumbClass}>
        {p.videoAssetId || p.videoFile !== null ? (
          <VideoThumb src={p.videoAssetId ? `/api/sequence/asset?${new URLSearchParams({ id:p.id, asset:p.videoAssetId })}` : `/api/video?id=${encodeURIComponent(p.id)}&file=${encodeURIComponent(p.videoFile!)}`} />
        ) : p.imageAssetId ? (
          <img className="ml-thumb-video-el" src={`/api/sequence/asset?${new URLSearchParams({ id: p.id, asset: p.imageAssetId })}`} alt="" loading="lazy" draggable={false} />
        ) : p.audioOnly ? (
          <div className="home-card-thumb-audio" role="img" aria-label={`音声の作品（${p.durationLabel}）`}>
            <Icon name="music" size={28} />
            <span>音声 {p.durationLabel}</span>
          </div>
        ) : (
          <div className="home-card-thumb-empty" />
        )}
      </div>
      <div className="home-card-body">
        <div className="dd home-card-badge-wrap" ref={dd.rootRef}>
          <button
            type="button"
            ref={dd.triggerRef}
            className={view.className}
            aria-haspopup="menu"
            aria-expanded={dd.open}
            onClick={(e) => {
              e.stopPropagation();
              dd.setOpen(!dd.open);
            }}
          >
            {view.spinner && <span className="status-spinner" aria-hidden="true" />}
            <span className="status-badge-label">{view.label}</span>
          </button>
          {dd.open && (
            <div className="dd-menu home-badge-menu" onClick={(e) => e.stopPropagation()} role="menu">
              {STAGE_OPTIONS.map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  className="dd-item"
                  role="menuitem"
                  onClick={() => {
                    dd.setOpen(false);
                    onSetStage(p.id, opt.stage);
                  }}
                >
                  {opt.label}
                </button>
              ))}
              <hr className="dd-sep" />
              {p.dir !== undefined && (
                <button
                  type="button"
                  className="dd-item"
                  role="menuitem"
                  onClick={() => {
                    dd.setOpen(false);
                    onRevealFailed(null);
                    void revealProjectRequest(p.id).catch((err: unknown) => {
                      onRevealFailed(err instanceof Error ? err.message : '保存先を開けませんでした');
                    });
                  }}
                >
                  保存先を開く
                </button>
              )}
              {/*
                コピー取り込み（＝リンク記録が無く、動画が置かれている）のときだけ出す。
                実際に同じ実体が外付けにあるかはサーバに探させる — 一覧を出すたびに
                全プロジェクト分のドライブ走査を走らせると、ホームが開かなくなる。
              */}
              {p.videoFile !== null && p.videoLink === undefined && (
                <button
                  type="button"
                  className="dd-item"
                  role="menuitem"
                  disabled={convertBusy}
                  onClick={() => {
                    dd.setOpen(false);
                    onConvertLink(p.id, p.name);
                  }}
                >
                  {convertBusy
                    ? // 探索はサーバ側で同期に走る（この間 API 全体が返らない）。黙って
                      // 固まったように見せず、待つ理由を先に伝える（I-5）。
                      '探しています…（この間エディタは一時的に反応しません）'
                    : // 押した時点では「回収できるか」は分からない（探すのはこの後）。
                      // 「回収」と言い切ると、見つからなかったときに失敗に見える（M-2）。
                      `リンク化して ${p.sizeLabel} を回収できるか調べる`}
                </button>
              )}
              <button
                type="button"
                className="dd-item dd-item-danger"
                role="menuitem"
                onClick={() => {
                  dd.setOpen(false);
                  onDelete(p.id, p.name);
                }}
              >
                ゴミ箱へ移動
              </button>
            </div>
          )}
          {p.stageManual === true && (
            <span
              className="home-card-manual"
              title="手動で設定されたステータスです。バッジメニューの「自動判定に戻す」で解除できます。"
            >
              手動
            </span>
          )}
        </div>
        <div className="home-card-name">{p.name}</div>
        {agentStatus && <div className="home-card-agent" data-testid="home-card-agent">
          <div><span>AI作業</span><strong className={agentView ? `tone-${agentView.operationTone}` : 'tone-idle'}>
            {agentStatus === 'error' || boardItemMissing ? '確認できません' : agentStatus === 'loading' ? '確認中…' : agentView?.operationLabel ?? 'まだありません'}
          </strong>{agentStatus === 'ready' && agentView?.operationDetail && <small>{agentView.operationDetail}</small>}</div>
          <div><span>人の確認</span><strong className={agentView ? `tone-${agentView.humanReviewTone}` : 'tone-idle'}>
            {agentStatus === 'error' || boardItemMissing ? '確認できません' : agentStatus === 'loading' ? '確認中…' : agentView?.humanReviewLabel ?? '対象なし'}
          </strong>{agentStatus === 'ready' && agentView?.needsHumanReview &&
            <a className="home-card-review-link" href={editorProjectReviewHref(p.id)} target="_blank" rel="noopener"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === ' ') { event.preventDefault(); event.currentTarget.click(); }
              }}>変更を確認</a>}</div>
          <div><span>編集画面</span><strong>{agentStatus === 'ready' && !boardItemMissing ? agentView?.editorLabel ?? '編集画面は未接続'
            : agentStatus === 'error' ? '確認できません' : '確認中…'}</strong></div>
          <a className="home-card-open-tab" href={editorProjectHref(p.id)} target="_blank" rel="noopener"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === ' ') { event.preventDefault(); event.currentTarget.click(); }
            }}>別タブで開く</a>
        </div>}
        {steps !== undefined && (
          <div className="home-card-steps" aria-label="工程の進み具合">
            {STEP_ORDER.map((key) => {
              const label = STEP_LABEL[key];
              const done = stepDone(steps, key);
              const invalid = key === 'telop' && steps.telop === 'invalid';
              return (
                <span
                  key={key}
                  className={'home-step' + (done ? ' done' : '') + (invalid ? ' invalid' : '')}
                  data-step={key}
                  data-done={String(done)}
                  // status-ia-10: 済／未／判定不能が色だけの区別になっていた。
                  // data-done は判定不能も "false" に潰すので互換のため残し、
                  // 3 値は data-state で出す（AI エージェントも状態を取り違えない）。
                  data-state={invalid ? 'unknown' : done ? 'done' : 'todo'}
                  title={label + (done ? '：済み' : invalid ? '：判定不能' : '：未')}
                >
                  <span className="home-step-dot" aria-hidden="true" />
                  <span className="home-step-label">{label}</span>
                </span>
              );
            })}
          </div>
        )}
        {p.dir !== undefined && (
          <div className="home-card-path" data-testid="home-card-path" title={p.dir}>
            保存先: {p.dir}
          </div>
        )}
        {p.videoLink !== undefined && (
          <div
            className={'home-card-link' + (p.videoLink.state === 'ok' ? '' : ' warn')}
            data-testid="home-card-link"
            title={p.videoLink.target}
          >
            動画の実体: {p.videoLink.target}
            {p.videoLink.state === 'broken' && '（未接続）'}
            {p.videoLink.state === 'mismatch' && '（別の動画に変わっています）'}
          </div>
        )}
        <div className="home-card-meta">
          {p.lastEditedAt !== undefined && <span>{formatRelativeTime(p.lastEditedAt, now)}</span>}
          {p.lastEditedAt !== undefined && <span className="sep">·</span>}
          <span>{p.durationLabel}</span>
          <span className="sep">·</span>
          <span>{p.orientation === 'h' ? '横' : p.orientation === 'sq' ? '正方形' : '縦'}</span>
        </div>
      </div>
    </div>
  );
}

export function editorProjectHref(projectId: string, href = window.location.href): string {
  const url = new URL(href); url.searchParams.set('project', projectId); url.hash = '';
  return `${url.pathname}${url.search}`;
}

/** 案件を別タブで開き、既存の「AIの作業」画面へ直接進むURL。 */
export function editorProjectReviewHref(projectId: string, href = window.location.href): string {
  const url = new URL(editorProjectHref(projectId, href), href);
  url.searchParams.set('agentActivity', 'review');
  return `${url.pathname}${url.search}`;
}

/** Homeが表示されている間だけboard pollを生かし、既存の表示本体は単体テスト可能に保つ。 */
export function HomeDashboardWithAgentBoard(props: HomeDashboardProps) {
  const agentBoard = useEditorProjectBoard(true);
  return <HomeDashboard {...props} agentBoard={agentBoard} />;
}
