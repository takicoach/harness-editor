import { useRef, useState } from 'react';
import type { ProjectSummary } from '../../shared/types';
import { defaultProjectName } from '../createProjectApi';
import type { ProjectStage } from '../../server/projectStatus';
import { VideoThumb } from './VideoThumb';
import { MediaPicker } from './MediaPicker';
import { useDropdown } from '../useDropdown';
import { useLiveNow } from '../useLiveNow';
import { resolveStatusView, formatRelativeTime } from './projectStatusView';
import { groupProjectsByStatus } from './homeKanban';
import { loadHomeView, saveHomeView, type HomeView } from './homeViewPref';
import { largeUploadNotice } from '../../shared/uploadNotice';

interface HomeDashboardProps {
  projects: ProjectSummary[];
  error: string | null;
  /** カードクリックでプロジェクトを開く。 */
  onPick: (id: string) => void;
  /** バッジメニューで手動 stage を設定（null=自動判定に戻す）。App が楽観更新・巻き戻し・トーストを担う。 */
  onSetStage: (id: string, stage: ProjectStage) => void;
  /** 「動画を作成する」。動画（コピー or 外部リンク）と名前を受け取り作成〜エディタで開くまで担う。 */
  onCreate: (name: string, source: CreateSource) => Promise<void>;
  /** 相対時刻の基準（テスト注入用）。 */
  now?: number;
}

/** バッジメニューの選択肢。 */
const STAGE_OPTIONS: { stage: ProjectStage; label: string }[] = [
  { stage: 'review', label: 'レビュー待ちにする' },
  { stage: 'published', label: '公開済にする' },
  { stage: null, label: '自動判定に戻す' },
];

/**
 * プロジェクト未選択時のホーム。カードグリッドで各プロジェクトの
 * サムネ・ステータス・最終編集日時・尺を一覧する。
 */
export function HomeDashboard({ projects, error, onPick, onSetStage, onCreate, now }: HomeDashboardProps) {
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

  // 新規作成: 選んだ動画（null = モーダル非表示）。コピー取り込みと外部リンクの2経路。
  const [createSource, setCreateSource] = useState<CreateSource | null>(null);
  // 外付け等から選ぶファイラを開いているか。
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const createUi = (
    <>
      <button type="button" className="home-create-btn" onClick={() => fileInputRef.current?.click()}>
        ＋ 動画を作成する
      </button>
      <button
        type="button"
        className="home-create-link-btn"
        title="外付けドライブなどの動画を、コピーせずリンクで取り込みます（内蔵ストレージを消費しません）"
        onClick={() => setPickerOpen(true)}
      >
        フォルダから選ぶ
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v"
        style={{ display: 'none' }}
        data-testid="home-create-file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f !== undefined) setCreateSource({ kind: 'upload', file: f });
          e.target.value = ''; // 同じファイルを選び直しても change が発火するように
        }}
      />
      {pickerOpen && (
        <MediaPicker
          title="動画を選ぶ（リンクで取り込み）"
          note="選んだ動画はコピーせずリンクで繋ぎます。取り込み後もそのドライブを接続したままにしてください。"
          onCancel={() => setPickerOpen(false)}
          onPick={(f) => {
            setPickerOpen(false);
            setCreateSource({ kind: 'link', name: f.name, path: f.path, sizeBytes: f.sizeBytes });
          }}
        />
      )}
      {createSource !== null && (
        <CreateProjectModal
          source={createSource}
          onCancel={() => setCreateSource(null)}
          onCreate={onCreate}
        />
      )}
    </>
  );

  if (error !== null) {
    return (
      <div className="home">
        <div className="sme-center">
          <p className="sme-error">プロジェクト一覧を取得できませんでした</p>
          <p className="hint">{error}</p>
        </div>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="home">
        <div className="sme-center">
          <p>まだプロジェクトがありません</p>
          <p className="hint">動画を選んで最初のプロジェクトを作りましょう</p>
          {createUi}
        </div>
      </div>
    );
  }

  return (
    <div className="home">
      <div className="home-head">
        <h1>プロジェクト</h1>
        <span className="home-count">{projects.length} 件</span>
        {createUi}
        <div className="home-view-switch" role="group" aria-label="表示切替">
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
      </div>
      {view === 'panel' ? (
        <div className="home-grid">
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} now={effectiveNow} onPick={onPick} onSetStage={onSetStage} />
          ))}
        </div>
      ) : (
        <div className="home-kanban">
          {groupProjectsByStatus(projects).map((col) => (
            <div
              key={col.status}
              className={'home-col' + (col.projects.length === 0 ? ' empty' : '')}
              data-status={col.status}
            >
              <div className="home-col-head">
                <span className="home-col-label">{col.label}</span>
                <span className="home-col-count">{col.projects.length}</span>
              </div>
              <div className="home-col-cards">
                {col.projects.map((p) => (
                  <ProjectCard key={p.id} p={p} now={effectiveNow} onPick={onPick} onSetStage={onSetStage} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 新規作成の素材。コピー取り込み（アップロード）と、外部実体へのリンクの2種類。 */
export type CreateSource =
  | { kind: 'upload'; file: File }
  | { kind: 'link'; name: string; path: string; sizeBytes: number };

interface CreateProjectModalProps {
  source: CreateSource;
  onCancel: () => void;
  onCreate: (name: string, source: CreateSource) => Promise<void>;
}

/**
 * 新規プロジェクトの名前確認モーダル。作成成功時は親がエディタへ遷移して
 * ホームごとアンマウントされるため、成功側のクローズ処理は持たない。
 */
function CreateProjectModal({ source, onCancel, onCreate }: CreateProjectModalProps) {
  const fileName = source.kind === 'upload' ? source.file.name : source.name;
  const [name, setName] = useState(() => defaultProjectName(fileName));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // リンク取り込みは実体を運ばないので、大容量の待ち時間案内は出さない。
  const sizeNotice = source.kind === 'upload' ? largeUploadNotice(source.file.size) : null;

  const submit = (): void => {
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('プロジェクト名を入力してください');
      return;
    }
    setBusy(true);
    setError(null);
    onCreate(trimmed, source).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'プロジェクトの作成に失敗しました');
      setBusy(false);
    });
  };

  return (
    <div className="export-overlay" onClick={busy ? undefined : onCancel}>
      <div className="export-dialog home-create-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="export-head">動画を作成する</div>
        <div className="home-create-file-note">動画: {fileName}</div>
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
        {error !== null && <p className="sme-error home-create-error">{error}</p>}
        {busy && (
          <div className="home-create-progress">
            <span className="status-spinner" aria-hidden="true" />
            {source.kind === 'link'
              ? '動画を確認して準備しています…'
              : '動画を取り込んで準備しています…（大きい動画は数十秒かかることがあります）'}
          </div>
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

interface ProjectCardProps {
  p: ProjectSummary;
  now: number;
  onPick: (id: string) => void;
  onSetStage: (id: string, stage: ProjectStage) => void;
}

function ProjectCard({ p, now, onPick, onSetStage }: ProjectCardProps) {
  const view = resolveStatusView(p, now);
  const dd = useDropdown();

  const thumbClass =
    'home-card-thumb' + (p.orientation === 'h' ? ' h' : p.orientation === 'sq' ? ' sq' : ' v');

  return (
    <div
      className={'home-card' + (view.dimmed ? ' dimmed' : '')}
      role="button"
      tabIndex={0}
      onClick={() => onPick(p.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick(p.id);
        }
      }}
      title={p.name}
    >
      <div className={thumbClass}>
        {p.videoFile !== null ? (
          <VideoThumb src={`/api/video?id=${encodeURIComponent(p.id)}&file=${encodeURIComponent(p.videoFile)}`} />
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
            </div>
          )}
        </div>
        <div className="home-card-name">{p.name}</div>
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
